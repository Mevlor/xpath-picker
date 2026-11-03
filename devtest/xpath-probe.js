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
    const file = path.join(__dirname, 'xpath-fixture.html');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const { server, port } = await serve();
  const pageUrl = 'http://127.0.0.1:' + port + '/xpath-fixture.html';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-xpath-'));
  const chrome = spawn(CHROME, [
    '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=1000,900', '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    '--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    pageUrl
  ], { stdio: 'ignore' });

  let browser = null;
  let sw = null;
  const report = {};
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  DEBUG_PORT = await readDebugPort(profile);
  if (!DEBUG_PORT) throw new Error('debug port not ready');
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
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      const list = await httpJson('http://127.0.0.1:' + DEBUG_PORT + '/json/list');
      target = list.find((t) => t.type === 'page' && t.url.indexOf('xpath-fixture') >= 0);
      if (!target) await sleep(250);
    }
    if (!target) throw new Error('fixture page not found');
    const attached = await browser.send('Target.attachToTarget', { targetId: target.id, flatten: true });
    const session = attached.sessionId;
    const send = (method, params) => browser.send(method, params, session);
    const pageEval = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };

    for (let i = 0; i < 60; i++) {
      if (await pageEval("document.readyState === 'complete' && !!document.querySelector('tbody.auxo-table-tbody')")) break;
      await sleep(250);
    }
    await sleep(500);

    const center = async (selector) => pageEval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    const click = async (point) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(250);
    };

    await toTab({ type: 'xp:setPick', on: true });

    const tabPoint = await center('.ant-tabs-tab-active .ant-tabs-tab-btn');
    await click(tabPoint);
    const tabState = await toTab({ type: 'xp:getState' });
    report.tabTarget = tabState.items[0] && tabState.items[0].xpath;

    const linkPoint = await center('tbody.auxo-table-tbody tr:first-child td:last-child a');
    await click(linkPoint);
    const linkState = await toTab({ type: 'xp:getState' });
    report.linkTarget = linkState.items[1] && linkState.items[1].xpath;
    report.linkCanList = linkState.items[1] && linkState.items[1].canList;

    await toTab({ type: 'xp:setListMode', id: linkState.items[1].id, on: true });
    const listState = await toTab({ type: 'xp:getState' });
    report.linkList = listState.items[1] && listState.items[1].xpath;
    report.linkListCount = listState.items[1] && listState.items[1].matchCount;

    await toTab({ type: 'xp:setPick', on: false });

    const countOf = (expr) => pageEval(`(() => {
      try { const r = document.evaluate(${JSON.stringify(expr)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); return r.snapshotLength; }
      catch (e) { return -1; }
    })()`);
    report.textTabCount = await countOf("//span[normalize-space()='平台给我开票']");
    report.textLinkCount = await countOf("//a[normalize-space()='上传发票']");
    report.roleContainsCount = await countOf("//div[@role='tab' and contains(@id,'platform-invoice')]//span[normalize-space()='平台给我开票']");

    const TAB_EXPECTED =
      "//div[@role='tab' and contains(@id,'platform-invoice')]//span[normalize-space(.)='平台给我开票']";
    const LINK_LIST_EXPECTED = "//a[normalize-space(.)='上传发票']";
    check('页签命中语义前缀 + 文本终点', report.tabTarget === TAB_EXPECTED, report.tabTarget);
    check('页签文本表达式唯一', report.roleContainsCount === 1, report.roleContainsCount);
    check('列表命中文本批量表达式', report.linkList === LINK_LIST_EXPECTED, report.linkList);
    check('列表文本批量命中 3 条', report.linkListCount === 3, report.linkListCount);
    check('单元素用稳定根 + 行 + 文本叶子', typeof report.linkTarget === 'string' && /^\/\/tbody\[/.test(report.linkTarget) && /tr\[1\]/.test(report.linkTarget) && report.linkTarget.indexOf("normalize-space(.)='上传发票'") >= 0, report.linkTarget);
    check('单元素不再退回绝对路径', typeof report.linkTarget === 'string' && report.linkTarget.indexOf('/html/') !== 0, report.linkTarget);

    const preview = await toTab({ type: 'xp:previewXPath', xpath: LINK_LIST_EXPECTED });
    await sleep(400);
    const ants = await pageEval(`(() => {
      const host = document.getElementById('__xp_picker_host__');
      const box = host && host.shadowRoot && host.shadowRoot.querySelector('.xp-box.xp-preview');
      if (!box) return null;
      const cs = getComputedStyle(box);
      return {
        display: cs.display,
        names: cs.animationName,
        iterations: cs.animationIterationCount,
        duration: cs.animationDuration,
        borderTop: cs.borderTopStyle,
        layers: cs.backgroundImage.split('repeating-linear-gradient').length - 1
      };
    })()`);
    check('预览高亮生成蚂蚁线框', !!preview && preview.ok && preview.count === 3 && !!ants && ants.display === 'block', { preview, ants });
    check('蚂蚁线使用循环动画', !!ants && ants.names.indexOf('xpPreviewAnts') >= 0 && ants.iterations.indexOf('infinite') >= 0, ants && { names: ants.names, iterations: ants.iterations });
    check('蚂蚁线四边各一层虚线', !!ants && ants.layers === 4 && ants.borderTop === 'none', ants);

    const antsPos = () => pageEval(`(() => {
      const host = document.getElementById('__xp_picker_host__');
      const box = host && host.shadowRoot && host.shadowRoot.querySelector('.xp-box.xp-preview');
      return box ? getComputedStyle(box).backgroundPosition : null;
    })()`);
    const posA = await antsPos();
    await sleep(300);
    const posB = await antsPos();
    check('蚂蚁线持续滚动', !!posA && !!posB && posA !== posB, { posA, posB });

    const LONG_NOTE = '售后编码：23755054145138 售后类型：补寄 申请原因：其他原因 售后申请说明：协商一致申请补寄 补寄地址：收件人韩* 手机号 13800000000 备注：这段文字用于确认验证卡片复制时取到完整内容而不是卡片上八十个字的预览截断。';
    const longPreview = await toTab({ type: 'xp:previewXPath', xpath: "//div[@id='long-note']" });
    const longCopy = await toTab({ type: 'xp:previewText', index: 0 });
    const missingCopy = await toTab({ type: 'xp:previewText', index: 9 });
    check('卡片预览文本按 80 字截断', !!longPreview && longPreview.ok && longPreview.matches.length === 1 && longPreview.matches[0].text.length === 81 && /…$/.test(longPreview.matches[0].text), longPreview.matches && longPreview.matches[0]);
    check('复制取到完整文本', !!longCopy && longCopy.ok && longCopy.text === LONG_NOTE, longCopy);
    check('索引失效时复制报错', !!missingCopy && missingCopy.ok === false, missingCopy);
  } catch (e) {
    report.error = String((e && e.stack) || e);
    check('no exception', false, report.error);
  } finally {
    const failed = checks.filter((c) => !c.ok);
    console.log(JSON.stringify({ report, checks, failed: failed.length }, null, 2));
    try { if (browser) browser.close(); } catch (e) {}
    try { if (sw) sw.close(); } catch (e) {}
    try { chrome.kill(); } catch (e) {}
    try { server.close(); } catch (e) {}
    await sleep(500);
    for (let i = 0; i < 10; i++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch (e) { await sleep(400); }
    }
    process.exit(failed.length ? 1 : 0);
  }
}

main();
