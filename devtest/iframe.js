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
      const file = path.join(__dirname, name === 'iframe-child.html' ? name : 'iframe-fixture.html');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const { server, port } = await serve();
  const pageUrl = 'http://127.0.0.1:' + port + '/iframe-fixture.html';
  const childUrl = 'http://127.0.0.1:' + port + '/iframe-child.html';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-iframe-'));
  const chrome = spawn(CHROME, [
    '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=1000,900', '--remote-debugging-port=0',
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
    const broadcast = (message) => swEval(
      `(async () => {
        const tabs = await chrome.tabs.query({ url: ${JSON.stringify(pageUrl)} });
        if (!tabs.length) return { error: 'tab not found' };
        try { return await chrome.tabs.sendMessage(tabs[0].id, ${JSON.stringify(message)}); }
        catch (e) { return { error: String(e && e.message || e) }; }
      })()`
    );
    const sendToFrame = (frameId, message) => swEval(
      `(async () => {
        const tabs = await chrome.tabs.query({ url: ${JSON.stringify(pageUrl)} });
        if (!tabs.length) return null;
        try {
          return await chrome.tabs.sendMessage(tabs[0].id, ${JSON.stringify(message)}, { frameId: ${frameId} });
        } catch (e) { return null; }
      })()`
    );
    const probeFrames = () => swEval(
      `(async () => {
        const tabs = await chrome.tabs.query({ url: ${JSON.stringify(pageUrl)} });
        if (!tabs.length) return [];
        const tabId = tabs[0].id;
        const out = [];
        for (let frameId = 1; frameId <= 12; frameId++) {
          try {
            const state = await chrome.tabs.sendMessage(tabId, { type: 'xp:frameGetState' }, { frameId });
            if (state && state.isTop === false) out.push({ frameId, state });
          } catch (e) {}
        }
        return out;
      })()`
    );
    const tabIdNow = () => swEval(
      `(async () => {
        const tabs = await chrome.tabs.query({ url: ${JSON.stringify(pageUrl)} });
        return tabs.length ? tabs[0].id : null;
      })()`
    );
    const storageKeys = () => swEval(
      `(async () => {
        const tabs = await chrome.tabs.query({ url: ${JSON.stringify(pageUrl)} });
        if (!tabs.length) return [];
        const all = await chrome.storage.session.get(null);
        return Object.keys(all || {}).filter((k) => k.indexOf('xpItems:' + tabs[0].id) === 0);
      })()`
    );
    const topState = () => sendToFrame(0, { type: 'xp:getState' });
    const childState = async (frameId) => {
      const frames = await probeFrames();
      const hit = frames.find((f) => f.frameId === frameId);
      return hit ? hit.state : null;
    };
    const waitChild = async (predicate, tries = 60) => {
      for (let i = 0; i < tries; i++) {
        const frames = await probeFrames();
        const hit = frames.find((f) => f.state.url.indexOf('iframe-child') >= 0);
        if (hit && (!predicate || predicate(hit.state))) return hit;
        await sleep(250);
      }
      return null;
    };

    browser = await connect(version.webSocketDebuggerUrl);
    let pageTarget = null;
    for (let i = 0; i < 60 && !pageTarget; i++) {
      const list = await httpJson('http://127.0.0.1:' + DEBUG_PORT + '/json/list');
      pageTarget = list.find((t) => t.type === 'page' && t.url.indexOf('iframe-fixture') >= 0);
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
      const ready = await pageEval("document.readyState === 'complete' && !!document.querySelector('#child-frame')");
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
    const childPoint = (selector) => pageEval(`(() => {
      const frame = document.querySelector('#child-frame');
      const doc = frame && frame.contentDocument;
      const el = doc && doc.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const fr = frame.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { x: Math.round(fr.left + r.left + r.width / 2), y: Math.round(fr.top + r.top + r.height / 2) };
    })()`);
    const childCorner = (selector) => pageEval(`(() => {
      const frame = document.querySelector('#child-frame');
      const doc = frame && frame.contentDocument;
      const el = doc && doc.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const fr = frame.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { x: Math.round(fr.left + r.left + 8), y: Math.round(fr.top + r.top + 8) };
    })()`);
    const boxVisibility = async (where) => pageEval(`(() => {
      const doc = ${where === 'child' ? "document.querySelector('#child-frame').contentDocument" : 'document'};
      const host = doc && doc.getElementById('__xp_picker_host__');
      const root = host && host.shadowRoot;
      if (!root) return null;
      const shown = (sel) => Array.from(root.querySelectorAll(sel))
        .filter((box) => getComputedStyle(box).display !== 'none').length;
      return {
        items: shown('.xp-box:not(.xp-preview):not(.xp-anchor)'),
        previews: shown('.xp-box.xp-preview')
      };
    })()`);
    const clickAt = async (point) => {
      if (!point) return false;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(320);
      return true;
    };
    const setPick = async (on) => {
      await broadcast({ type: 'xp:setPick', on });
      await sleep(250);
    };
    const pickAt = async (point) => {
      await setPick(true);
      await clickAt(point);
      await sleep(300);
      await setPick(false);
      await sleep(400);
    };

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
      const frameChip = li.querySelector('.chip.frame');
      const buttons = Array.from(li.querySelectorAll('.path-modes button'));
      return {
        id: li.dataset.id,
        n: (li.querySelector('.num') || {}).textContent || '',
        tag: (li.querySelector('.tag') || {}).textContent || '',
        frame: frameChip ? frameChip.textContent : '',
        frameTitle: frameChip ? frameChip.title : '',
        name: (li.querySelector('.name-input') || {}).value || '',
        xpath: (li.querySelector('.xpath-input') || {}).value || '',
        match: (li.querySelector('.match') || {}).textContent || '',
        chips: buttons.map((b) => b.textContent),
        chipsOff: buttons.filter((b) => b.disabled).map((b) => b.textContent),
        active: (li.querySelector('.path-modes button.active') || {}).textContent || '',
        facts: Array.from(li.querySelectorAll('.facts .fact')).map((f) => f.textContent),
        hasRoot: !!li.querySelector('[data-root]'),
        actions: Array.from(li.querySelectorAll('.actions button')).map((b) => ({ act: b.dataset.act, disabled: b.disabled }))
      };
    }))()`);
    const waitCards = async (count, tries = 50) => {
      for (let i = 0; i < tries; i++) {
        const cards = await readCards();
        if (cards.length === count) return cards;
        await sleep(250);
      }
      return readCards();
    };
    const waitCard = async (predicate, tries = 40) => {
      for (let i = 0; i < tries; i++) {
        const cards = await readCards();
        const hit = cards.find(predicate);
        if (hit) return hit;
        await sleep(250);
      }
      return null;
    };
    const clickCard = (index, selector) => panelEval(`(() => {
      const li = document.querySelectorAll('#items .item')[${index}];
      if (!li) return false;
      const el = li.querySelector(${JSON.stringify(selector)});
      if (!el || el.disabled) return false;
      el.click();
      return true;
    })()`);
    const setCardInput = (index, selector, value) => panelEval(`(() => {
      const li = document.querySelectorAll('#items .item')[${index}];
      if (!li) return false;
      const el = li.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('blur'));
      return true;
    })()`);
    const panelFrames = () => panelEval(
      `typeof frameStates === 'undefined' ? null : Array.from(frameStates.entries()).map(([id, s]) => ({ id, url: s.url, items: (s.items || []).length }))`
    );

    const child0 = await waitChild(null);
    check('发现 iframe 子框架并注入内容脚本', !!child0, child0 && child0.frameId);
    check('子框架初始没有条目', !!child0 && child0.state.items.length === 0, child0 && child0.state.items.length);
    check('顶层初始没有条目', (await topState()).items.length === 0);

    // 面板就绪
    let panelReady = false;
    for (let i = 0; i < 60; i++) {
      const info = await panelEval('({ ready: typeof supported !== "undefined" && supported, tab: tabId })');
      if (info && info.ready && info.tab) { panelReady = true; break; }
      await sleep(250);
    }
    check('面板识别当前标签页', panelReady);
    const frames0 = await panelFrames();
    check('面板已并入 iframe 帧状态', !!frames0 && frames0.some((f) => f.id === child0.frameId && f.items === 0), frames0);

    // 1. iframe 内拾取
    await pickAt(await childPoint('#pay-now'));
    const childPay0 = (await childState(child0.frameId)).items;
    check('iframe 内拾取成功', childPay0.length === 1 && childPay0[0].tag === 'button', childPay0.map((it) => it.tag));
    check('iframe 条目 XPath 不限 iframe 前缀', childPay0[0].xpath === "//*[@id='pay-now']", childPay0[0].xpath);
    check('iframe 条目唯一命中', childPay0[0].matchCount === 1, childPay0[0].matchCount);
    check('顶层条目未被误写', (await topState()).items.length === 0);

    const cardsIframe = await waitCards(1);
    check('面板出现 iframe 卡片', cardsIframe.length === 1, cardsIframe.map((c) => c.id));
    check('卡片带 iframe 标签', cardsIframe[0] && cardsIframe[0].frame === 'iframe 1', cardsIframe[0] && cardsIframe[0].frame);
    check('iframe 标签提示只在所属文档生效', !!cardsIframe[0] && cardsIframe[0].frameTitle.indexOf('iframe') >= 0, cardsIframe[0] && cardsIframe[0].frameTitle);
    check('iframe 卡片本地编号为 1', cardsIframe[0] && cardsIframe[0].n === '1', cardsIframe[0] && cardsIframe[0].n);
    check('iframe 卡片支持匹配方式', !!cardsIframe[0] && cardsIframe[0].chips.join('/') === '自动/属性/文本/class/结构', cardsIframe[0] && cardsIframe[0].chips);

    // 2. 顶层拾取后合并
    await pickAt(await pointAt('#top-btn'));
    const topAfter = await topState();
    const cardsBoth = await waitCards(2);
    check('顶层拾取与 iframe 条目并存', topAfter.items.length === 1, topAfter.items.length);
    check('卡片按顶层在前合并', cardsBoth.length === 2 && !cardsBoth[0].frame && cardsBoth[1].frame === 'iframe 1', cardsBoth.map((c) => c.frame));
    check('两帧编号各自独立', cardsBoth[0].n === '1' && cardsBoth[1].n === '1', cardsBoth.map((c) => c.n));

    // 3. 父级 / 回到原始元素都在 iframe 帧内执行
    await clickCard(1, 'button[data-act="parent"]');
    await sleep(700);
    const childParent = (await childState(child0.frameId)).items;
    check('iframe 条目父级在所属帧执行', childParent[0].tag === 'div' && childParent[0].xpath === "//*[@id='cart']", childParent[0] && childParent[0].xpath);
    check('顶层条目不受 iframe 父级影响', (await topState()).items[0].tag === 'button');
    await clickCard(1, '[data-root]');
    await sleep(700);
    const childRoot = (await childState(child0.frameId)).items;
    check('回到原始元素恢复 iframe 目标', childRoot[0].tag === 'button' && childRoot[0].xpath === "//*[@id='pay-now']", childRoot[0] && childRoot[0].xpath);

    // 4. iframe 内列表模式 + 跨文档验证
    await pickAt(await childPoint('#order-table tbody tr:nth-child(2) .op-btn'));
    const childTwo = (await childState(child0.frameId)).items;
    check('iframe 内可连续拾取第二条', childTwo.length === 2, childTwo.length);
    await waitCards(3);
    await clickCard(2, 'button[data-act="mode"]');
    await sleep(800);
    const listItem = (await childState(child0.frameId)).items[1];
    check('iframe 列表模式命中 4 行', !!(listItem && listItem.listMode && listItem.matchCount === 4), listItem && { list: listItem.listMode, count: listItem.matchCount });
    check('列表 XPath 不带行号', !!(listItem && !/tr\[\d+\]/.test(listItem.xpath)), listItem && listItem.xpath);
    const childValidate = await sendToFrame(child0.frameId, { type: 'xp:validate', xpath: listItem.xpath });
    const topValidate = await sendToFrame(0, { type: 'xp:validate', xpath: listItem.xpath });
    check('列表 XPath 在 iframe 文档内命中 4 个', !!childValidate && childValidate.count === 4, childValidate && childValidate.count);
    check('同一 XPath 在顶层文档不命中', !!topValidate && topValidate.count === 0, topValidate && topValidate.count);

    // 5. 匹配方式切换仍走 iframe 帧
    await clickCard(2, '.path-modes button[data-mode="text"]');
    await sleep(800);
    const textItem = (await childState(child0.frameId)).items[1];
    check('iframe 条目切文本模式', !!textItem && textItem.pathMode === 'text' && textItem.xpath.indexOf("normalize-space(.)='查看'") >= 0, textItem && textItem.xpath);
    check('文本模式在 iframe 内命中 4 个', !!textItem && textItem.matchCount === 4, textItem && textItem.matchCount);
    await clickCard(2, '.path-modes button[data-mode="structure"]');
    await sleep(800);
    const structItem = (await childState(child0.frameId)).items[1];
    check('iframe 条目切结构模式按列匹配', !!structItem && structItem.pathMode === 'structure' && structItem.xpath.indexOf('td[3]') >= 0, structItem && structItem.xpath);

    // 6. iframe 内锚点
    await clickCard(1, 'button[data-act="anchor"]');
    await sleep(400);
    const anchorMode = await panelEval('state.anchorMode');
    check('锚点模式落在 iframe 条目上', !!anchorMode && anchorMode.indexOf(child0.frameId + ':') === 0, anchorMode);
    await clickAt(await childCorner('#cart'));
    await sleep(900);
    const anchoredItem = (await childState(child0.frameId)).items[0];
    check('iframe 内锚点已绑定', !!(anchoredItem && anchoredItem.anchorMarked && anchoredItem.anchorExpr), anchoredItem && anchoredItem.anchorExpr);
    const anchorCard = await waitCard((c) => c.frame === 'iframe 1' && c.facts.some((t) => t.indexOf('锚点式') >= 0));
    check('卡片显示 iframe 锚点表达式', !!anchorCard, anchorCard && anchorCard.facts);
    check('顶层条目没有锚点', !(await topState()).items[0].anchorMarked);
    const anchorChip = await clickCard(1, '.path-modes button[data-mode="anchor"]');
    await sleep(800);
    const anchorPathItem = (await childState(child0.frameId)).items[0];
    check('iframe 锚点模式 XPath 以锚点开头', !!(anchorChip && anchorPathItem && anchorPathItem.pathMode === 'anchor' && anchorPathItem.xpath.indexOf(anchorPathItem.anchorExpr + '/') === 0), anchorPathItem && { xpath: anchorPathItem.xpath, expr: anchorPathItem.anchorExpr });

    // 7. 重命名与手写 XPath 路由到 iframe 帧
    await setCardInput(1, '.name-input', 'iframe支付');
    await sleep(600);
    const renamed = (await childState(child0.frameId)).items[0];
    check('iframe 条目重命名生效', !!renamed && renamed.name === 'iframe支付', renamed && renamed.name);
    await setCardInput(1, '.xpath-input', '//*[@id="cart"]/button');
    await sleep(700);
    const manual = (await childState(child0.frameId)).items[0];
    check('iframe 手写 XPath 生效', !!manual && manual.origin === 'manual' && manual.xpath === '//*[@id="cart"]/button', manual && { origin: manual.origin, xpath: manual.xpath });
    check('手写条目不再提供匹配方式', !(manual && manual.canPathMode));

    // 8. AI 上下文与提示词都标明 iframe 文档
    const context = await sendToFrame(child0.frameId, { type: 'xp:getContext', id: manual.id });
    check('AI 上下文标记 iframe 文档', !!context && context.frame && context.frame.isTop === false && context.frame.url.indexOf('iframe-child') >= 0, context && context.frame);
    check('AI 上下文 XPath 属于 iframe 文档', !!context && context.currentXpath === '//*[@id="cart"]/button', context && context.currentXpath);
    const promptText = await panelEval(`buildPrompt({ frame: { url: ${JSON.stringify(childUrl)}, isTop: false } }, 'unique', '', '')`);
    check('AI 提示词声明 XPath 在 iframe 内解析', typeof promptText === 'string' && promptText.indexOf('所在文档: iframe') >= 0, promptText && promptText.slice(0, 120));

    // 9. 每帧独立快照 + 刷新恢复
    await sleep(900);
    const tabId = await tabIdNow();
    const keysBefore = await storageKeys();
    check('顶层快照已写入 storage.session', keysBefore.indexOf('xpItems:' + tabId) >= 0, keysBefore);
    check('iframe 快照按 frameId 写入', keysBefore.indexOf('xpItems:' + tabId + ':f' + child0.frameId) >= 0, keysBefore);

    const preReload = await panelEval('({ activeFrameId, frames: Array.from(frameStates.keys()) })');
    check('刷新前活动帧在 iframe', preReload.activeFrameId === child0.frameId, preReload);
    await pageEval('window.__xpStamp = 1');
    await send('Page.reload', { ignoreCache: true });
    for (let i = 0; i < 80; i++) {
      const ready = await pageEval("document.readyState === 'complete' && typeof window.__xpStamp === 'undefined'");
      if (ready) break;
      await sleep(250);
    }
    const topRestored = await (async () => {
      for (let i = 0; i < 40; i++) {
        const st = await topState();
        if (st && st.items.length === 1) return st;
        await sleep(250);
      }
      return await topState();
    })();
    check('刷新后顶层条目恢复', !!topRestored && topRestored.items.length === 1, topRestored && topRestored.items.length);
    const childRestored = await waitChild((st) => st.items.length === 2, 60);
    check('刷新后 iframe 条目恢复', !!childRestored, childRestored && childRestored.state.items.length);
    check('刷新后 iframe 条目变量名保留', !!childRestored && childRestored.state.items[0].name === 'iframe支付', childRestored && childRestored.state.items[0].name);
    check('刷新后 iframe 手写 XPath 保留', !!childRestored && childRestored.state.items[0].xpath === '//*[@id="cart"]/button', childRestored && childRestored.state.items[0].xpath);
    check('刷新后 iframe 锚点仍绑定', !!childRestored && !!childRestored.state.items[0].anchorMarked, childRestored && childRestored.state.items[0].anchorMarked);
    const keysAfter = await storageKeys();
    const childIdAfter = childRestored ? childRestored.frameId : child0.frameId;
    check('刷新后快照落在新 frameId 键上', keysAfter.indexOf('xpItems:' + tabId + ':f' + childIdAfter) >= 0, keysAfter);
    if (childIdAfter !== child0.frameId) {
      check('旧 frameId 键已迁移清理', keysAfter.indexOf('xpItems:' + tabId + ':f' + child0.frameId) < 0, keysAfter);
    }
    const cardsRestored = await waitCards(3, 60);
    check('刷新后面板重新合并两帧卡片', cardsRestored.length === 3 && cardsRestored.filter((c) => c.frame).length === 2, cardsRestored.map((c) => ({ frame: c.frame, xpath: c.xpath })));

    // 10. 验证页跟随 iframe 帧（刷新后活动帧应回到原来的 iframe）
    let activeInfo = null;
    for (let i = 0; i < 30; i++) {
      activeInfo = await panelEval('({ activeFrameId, frames: Array.from(frameStates.keys()) })');
      if (activeInfo && activeInfo.activeFrameId === childIdAfter) break;
      await sleep(200);
    }
    check('刷新后活动帧仍停在原 iframe', !!activeInfo && activeInfo.activeFrameId === childIdAfter, activeInfo);
    const boxesBefore = { top: await boxVisibility('top'), child: await boxVisibility('child') };
    check('验证前拾取高亮可见', !!boxesBefore.top && boxesBefore.top.items > 0 && !!boxesBefore.child && boxesBefore.child.items > 0, boxesBefore);
    await panelEval(`document.querySelector('#validateBtn').click()`);
    await sleep(400);
    const boxesOnOpen = { top: await boxVisibility('top'), child: await boxVisibility('child') };
    check('进入验证视图后隐藏拾取高亮', !!boxesOnOpen.top && boxesOnOpen.top.items === 0 && !!boxesOnOpen.child && boxesOnOpen.child.items === 0, boxesOnOpen);
    await panelEval(`(() => {
      const input = document.querySelector('#validateXpath');
      input.value = ${JSON.stringify(structItem.xpath)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(1000);
    const validateInfo = await panelEval(`({
      status: document.querySelector('#validateStatus').textContent,
      rows: document.querySelectorAll('#validateList .match-row').length
    })`);
    check('验证页在 iframe 帧内执行', validateInfo.status.indexOf('iframe 1') >= 0, validateInfo.status);
    check('验证页高亮 iframe 内的 4 个匹配', validateInfo.rows === 4, validateInfo.rows);
    const boxesDuring = { top: await boxVisibility('top'), child: await boxVisibility('child') };
    check('验证预览期间仍隐藏拾取高亮', !!boxesDuring.top && boxesDuring.top.items === 0 && !!boxesDuring.child && boxesDuring.child.items === 0, boxesDuring);
    check('验证预览蚂蚁线显示在 iframe 内', !!boxesDuring.child && boxesDuring.child.previews === 4, boxesDuring);
    await panelEval(`document.querySelector('#validateBackBtn').click()`);
    await sleep(400);
    const boxesAfter = { top: await boxVisibility('top'), child: await boxVisibility('child') };
    check('关闭验证视图后恢复拾取高亮', !!boxesAfter.top && boxesAfter.top.items > 0 && !!boxesAfter.child && boxesAfter.child.items > 0, boxesAfter);
    check('关闭验证视图后清除蚂蚁线', !!boxesAfter.child && boxesAfter.child.previews === 0, boxesAfter);

    // 11. 在 iframe 内按 Esc 停止全局拾取
    await clickAt(await childPoint('#pay-now'));
    await setPick(true);
    const pickOnTop = (await topState()).picking;
    const pickOnChild = (await childState(childIdAfter)).picking;
    check('拾取广播覆盖顶层与 iframe', pickOnTop === true && pickOnChild === true, { top: pickOnTop, child: pickOnChild });
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(800);
    const pickOffTop = (await topState()).picking;
    const pickOffChild = (await childState(childIdAfter)).picking;
    check('iframe 内 Esc 停止所有帧拾取', pickOffTop === false && pickOffChild === false, { top: pickOffTop, child: pickOffChild });
    check('Esc 不影响已拾取条目', (await childState(childIdAfter)).items.length === 2);
    await setPick(false);

    // 12. 移除 iframe 后卡片与帧状态一起消失，重新插入可恢复
    await panelEval(`document.querySelectorAll('#items .item').length`);
    await pageEval(`document.getElementById('child-frame').remove()`);
    const afterRemove = await waitCards(1, 40);
    const framesAfterRemove = await panelFrames();
    check('移除 iframe 后子帧卡片消失', afterRemove.length === 1 && !afterRemove[0].frame, afterRemove.map((c) => c.frame));
    check('移除 iframe 后面板丢弃该帧状态', !!framesAfterRemove && !framesAfterRemove.some((f) => f.id === childIdAfter), framesAfterRemove);
    let childGone = false;
    for (let i = 0; i < 40; i++) {
      const frames = await probeFrames();
      if (!frames.some((f) => f.frameId === childIdAfter)) { childGone = true; break; }
      await sleep(250);
    }
    check('子框架不再响应', childGone, childGone);

    await pageEval(`(() => {
      const frame = document.createElement('iframe');
      frame.id = 'child-frame';
      frame.src = ${JSON.stringify(childUrl)};
      document.body.appendChild(frame);
    })()`);
    const childBack = await waitChild((st) => st.items.length === 2, 80);
    check('重新插入 iframe 后条目自动恢复', !!childBack, childBack && childBack.state.items.length);
    const cardsBack = await waitCards(3, 60);
    check('重新插入后卡片重新合并', cardsBack.length === 3 && cardsBack.filter((c) => c.frame).length === 2, cardsBack.map((c) => c.frame));

    // 13. 清空所有帧
    await panelEval(`document.querySelector('#clearBtn').click()`);
    await sleep(250);
    await panelEval(`document.querySelector('#clearOk').click()`);
    await sleep(1000);
    const cardsCleared = await waitCards(0, 40);
    check('清空隐藏所有卡片', cardsCleared.length === 0, cardsCleared.length);
    check('清空后顶层无条目', (await topState()).items.length === 0);
    const childNow = await waitChild((st) => st.items.length === 0, 20);
    check('清空后 iframe 帧无条目', !!childNow, childNow && childNow.state.items.length);
    const keysCleared = await storageKeys();
    check('清空后两帧快照都移除', keysCleared.length === 0, keysCleared);
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
