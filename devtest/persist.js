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
    const server = http.createServer((req, res) => {
      const name = path.basename(String(req.url || '/').split('?')[0]);
      const file = path.join(__dirname, name === 'persist-other.html' ? name : 'persist-fixture.html');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const { server, port } = await serve();
  const pageUrl = 'http://127.0.0.1:' + port + '/persist-fixture.html';
  const otherUrl = 'http://127.0.0.1:' + port + '/persist-other.html';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-persist-'));
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
    const storedItems = () => swEval(
      `(async () => {
        const tabs = await chrome.tabs.query({ url: ${JSON.stringify(pageUrl)} });
        if (!tabs.length) return -1;
        const key = 'xpItems:' + tabs[0].id;
        const data = await chrome.storage.session.get(key);
        return data[key] && Array.isArray(data[key].items) ? data[key].items.length : 0;
      })()`
    );

    browser = await connect(version.webSocketDebuggerUrl);

    let pageTarget = null;
    for (let i = 0; i < 60 && !pageTarget; i++) {
      const list = await httpJson('http://127.0.0.1:' + DEBUG_PORT + '/json/list');
      pageTarget = list.find((t) => t.type === 'page' && t.url.indexOf('persist-fixture') >= 0);
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

    const waitDocument = async (stampMissing) => {
      for (let i = 0; i < 80; i++) {
        const state = await pageEval("({ ready: document.readyState, stamped: typeof window.__xpStamp !== 'undefined' })");
        if (state.ready === 'complete' && (!stampMissing || !state.stamped)) return true;
        await sleep(250);
      }
      return false;
    };
    const waitItems = async (count) => {
      let last = null;
      for (let i = 0; i < 80; i++) {
        last = await toTab({ type: 'xp:getState' });
        if (last && Array.isArray(last.items) && last.items.length === count) return last;
        await sleep(250);
      }
      return last && Array.isArray(last.items) ? last : null;
    };
    const pointCenter = (selector) => pageEval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    const pointCorner = (selector) => pageEval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + 5), y: Math.round(r.top + 5) };
    })()`);
    const click = async (point) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(300);
    };

    await waitDocument(false);
    await sleep(700);

    check('首屏没有历史条目', (await toTab({ type: 'xp:getState' })).items.length === 0);

    await toTab({ type: 'xp:setPick', on: true });
    await click(await pointCenter('#btn-one'));
    await click(await pointCenter('#link-two'));
    await toTab({ type: 'xp:setPick', on: false });

    const before = await waitItems(2);
    check('拾取两条条目', before && before.items.length === 2, before && before.items.length);
    const customId = before.items[0].id;
    const anchorId = before.items[1].id;

    await toTab({ type: 'xp:rename', id: customId, name: '导出按钮' });
    const setName = await toTab({ type: 'xp:setXPath', id: customId, xpath: "//*[@id='btn-one']" });
    check('写入自定义 XPath', setName && setName.ok === true, setName && (setName.error || setName.count));

    await toTab({ type: 'xp:pickAnchor', id: anchorId });
    await click(await pointCorner('#toolbar'));
    const anchored = await waitItems(2);
    const anchorItem = anchored && anchored.items.find((item) => item.id === anchorId);
    check('锚点已绑定', anchorItem && anchorItem.anchorMarked === true && !!anchorItem.anchorLabel, anchorItem && anchorItem.anchorLabel);

    const beforeIds = anchored.items.map((item) => item.id).join(',');
    const beforeNames = anchored.items.map((item) => item.name).join(',');
    const beforeXpaths = anchored.items.map((item) => item.xpath).join('\n');
    const autoXpath = anchored.items.find((item) => item.id === anchorId).xpath;

    await sleep(600);
    check('快照已写入 storage.session', (await storedItems()) === 2, await storedItems());

    await pageEval('window.__xpStamp = 1');
    await send('Page.reload', { ignoreCache: true });
    check('页面已重新加载', await waitDocument(true));
    const restored = await waitItems(2);
    check('刷新后条目数不变', restored && restored.items.length === 2, restored && restored.items.length);
    check('刷新后 id 与顺序不变', restored && restored.items.map((item) => item.id).join(',') === beforeIds);
    check('刷新后变量名保留', restored && restored.items.map((item) => item.name).join(',') === beforeNames, restored && restored.items.map((item) => item.name).join(','));
    check('刷新后自定义 XPath 保留', restored && restored.items.find((item) => item.id === customId).xpath === "//*[@id='btn-one']");
    check('刷新后自动 XPath 不变', restored && restored.items.find((item) => item.id === anchorId).xpath === autoXpath);
    const restoredAnchor = restored && restored.items.find((item) => item.id === anchorId);
    check('刷新后锚点仍绑定', restoredAnchor && restoredAnchor.anchorMarked === true && !!restoredAnchor.anchorLabel, restoredAnchor && restoredAnchor.anchorLabel);
    check('刷新后条目均未失效', restored && restored.items.every((item) => !item.stale));
    check('刷新后匹配数正常', restored && restored.items.every((item) => item.matchCount >= 1));

    await toTab({ type: 'xp:clear' });
    await sleep(600);
    check('清空后 storage 无残留', (await storedItems()) === 0, await storedItems());
    await pageEval('window.__xpStamp = 1');
    await send('Page.reload', { ignoreCache: true });
    await waitDocument(true);
    await sleep(1200);
    const cleared = await toTab({ type: 'xp:getState' });
    check('清空后刷新不再恢复', cleared && cleared.items.length === 0, cleared && cleared.items.length);

    await toTab({ type: 'xp:setPick', on: true });
    await click(await pointCenter('#btn-one'));
    await toTab({ type: 'xp:setPick', on: false });
    const one = await waitItems(1);
    const keepId = one.items[0].id;
    await sleep(600);

    await pageEval('window.__xpStamp = 1');
    await send('Page.navigate', { url: otherUrl });
    for (let i = 0; i < 80; i++) {
      const url = await pageEval('location.href');
      if (url.indexOf('persist-other') >= 0 && (await pageEval("document.readyState === 'complete' && typeof window.__xpStamp === 'undefined'"))) break;
      await sleep(250);
    }
    await sleep(1200);
    const other = await swEval(
      `(async () => {
        const tabs = await chrome.tabs.query({ url: ${JSON.stringify(otherUrl)} });
        if (!tabs.length) return { error: 'tab not found' };
        try { return await chrome.tabs.sendMessage(tabs[0].id, { type: 'xp:getState' }); }
        catch (e) { return { error: String(e && e.message || e) }; }
      })()`
    );
    check('换页面不还原旧快照', other && Array.isArray(other.items) && other.items.length === 0, other && (other.items ? other.items.length : other.error));

    await pageEval('window.__xpStamp = 1');
    await send('Page.navigate', { url: pageUrl });
    for (let i = 0; i < 80; i++) {
      const url = await pageEval('location.href');
      if (url.indexOf('persist-fixture') >= 0 && (await pageEval("document.readyState === 'complete' && typeof window.__xpStamp === 'undefined'"))) break;
      await sleep(250);
    }
    const back = await waitItems(1);
    check('返回原页面重新恢复', back && back.items.length === 1 && back.items[0].id === keepId, back && back.items.map((item) => item.id).join(','));
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
