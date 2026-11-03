const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let DEBUG_PORT = 0;
// Windows 动态端口范围包含 9xxx，固定端口可能被用户浏览器占用，改为从 DevToolsActivePort 读取实际端口
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
    const file = path.join(__dirname, 'semantic-leaf-fixture.html');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const { server, port } = await serve();
  const pageUrl = 'http://127.0.0.1:' + port + '/semantic-leaf-fixture.html';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-semleaf-'));
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
      pageTarget = list.find((t) => t.type === 'page' && t.url.indexOf('semantic-leaf-fixture') >= 0);
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
      const ready = await pageEval("document.readyState === 'complete' && !!document.querySelector('#review-table .next-btn-helper')");
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

    // 1) 只有文本的按钮内 span：应该用文本定位，而不是 /html 绝对路径
    const review = await pick('#review-table .next-btn-helper');
    check('按钮内 span 不再落到绝对路径', !!review && !/^\/html\//.test(review.xpath), review && review.xpath);
    check('用按钮文本定位', !!review && /^\/\/span\[/.test(review.xpath) && review.xpath.indexOf("normalize-space(.)='评价回复'") >= 0, review && review.xpath);
    check('文本路径唯一命中', !!review && review.matchCount === 1, review && review.matchCount);
    check('按钮内 span 可以切换唯一/列表', !!review && review.canList === true, review && review.canList);

    // 2) 表格行内重复按钮：结构根应落在稳定容器（class 唯一），而不是 /html
    const refund = await pick('#refund-table tbody tr:nth-child(2) .auxo-btn-helper');
    check('行内重复按钮不作绝对路径', !!refund && !/^\/html\//.test(refund.xpath), refund && refund.xpath);
    check('行内重复按钮靠 class 根命中唯一元素', !!refund && refund.matchCount === 1, refund && { xpath: refund && refund.xpath, count: refund && refund.matchCount });
    check('重复行按钮用行序号 + class 叶子', !!refund && /auxo-btn-helper/.test(refund.xpath) && /tr\[2\]/.test(refund.xpath) && !/div\/div\/div\/div/.test(refund.xpath), refund && refund.xpath);
    check('行内重复按钮可切列表', !!refund && refund.canList === true, refund && refund.canList);

    const refundId = refund && refund.id;
    const toList = await toTab({ type: 'xp:setListMode', id: refundId, on: true });
    check('切列表成功', toList && toList.ok === true, toList);
    check('列表匹配 3 行', toList && toList.count === 3, toList && toList.count);
    const listed = (await items()).find((entry) => entry.id === refundId);
    check('切列表后不再标黄失效', listed && listed.stale === false && listed.matchCount === 3, listed && { stale: listed.stale, count: listed.matchCount, xpath: listed.xpath });
    const backUnique = await toTab({ type: 'xp:setListMode', id: refundId, on: false });
    check('切回唯一成功', backUnique && backUnique.ok === true && backUnique.count === 1, backUnique && { ok: backUnique.ok, count: backUnique.count });

    // 3) 同文本不同 class：文本重复时用 class + 文本收窄
    const ticket = await pick('#ticket-table .ticket-action');
    check('重复文本时用 class+文本定位', !!ticket && /ticket-action/.test(ticket.xpath) && ticket.xpath.indexOf("normalize-space(.)='处理'") >= 0, ticket && ticket.xpath);
    check('class+文本唯一命中', !!ticket && ticket.matchCount === 1, ticket && ticket.matchCount);

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
