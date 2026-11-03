const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let DEBUG_PORT = 0;
const readDebugPort = async (profile) => {
  for (let i = 0; i < 120; i++) {
    try {
      const line = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0].trim();
      const port = Number(line);
      if (port > 0) return port;
    } catch (e) {}
    await sleep(250);
  }
  return 0;
};
const CHROME = 'C:/Users/Admin/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let seq = 0;
    ws.onopen = () => resolve(api);
    ws.onerror = () => reject(new Error('ws failure'));
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message));
        else entry.resolve(msg.result);
      }
    };
    const api = {
      send(method, params, sessionId) {
        const id = ++seq;
        const payload = { id, method, params: params || {} };
        if (sessionId) payload.sessionId = sessionId;
        ws.send(JSON.stringify(payload));
        return new Promise((res, rej) => {
          pending.set(id, { resolve: res, reject: rej });
          setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000);
        });
      },
      close() { try { ws.close(); } catch (e) {} }
    };
  });
}

const httpJson = async (url) => (await fetch(url)).json();

function serve() {
  return new Promise((resolve) => {
    const file = path.join(__dirname, 'list-column-fixture.html');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const { server, port } = await serve();
  const pageUrl = 'http://127.0.0.1:' + port + '/list-column-fixture.html';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-listcol-'));
  const chrome = spawn(CHROME, [
    '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=900,900', '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    '--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    pageUrl
  ], { stdio: 'ignore' });

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  DEBUG_PORT = await readDebugPort(profile);
  if (!DEBUG_PORT) throw new Error('debug port not ready');
  let browser = null;
  let sw = null;
  try {
    let version = null;
    for (let i = 0; i < 80; i++) {
      try { version = await httpJson('http://127.0.0.1:' + DEBUG_PORT + '/json/version'); break; } catch (e) { await sleep(250); }
    }
    if (!version) throw new Error('debug port not ready');

    for (let i = 0; i < 80 && !sw; i++) {
      const list = await httpJson('http://127.0.0.1:' + DEBUG_PORT + '/json/list');
      for (const target of list.filter((t) => t.type === 'service_worker' && /^chrome-extension:/.test(t.url))) {
        const api = await connect(target.webSocketDebuggerUrl);
        await api.send('Runtime.enable');
        const probe = await api.send('Runtime.evaluate', { expression: 'chrome.runtime.getManifest().name', returnByValue: true });
        if (probe.result && probe.result.value === 'XPath Picker') { sw = api; break; }
        api.close();
      }
      if (!sw) await sleep(250);
    }
    if (!sw) throw new Error('extension service worker not found');

    const swEval = async (expression) => {
      const result = await sw.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const toTab = (message) => swEval(
      `(async () => {
        const tabs = await chrome.tabs.query({ url: ${JSON.stringify(pageUrl)} });
        if (!tabs.length) return { error: 'tab not found' };
        try { return await chrome.tabs.sendMessage(tabs[0].id, ${JSON.stringify(message)}); }
        catch (e) { return { error: String(e && e.message || e) }; }
      })()`
    );

    browser = await connect(version.webSocketDebuggerUrl);
    let pageTarget = null;
    for (let i = 0; i < 60 && !pageTarget; i++) {
      const list = await httpJson('http://127.0.0.1:' + DEBUG_PORT + '/json/list');
      pageTarget = list.find((t) => t.type === 'page' && t.url.indexOf('list-column-fixture') >= 0);
      if (!pageTarget) await sleep(250);
    }
    if (!pageTarget) throw new Error('fixture page not found');
    const attached = await browser.send('Target.attachToTarget', { targetId: pageTarget.id, flatten: true });
    const session = attached.sessionId;
    const send = (method, params) => browser.send(method, params, session);
    const pageEval = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const pointCenter = (selector) => pageEval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    const clickAt = async (point) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(320);
    };

    for (let i = 0; i < 60; i++) {
      const ready = await pageEval("document.readyState === 'complete' && !!document.querySelector('#orders tbody tr')");
      if (ready) break;
      await sleep(250);
    }
    await sleep(700);

    const items = async () => {
      const state = await toTab({ type: 'xp:getState' });
      return (state && state.items) || [];
    };
    const lastItem = async () => {
      const list = await items();
      return list[list.length - 1];
    };
    const pick = async (selector) => {
      const point = await pointCenter(selector);
      if (!point) throw new Error('selector not found: ' + selector);
      await toTab({ type: 'xp:setPick', on: true });
      await clickAt(point);
      await toTab({ type: 'xp:setPick', on: false });
      return lastItem();
    };
    const matches = (xpath) => pageEval(`(() => {
      const r = document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const out = [];
      for (let i = 0; i < r.snapshotLength; i++) {
        const n = r.snapshotItem(i);
        out.push({
          tag: n.tagName,
          text: (n.textContent || '').trim().slice(0, 20),
          parent: n.parentElement ? n.parentElement.tagName : ''
        });
      }
      return out;
    })()`);

    // 1) 行内链接：应生成「列」列表（tr/td[1]/a），而不是某一行内的 tr[N]/td
    const orderLink = await pick('#orders tbody tr:nth-child(3) td:nth-child(1) a');
    const orderId = orderLink && orderLink.id;
    const orderList = await toTab({ type: 'xp:setListMode', id: orderId, on: true });
    check('行内链接可切列表', orderList && orderList.ok === true, orderList);
    const orderItems = await items();
    const orderEntry = orderItems.find((entry) => entry.id === orderId);
    check('链接列表是列路径', !!orderEntry && /\/tr\/td\[\d+\]\/a$/.test(orderEntry.xpath), orderEntry && orderEntry.xpath);
    check('链接列表不含行下标', !!orderEntry && !/\/tr\[\d+\]/.test(orderEntry.xpath), orderEntry && orderEntry.xpath);
    check('链接列表匹配 6 行', !!orderEntry && orderEntry.matchCount === 6, orderEntry && orderEntry.matchCount);
    check('链接列表不落绝对路径', !!orderEntry && !/^\/html\//.test(orderEntry.xpath), orderEntry && orderEntry.xpath);
    const orderNodes = orderEntry ? await matches(orderEntry.xpath) : [];
    check(
      '链接列表全部是订单链接',
      orderNodes.length === 6 && orderNodes.every((node) => node.tag === 'A' && /^A00\d$/.test(node.text)),
      orderNodes
    );

    // 2) 单元格本身：应生成同一列的 td[k]，而不是 tr[N]/td
    const statusCell = await pick('#orders tbody tr:nth-child(3) td:nth-child(3)');
    const statusId = statusCell && statusCell.id;
    const statusList = await toTab({ type: 'xp:setListMode', id: statusId, on: true });
    check('单元格可切列表', statusList && statusList.ok === true, statusList);
    const statusEntry = (await items()).find((entry) => entry.id === statusId);
    check('单元格列表按列序号定位', !!statusEntry && /\/tr\/td\[\d+\]$/.test(statusEntry.xpath), statusEntry && statusEntry.xpath);
    check('单元格列表不含行下标', !!statusEntry && !/\/tr\[\d+\]/.test(statusEntry.xpath), statusEntry && statusEntry.xpath);
    check('单元格列表匹配 6 行', !!statusEntry && statusEntry.matchCount === 6, statusEntry && statusEntry.matchCount);

    // 3) 共享属性但内容不同：列表不能靠单个属性值圈定整组
    const navLink = await pick('#side-nav .order-link');
    const navId = navLink && navLink.id;
    const navList = await toTab({ type: 'xp:setListMode', id: navId, on: true });
    check('导航链接可切列表', navList && navList.ok === true, navList);
    const navEntry = (await items()).find((entry) => entry.id === navId);
    check('导航列表不用共享的 data-btm 取值', !!navEntry && navEntry.xpath.indexOf('data-btm') < 0, navEntry && navEntry.xpath);
    check('导航列表按行结构定位', !!navEntry && /\/li\/a$/.test(navEntry.xpath), navEntry && navEntry.xpath);
    check('导航列表匹配 5 个链接', !!navEntry && navEntry.matchCount === 5, navEntry && navEntry.matchCount);

    // 4) 分散在不同父级链的同属性元素：兜底必须拒绝伪同类
    const scatter = await pick('#scatter .scatter-one');
    const scatterId = scatter && scatter.id;
    const scatterList = await toTab({ type: 'xp:setListMode', id: scatterId, on: true });
    check('伪同类不被当成列表', scatterList && scatterList.ok === false, scatterList);
    check('伪同类给出可读提示', !!(scatterList && typeof scatterList.error === 'string' && scatterList.error.indexOf('没有找到可复用的列表结构') >= 0), scatterList && scatterList.error);
    const scatterEntry = (await items()).find((entry) => entry.id === scatterId);
    check('伪同类条目保持唯一', !!scatterEntry && !scatterEntry.listMode && scatterEntry.matchCount === 1, scatterEntry && { listMode: scatterEntry.listMode, count: scatterEntry.matchCount });

    const all = await items();
    check('没有任何条目退回绝对路径', all.every((entry) => !/^\/html\//.test(entry.xpath || '')), all.map((entry) => entry.xpath));
  } catch (e) {
    check('no exception', false, String((e && e.stack) || e));
  } finally {
    const failed = checks.filter((c) => !c.ok);
    console.log(JSON.stringify({ checks, failed: failed.length }, null, 2));
    try { if (browser) browser.close(); } catch (e) {}
    try { if (sw) sw.close(); } catch (e) {}
    try { chrome.kill(); } catch (e) {}
    try { server.close(); } catch (e) {}
    await sleep(600);
    for (let i = 0; i < 10; i++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch (e) { await sleep(400); }
    }
    process.exit(failed.length ? 1 : 0);
  }
}

main();
