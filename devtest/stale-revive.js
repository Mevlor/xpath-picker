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
    const file = path.join(__dirname, 'stale-fixture.html');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const { server, port } = await serve();
  const pageUrl = 'http://127.0.0.1:' + port + '/stale-fixture.html';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-stale-'));
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
      pageTarget = list.find((t) => t.type === 'page' && t.url.indexOf('stale-fixture') >= 0);
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
      const ready = await pageEval("document.readyState === 'complete' && !!document.getElementById('banner-card')");
      if (ready) break;
      await sleep(250);
    }
    await sleep(700);

    await toTab({ type: 'xp:setPick', on: true });
    const point = await pageEval(`(() => {
      const r = document.getElementById('banner-card').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(300);
    await toTab({ type: 'xp:setPick', on: false });

    const picked = await toTab({ type: 'xp:getState' });
    const pickedItem = picked && picked.items && picked.items[0];
    const savedXPath = pickedItem && pickedItem.xpath;
    const savedName = pickedItem && pickedItem.name;
    check('拾取成功且生成 XPath', pickedItem && savedXPath === "//*[@id='banner-card']", savedXPath);
    check('拾取时未失效', pickedItem && pickedItem.stale === false, pickedItem && pickedItem.stale);

    await pageEval('window.__card = document.getElementById("banner-card"); window.__card.remove();');
    await sleep(900);
    const removed = await toTab({ type: 'xp:getState' });
    const removedItem = removed && removed.items && removed.items[0];
    check('移除后标记失效', removedItem && removedItem.stale === true, removedItem && removedItem.stale);
    check('失效后保留 XPath', removedItem && removedItem.xpath === savedXPath, removedItem && removedItem.xpath);
    check('失效后保留变量名', removedItem && removedItem.name === savedName && !!savedName, removedItem && removedItem.name);
    check('失效后保留元素描述', removedItem && removedItem.label === pickedItem.label && removedItem.tag === pickedItem.tag, removedItem && { label: removedItem.label, tag: removedItem.tag });
    check('失效后保留属性与尺寸', removedItem && JSON.stringify(removedItem.facts) === JSON.stringify(pickedItem.facts) && JSON.stringify(removedItem.size) === JSON.stringify(pickedItem.size), removedItem && { facts: removedItem.facts, size: removedItem.size });
    check('失效后保留祖先路径', removedItem && removedItem.path === pickedItem.path, removedItem && removedItem.path);

    await pageEval('document.body.appendChild(window.__card);');
    await sleep(900);
    const remounted = await toTab({ type: 'xp:getState' });
    const remountedItem = remounted && remounted.items && remounted.items[0];
    check('原节点重新挂载后恢复有效', remountedItem && remountedItem.stale === false, remountedItem && remountedItem.stale);
    check('恢复后 XPath 不变', remountedItem && remountedItem.xpath === savedXPath, remountedItem && remountedItem.xpath);

    await pageEval(`(() => {
      document.getElementById('banner-card').remove();
      const fresh = document.createElement('div');
      fresh.id = 'banner-card';
      fresh.textContent = '限时活动';
      document.body.appendChild(fresh);
    })()`);
    await sleep(900);
    const rebuilt = await toTab({ type: 'xp:getState' });
    const rebuiltItem = rebuilt && rebuilt.items && rebuilt.items[0];
    check('新节点重建后重新绑定', rebuiltItem && rebuiltItem.stale === false, rebuiltItem && rebuiltItem.stale);
    check('重建后 XPath 仍匹配唯一元素', rebuiltItem && rebuiltItem.xpath === savedXPath && rebuiltItem.matchCount === 1, rebuiltItem && { xpath: rebuiltItem.xpath, count: rebuiltItem.matchCount });
    check('重建后名称保留', rebuiltItem && rebuiltItem.name === savedName, rebuiltItem && rebuiltItem.name);

    await pageEval('document.getElementById("banner-card").remove();');
    await sleep(900);
    const gone = await toTab({ type: 'xp:getState' });
    const goneItem = gone && gone.items && gone.items[0];
    check('元素再次移除时重新失效', goneItem && goneItem.stale === true, goneItem && goneItem.stale);
    check('再次失效仍保留 XPath', goneItem && goneItem.xpath === savedXPath, goneItem && goneItem.xpath);
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