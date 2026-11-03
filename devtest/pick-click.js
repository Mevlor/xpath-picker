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

function serveProbe() {
  return new Promise((resolve) => {
    const file = path.join(__dirname, 'freeze-probe.html');
    const server = http.createServer((req, res) => {
      if (!/freeze-probe\.html/.test(req.url)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const { server, port } = await serveProbe();
  const pageUrl = 'http://127.0.0.1:' + port + '/freeze-probe.html';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-pick-'));
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
      pageTarget = list.find((t) => t.type === 'page' && t.url.indexOf('freeze-probe') >= 0);
      if (!pageTarget) await sleep(250);
    }
    if (!pageTarget) throw new Error('probe page not found');
    const attached = await browser.send('Target.attachToTarget', { targetId: pageTarget.id, flatten: true });
    const session = attached.sessionId;
    const send = (method, params) => browser.send(method, params, session);
    const pageEval = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };

    for (let i = 0; i < 60; i++) {
      const ready = await pageEval("document.readyState === 'complete' && !!document.getElementById('v-interval')");
      if (ready) break;
      await sleep(250);
    }
    await sleep(700);

    await toTab({ type: 'xp:setFreeze', on: true });
    await toTab({ type: 'xp:setPick', on: true });
    await sleep(200);

    const box = await pageEval(`(() => {
      const r = document.getElementById('v-interval').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    const click = async () => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', buttons: 0 });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(250);
    };
    const pressF8 = async () => {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F8', code: 'F8', windowsVirtualKeyCode: 119, nativeVirtualKeyCode: 119 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F8', code: 'F8', windowsVirtualKeyCode: 119, nativeVirtualKeyCode: 119 });
      await sleep(250);
    };

    const before = await toTab({ type: 'xp:getState' });
    check('初始为空列表', before && before.items.length === 0, before && before.items.length);

    await click();
    const afterClick = await toTab({ type: 'xp:getState' });
    check('冻结 + 拾取时点击仍能加入列表', afterClick && afterClick.items.length === 1, afterClick && { items: afterClick.items.length, frozen: afterClick.frozen, picking: afterClick.picking });
    check('点击后仍在拾取且保持冻结', afterClick && afterClick.picking === true && afterClick.frozen === true, afterClick && { picking: afterClick.picking, frozen: afterClick.frozen });

    await pressF8();
    const afterF8 = await toTab({ type: 'xp:getState' });
    check('F8 不再加入列表', afterF8 && afterF8.items.length === 1, afterF8 && afterF8.items.length);

    await click();
    const afterClick2 = await toTab({ type: 'xp:getState' });
    check('连续点击继续累加', afterClick2 && afterClick2.items.length === 2, afterClick2 && afterClick2.items.length);
    check('新条目带可用 XPath', afterClick2 && afterClick2.items[1] && typeof afterClick2.items[1].xpath === 'string' && afterClick2.items[1].xpath.charAt(0) === '/', afterClick2 && afterClick2.items.map((i) => i.xpath));

    await toTab({ type: 'xp:setPick', on: false });
    await toTab({ type: 'xp:setFreeze', on: false });
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
