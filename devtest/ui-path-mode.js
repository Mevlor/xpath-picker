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
    const file = path.join(__dirname, 'path-mode-fixture.html');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const { server, port } = await serve();
  const pageUrl = 'http://127.0.0.1:' + port + '/path-mode-fixture.html';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-pathmode-ui-'));
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
      pageTarget = list.find((t) => t.type === 'page' && t.url.indexOf('path-mode-fixture') >= 0);
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
      const ready = await pageEval("document.readyState === 'complete' && !!document.getElementById('pay-now')");
      if (ready) break;
      await sleep(250);
    }
    await sleep(700);

    const pointAt = (selector) => pageEval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    const cornerAt = (selector) => pageEval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + 8), y: Math.round(r.top + 8) };
    })()`);
    const clickAt = async (point) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(320);
    };
    const items = async () => {
      const state = await toTab({ type: 'xp:getState' });
      return (state && state.items) || [];
    };
    const lastItem = async () => {
      const list = await items();
      return list[list.length - 1];
    };
    const pick = async (selector) => {
      await toTab({ type: 'xp:setPick', on: true });
      await clickAt(await pointAt(selector));
      await toTab({ type: 'xp:setPick', on: false });
      return lastItem();
    };

    // 准备：一个有锚点的条目 + 一个手写 XPath 的条目
    const pay = await pick('#pay-now');
    await toTab({ type: 'xp:pickAnchor', id: pay.id });
    await clickAt(await cornerAt('#cart'));
    const op = await pick('#order-table tbody tr:nth-child(2) .op-btn');
    await toTab({ type: 'xp:setXPath', id: op.id, xpath: "//*[@id='order-table']//button[1]" });
    const plain = await pick('#plain-box span');
    check('无属性元素拾取成功', !!plain && plain.tag === 'span', plain && plain.tag);

    // 打开真实面板页面（不激活，保持夹具标签页为 active）
    const panelUrl = await swEval("chrome.runtime.getURL('sidepanel.html')");
    await swEval(`chrome.tabs.create({ url: ${JSON.stringify(panelUrl)}, active: false })`);
    let panelTarget = null;
    for (let i = 0; i < 60 && !panelTarget; i++) {
      const list = await httpJson('http://127.0.0.1:' + DEBUG_PORT + '/json/list');
      panelTarget = list.find((t) => t.type === 'page' && t.url.indexOf('sidepanel.html') >= 0);
      if (!panelTarget) await sleep(250);
    }
    if (!panelTarget) throw new Error('panel page not found');
    const panelAttach = await browser.send('Target.attachToTarget', { targetId: panelTarget.id, flatten: true });
    const panelSession = panelAttach.sessionId;
    const panelEval = async (expression) => {
      const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, panelSession);
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const readCards = () => panelEval(`(() => Array.from(document.querySelectorAll('#items .item')).map((li) => {
      const buttons = Array.from(li.querySelectorAll('.path-modes button'));
      return {
        id: li.dataset.id,
        chips: buttons.map((b) => b.textContent),
        chipsOff: buttons.filter((b) => b.disabled).map((b) => b.textContent),
        offOpacity: buttons.filter((b) => b.disabled).map((b) => Number(getComputedStyle(b).opacity)),
        active: (li.querySelector('.path-modes button.active') || {}).textContent || '',
        xpath: (li.querySelector('.xpath-input') || {}).value || ''
      };
    }))()`);
    const waitCards = async (count) => {
      for (let i = 0; i < 40; i++) {
        const cards = await readCards();
        if (cards.length >= count) return cards;
        await sleep(250);
      }
      return readCards();
    };

    const cards = await waitCards(3);
    check('面板渲染出卡片', cards.length >= 3, cards.map((c) => c.id));
    check('自动模式条目显示 6 个匹配方式', cards[0] && cards[0].chips.join('/') === '自动/属性/文本/class/结构/锚点', cards[0] && cards[0].chips);
    check('当前模式高亮为自动', cards[0] && cards[0].active === '自动', cards[0] && cards[0].active);
    check('有锚点且都有候选时不灰任何选项', cards[0] && cards[0].chipsOff.length === 0, cards[0] && cards[0].chipsOff);
    check('手写条目没有匹配方式行', cards[1] && cards[1].chips.length === 0, cards[1] && cards[1].chips);
    check('无候选的匹配方式被灰掉并禁用', cards[2] && cards[2].chipsOff.join('/') === '属性/文本/class', cards[2] && cards[2].chipsOff);
    check('灰掉的项有变暗样式', cards[2] && cards[2].offOpacity.length === 3 && cards[2].offOpacity.every((v) => v > 0 && v < 0.5), cards[2] && cards[2].offOpacity);
    check('结构选项仍可点', cards[2] && cards[2].chips.includes('结构') && !cards[2].chipsOff.includes('结构'), cards[2] && cards[2].chips);

    await panelEval(`document.querySelector('#items .item .path-modes button[data-mode="text"]').click()`);
    await sleep(600);
    const afterText = await waitCards(2);
    const textState = (await items())[0];
    check('点击文本 chip 高亮切换', afterText[0] && afterText[0].active === '文本', afterText[0] && afterText[0].active);
    check('点击文本 chip 面板 XPath 更新', afterText[0] && afterText[0].xpath.indexOf("normalize-space(.)='立即支付'") >= 0, afterText[0] && afterText[0].xpath);
    check('点击文本 chip 条目状态同步', textState && textState.pathMode === 'text' && textState.matchCount === 1, textState && { mode: textState.pathMode, count: textState.matchCount });

    await panelEval(`document.querySelector('#items .item .path-modes button[data-mode="structure"]').click()`);
    await sleep(600);
    const afterStruct = await waitCards(2);
    check('点击结构 chip 高亮切换', afterStruct[0] && afterStruct[0].active === '结构', afterStruct[0] && afterStruct[0].active);
    check('结构模式 XPath 不含文本谓词', afterStruct[0] && afterStruct[0].xpath.indexOf('normalize-space(.)=') < 0 && afterStruct[0].xpath.charAt(0) === '/', afterStruct[0] && afterStruct[0].xpath);

    const structXpath = afterStruct[0] && afterStruct[0].xpath;
    await panelEval(`document.querySelector('#items .item .path-modes button[data-mode="structure"]').click()`);
    await sleep(500);
    const afterSame = await waitCards(3);
    check('点击已激活 chip 不变更', afterSame[0] && afterSame[0].xpath === structXpath && afterSame[0].active === '结构', afterSame[0] && afterSame[0].xpath);

    const plainXpath = afterSame[2] && afterSame[2].xpath;
    await panelEval(`Array.from(document.querySelectorAll('#items .item'))[2].querySelector('.path-modes button[data-mode="text"]').click()`);
    await sleep(600);
    const afterOff = await waitCards(3);
    check('点击灰掉的选项不生效', afterOff[2] && afterOff[2].xpath === plainXpath && afterOff[2].active === '自动', afterOff[2] && { xpath: afterOff[2].xpath, active: afterOff[2].active });
    check('灰掉的选项点击后仍是自动', (await items())[2].pathMode === 'auto', (await items())[2].pathMode);

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
