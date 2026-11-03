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
    const file = path.join(__dirname, 'anchor-broken-fixture.html');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const { server, port } = await serve();
  const pageUrl = 'http://127.0.0.1:' + port + '/anchor-broken-fixture.html';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-anchorbroken-'));
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
      pageTarget = list.find((t) => t.type === 'page' && t.url.indexOf('anchor-broken-fixture') >= 0);
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
    // 点面板内边距，避免点到内部子元素
    const pointCorner = (selector) => pageEval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + 4), y: Math.round(r.top + 4) };
    })()`);
    const clickAt = async (point) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(320);
    };
    const item = async (index) => {
      const state = await toTab({ type: 'xp:getState' });
      return state && state.items && state.items[index];
    };

    for (let i = 0; i < 60; i++) {
      const ready = await pageEval("document.readyState === 'complete' && !!document.getElementById('panel-anchor')");
      if (ready) break;
      await sleep(250);
    }
    await sleep(700);

    await toTab({ type: 'xp:setPick', on: true });
    await clickAt(await pointCenter('#panel-anchor .amount'));
    await toTab({ type: 'xp:setPick', on: false });
    const picked = await item(0);
    const pickedId = picked && picked.id;

    await toTab({ type: 'xp:pickAnchor', id: pickedId });
    await clickAt(await pointCorner('#panel-anchor'));
    await sleep(300);

    const anchored = await item(0);
    const anchoredXpath = anchored && anchored.xpath;
    check('锚点路径以锚点表达式开头', !!anchoredXpath && /panel-anchor/.test(anchoredXpath), anchoredXpath);
    check('锚点有效时未标记失效', anchored && anchored.anchorBroken === false && anchored.stale === false, anchored && { broken: anchored.anchorBroken, stale: anchored.stale });
    check('锚点标签可读', anchored && /panel-shell/.test(anchored.anchorLabel), anchored && anchored.anchorLabel);
    check('面板拿到锚点表达式', anchored && anchored.anchorExpr === "//*[@id='panel-anchor']", anchored && anchored.anchorExpr);
    check('锚点表达式唯一命中', anchored && anchored.anchorMatchCount === 1, anchored && anchored.anchorMatchCount);
    check('锚点表达式不含下标', anchored && anchored.anchorIndexed === false, anchored && anchored.anchorIndexed);
    check('XPath 确实使用了锚点', anchored && anchored.anchorApplied === true, anchored && anchored.anchorApplied);
    check('使用锚点时不提示未生效', anchored && anchored.anchorIneffective === false && anchored.anchorSkipped === false, anchored && { ineffective: anchored.anchorIneffective, skipped: anchored.anchorSkipped });

    await pageEval("window.__renameAnchor('panel-anchor-2')");
    await sleep(500);
    const broken = await item(0);
    check('锚点表达式失效后标记 anchorBroken', broken && broken.anchorBroken === true, broken && broken.anchorBroken);
    check('锚点失效后条目显示已失效', broken && broken.stale === true, broken && broken.stale);
    check('锚点失效后不再静默改写 XPath', broken && broken.xpath === anchoredXpath, broken && broken.xpath);
    check('锚点失效后锚点标签清空', broken && broken.anchorLabel === '', broken && broken.anchorLabel);
    const brokenContext = await toTab({ type: 'xp:getContext', id: pickedId, fullHtml: false });
    check('AI 上下文报告锚点失效', brokenContext && brokenContext.anchor && brokenContext.anchor.broken === true, brokenContext && brokenContext.anchor && brokenContext.anchor.broken);

    await pageEval("window.__restoreAnchor('panel-anchor-2')");
    await sleep(500);
    const restored = await item(0);
    check('锚点恢复后取消失效', restored && restored.anchorBroken === false && restored.stale === false, restored && { broken: restored.anchorBroken, stale: restored.stale });
    check('锚点恢复后 XPath 不变', restored && restored.xpath === anchoredXpath, restored && restored.xpath);
    check('锚点恢复后重新匹配唯一元素', restored && restored.matchCount === 1, restored && restored.matchCount);
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
