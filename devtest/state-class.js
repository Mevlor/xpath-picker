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
    const file = path.join(__dirname, 'state-class-fixture.html');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const { server, port } = await serve();
  const pageUrl = 'http://127.0.0.1:' + port + '/state-class-fixture.html';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-stateclass-'));
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
      pageTarget = list.find((t) => t.type === 'page' && t.url.indexOf('state-class-fixture') >= 0);
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
    const moveTo = async (point) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
      await sleep(120);
    };
    const clickAt = async (point) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(320);
    };
    const hitsTarget = (xpath, selector) => pageEval(`(() => {
      try {
        const node = document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        return !!node && node.matches(${JSON.stringify(selector)});
      } catch (e) { return false; }
    })()`);
    const item = async (index) => {
      const state = await toTab({ type: 'xp:getState' });
      return state && state.items && state.items[index];
    };

    for (let i = 0; i < 60; i++) {
      const ready = await pageEval("document.readyState === 'complete' && !!document.querySelector('#row-1 .cell-a')");
      if (ready) break;
      await sleep(250);
    }
    await sleep(700);

    // 1) 悬停中的单元格：状态类不能进 XPath
    await toTab({ type: 'xp:setPick', on: true });
    const cellPoint = await pointCenter('#row-1 .cell-a');
    await moveTo(cellPoint);
    const hovered = await pageEval("document.querySelector('#row-1 .cell-a').classList.contains('auxo-table-cell-row-hover')");
    check('拾取前单元格已带状态类', hovered === true, hovered);
    await clickAt(cellPoint);
    await toTab({ type: 'xp:setPick', on: false });
    await sleep(200);

    const cellItem = await item(0);
    const cellXpath = cellItem && cellItem.xpath;
    check('拾取单元格成功', !!cellItem && !!cellXpath, cellXpath);
    check('XPath 不含 hover 状态类', !!cellXpath && !/hover/i.test(cellXpath), cellXpath);
    check('XPath 命中目标单元格', !!cellXpath && (await hitsTarget(cellXpath, '#row-1 .cell-a')), cellXpath);

    await moveTo({ x: 2, y: 2 });
    await sleep(500);
    const afterOut = await item(0);
    check('移出悬停后 XPath 不变', afterOut && afterOut.xpath === cellXpath, afterOut && afterOut.xpath);
    check('移出悬停后仍然有效', afterOut && afterOut.stale === false && afterOut.matchCount === 1, afterOut && { stale: afterOut.stale, count: afterOut.matchCount });
    check('无锚点条目 anchorBroken 为 false', afterOut && afterOut.anchorBroken === false, afterOut && afterOut.anchorBroken);

    // 2) 状态类不能当锚点身份：active 在标签间切换后锚点仍有效
    await toTab({ type: 'xp:setPick', on: true });
    await clickAt(await pointCenter('#target-box'));
    await toTab({ type: 'xp:setPick', on: false });
    const targetItem = await item(1);
    check('拾取目标框', !!targetItem && !!targetItem.xpath, targetItem && targetItem.xpath);

    await toTab({ type: 'xp:pickAnchor', id: targetItem.id });
    await clickAt(await pointCenter('.tab-item.active'));
    const context = await toTab({ type: 'xp:getContext', id: targetItem.id, fullHtml: false });
    const anchor = context && context.anchor;
    check('锚点已绑定', !!anchor && anchor.matchCount === 1, anchor && anchor.matchCount);
    check('锚点表达式不使用状态类 active', !!anchor && !/active/i.test(anchor.expr), anchor && anchor.expr);
    check('锚点标记时刻未失效', !!anchor && anchor.broken === false, anchor && anchor.broken);
    const anchoredXpath = targetItem.xpath;

    await pageEval("window.__setActive('.other-item')");
    await sleep(500);
    const switched = await item(1);
    check('active 切换后锚点仍有效', switched && switched.anchorBroken === false, switched && switched.anchorBroken);
    check('active 切换后条目未失效', switched && switched.stale === false, switched && switched.stale);
    check('active 切换后 XPath 不变', switched && switched.xpath === anchoredXpath, switched && switched.xpath);
    check('active 切换后仍命中目标', !!switched && (await hitsTarget(switched.xpath, '#target-box')), switched && switched.xpath);
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
