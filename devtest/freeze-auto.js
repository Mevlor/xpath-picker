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

const READ_COUNTERS = `(() => {
  const n = (id) => Number(document.getElementById(id).textContent) || 0;
  const frame = document.getElementById('frame');
  const doc = frame && frame.contentDocument;
  return {
    timeout: n('v-timeout'), interval: n('v-interval'), raf: n('v-raf'),
    observer: n('v-observer'), anim: document.getElementById('v-anim').textContent,
    iframeInterval: doc ? Number(doc.getElementById('i').textContent) || 0 : -1,
    iframeRaf: doc ? Number(doc.getElementById('r').textContent) || 0 : -1
  };
})()`;

async function main() {
  const { server, port } = await serveProbe();
  const pageUrl = 'http://127.0.0.1:' + port + '/freeze-probe.html';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-freeze-'));
  const chrome = spawn(CHROME, [
    '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=900,900', '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    '--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required',
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
    const pageSession = attached.sessionId;
    const pageEval = async (expression) => {
      const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, pageSession);
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };

    for (let i = 0; i < 60; i++) {
      const ready = await pageEval("document.readyState === 'complete' && !!document.getElementById('frame') && !!document.getElementById('frame').contentDocument && !!document.getElementById('frame').contentDocument.getElementById('r')");
      if (ready) break;
      await sleep(250);
    }
    await sleep(900);

    const s1 = await pageEval(READ_COUNTERS);
    await sleep(800);
    const s2 = await pageEval(READ_COUNTERS);
    check('页面未冻结时计时器在走', s2.timeout > s1.timeout && s2.interval > s1.interval, { s1, s2 });
    check('页面未冻结时 rAF 在走', s2.raf > s1.raf, { raf1: s1.raf, raf2: s2.raf });
    check('页面未冻结时观察器在计数', s2.observer > s1.observer, { o1: s1.observer, o2: s2.observer });
    check('srcdoc 子框架已注入并运行', s2.iframeInterval > s1.iframeInterval && s2.iframeRaf > s1.iframeRaf, { i1: s1.iframeInterval, i2: s2.iframeInterval, r1: s1.iframeRaf, r2: s2.iframeRaf });

    await pageEval("document.getElementById('audio-start').click()");
    await sleep(600);
    const mediaPlaying = await pageEval("document.getElementById('v-media').textContent");
    check('音频进入播放态', mediaPlaying === 'playing', mediaPlaying);

    const freezeRes = await toTab({ type: 'xp:setFreeze', on: true });
    check('冻结指令送达内容脚本', freezeRes && freezeRes.frozen === true, freezeRes);
    await sleep(300);
    const state = await toTab({ type: 'xp:getState' });
    check('面板状态报告深度冻结', state && state.freezeDeep === true, state && { frozen: state.frozen, freezeDeep: state.freezeDeep, stats: state.freezeStats, frames: state.frames });
    check('统计到活动定时器与动画', state && state.freezeStats && state.freezeStats.timeouts >= 1 && state.freezeStats.intervals >= 2, state && state.freezeStats);

    const f1 = await pageEval(READ_COUNTERS);
    await sleep(900);
    const f2 = await pageEval(READ_COUNTERS);
    check('冻结后 setTimeout 链停住', f2.timeout === f1.timeout, { f1: f1.timeout, f2: f2.timeout });
    check('冻结后 setInterval 停住', f2.interval === f1.interval, { f1: f1.interval, f2: f2.interval });
    check('冻结后 rAF 停住', f2.raf === f1.raf, { f1: f1.raf, f2: f2.raf });
    check('冻结后 MutationObserver 停住', f2.observer === f1.observer, { f1: f1.observer, f2: f2.observer });
    check('冻结后 srcdoc 子框架停住', f2.iframeInterval === f1.iframeInterval && f2.iframeRaf === f1.iframeRaf, { i: [f1.iframeInterval, f2.iframeInterval], r: [f1.iframeRaf, f2.iframeRaf] });
    const mediaFrozen = await pageEval("document.getElementById('v-media').textContent");
    check('冻结后音频被暂停', mediaFrozen === 'paused', mediaFrozen);

    const engineStats = await pageEval('typeof __XP_FREEZE_ENGINE__ === "object" ? __XP_FREEZE_ENGINE__.stats() : null');
    check('页面 MAIN world 引擎可读', engineStats && engineStats.frozen === true, engineStats);

    await toTab({ type: 'xp:setFreeze', on: false });
    await sleep(900);
    const u1 = await pageEval(READ_COUNTERS);
    await sleep(800);
    const u2 = await pageEval(READ_COUNTERS);
    check('解冻后计时器恢复', u2.timeout > u1.timeout && u2.interval > u1.interval, { u1, u2 });
    check('解冻后 rAF 恢复', u2.raf > u1.raf, { r1: u1.raf, r2: u2.raf });
    check('解冻后子框架恢复', u2.iframeInterval > u1.iframeInterval && u2.iframeRaf > u1.iframeRaf, { i: [u1.iframeInterval, u2.iframeInterval], r: [u1.iframeRaf, u2.iframeRaf] });
    check('恢复是续跑而不是归零', u1.timeout >= f2.timeout, { frozenAt: f2.timeout, resumed: u1.timeout });
    const mediaResumed = await pageEval("document.getElementById('v-media').textContent");
    check('解冻后音频恢复播放', mediaResumed === 'playing', mediaResumed);

    const again = await toTab({ type: 'xp:setFreeze', on: true });
    await sleep(200);
    const r1 = await pageEval(READ_COUNTERS);
    await sleep(700);
    const r2 = await pageEval(READ_COUNTERS);
    check('可反复冻结（第二次）', r2.timeout === r1.timeout && r2.raf === r1.raf, { r1, r2 });
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
