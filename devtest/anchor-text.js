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
    const file = path.join(__dirname, 'anchor-text-fixture.html');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const { server, port } = await serve();
  const pageUrl = 'http://127.0.0.1:' + port + '/anchor-text-fixture.html';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-text-'));
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
      pageTarget = list.find((t) => t.type === 'page' && t.url.indexOf('anchor-text-fixture') >= 0);
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

    for (let i = 0; i < 60; i++) {
      const ready = await pageEval("document.readyState === 'complete' && !!document.querySelector('.live .auxo-select-selection-item')");
      if (ready) break;
      await sleep(250);
    }
    await sleep(700);

    const pointAt = (expr) => pageEval(`(() => {
      const el = ${expr};
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    const click = async (point) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(300);
    };
    const item = async (index) => {
      const state = await toTab({ type: 'xp:getState' });
      return state && state.items && state.items[index];
    };

    await toTab({ type: 'xp:setPick', on: true });

    const spanPoint = await pointAt("document.querySelectorAll('.live .auxo-select-selection-item')[0]");
    await click(spanPoint);
    const picked = await item(0);
    check('拾取可见值节点', picked && picked.tag === 'span', picked && picked.tag);

    await toTab({ type: 'xp:pickAnchor', id: picked.id });
    const labelPoint = await pointAt("document.querySelectorAll('.styles-module_label__i3IvP')[1]");
    await click(labelPoint);
    const anchored = await item(0);
    check('锚点已标记', anchored && anchored.anchorMarked === true, anchored && anchored.anchorLabel);
    check('锚点使用文本定位', anchored && anchored.xpath.indexOf("normalize-space(.)='订单状态'") >= 0, anchored && anchored.xpath);
    check('同名标签仍用文本下标而不是绝对路径', anchored && anchored.xpath.indexOf('(//div[') === 0 && anchored.xpath.indexOf('[2]') >= 0, anchored && anchored.xpath);
    check('锚点不再退化成 /html/body 绝对路径', anchored && anchored.xpath.indexOf('/html/body') !== 0, anchored && anchored.xpath);
    check('值节点仍用稳定 class 收尾', anchored && anchored.xpath.indexOf('auxo-select-selection-item') >= 0, anchored && anchored.xpath);
    check('锚点路径唯一命中', anchored && anchored.matchCount === 1, anchored && anchored.matchCount);
    check('文本锚点被标记为依赖下标', anchored && anchored.anchorIndexed === true, anchored && anchored.anchorExpr);
    check('面板展示锚点表达式', anchored && /normalize-space\(\.\)='订单状态'/.test(anchored.anchorExpr || ''), anchored && anchored.anchorExpr);
    check('文本锚点路径确实以锚点开头', anchored && anchored.anchorApplied === true, anchored && anchored.anchorApplied);

    await pageEval("window.__setStatus('已发货')");
    await sleep(150);
    const afterChange = await item(0);
    check('改值后锚点路径不变', afterChange && afterChange.xpath === anchored.xpath, afterChange && afterChange.xpath);
    check('改值后仍唯一命中', afterChange && afterChange.matchCount === 1, afterChange && afterChange.matchCount);

    const spanPoint2 = await pointAt("document.querySelectorAll('.live .auxo-select-selection-item')[1]");
    await click(spanPoint2);
    const picked2 = await item(1);
    check('拾取第二个值节点', picked2 && picked2.tag === 'span', picked2 && picked2.tag);

    await toTab({ type: 'xp:pickAnchor', id: picked2.id });
    const labelPoint2 = await pointAt("document.querySelectorAll('.styles-module_label__i3IvP')[2]");
    await click(labelPoint2);
    const anchored2 = await item(1);
    check('带冒号的标签文本进入锚点', anchored2 && anchored2.xpath.indexOf("normalize-space(.)='订单类型：'") >= 0, anchored2 && anchored2.xpath);
    check('带冒号标签也命中唯一', anchored2 && anchored2.matchCount === 1, anchored2 && anchored2.matchCount);
    check('带冒号标签路径无绝对前缀', anchored2 && anchored2.xpath.indexOf('/html/body') !== 0, anchored2 && anchored2.xpath);

    await toTab({ type: 'xp:setPick', on: false });
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