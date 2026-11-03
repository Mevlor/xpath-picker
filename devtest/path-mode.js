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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-pathmode-'));
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

    const pointAt = (selector, inset) => pageEval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const pad = ${Number(inset) || 0};
      return { x: Math.round(r.left + pad + (r.width - pad * 2) / 2), y: Math.round(r.top + pad + (r.height - pad * 2) / 2) };
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
    const itemAt = async (index) => (await items())[index];
    const lastItem = async () => {
      const list = await items();
      return list[list.length - 1];
    };
    const pick = async (selector) => {
      const point = await pointAt(selector, 0);
      if (!point) throw new Error('selector not found: ' + selector);
      await toTab({ type: 'xp:setPick', on: true });
      await clickAt(point);
      await toTab({ type: 'xp:setPick', on: false });
      return lastItem();
    };

    // 1) 自动模式：id 属性族胜出
    const pay = await pick('#pay-now');
    check('拾取按钮', !!pay && pay.tag === 'button', pay && pay.tag);
    check('默认匹配方式为自动', !!pay && pay.pathMode === 'auto', pay && pay.pathMode);
    check('自动模式用 id 属性', !!pay && pay.xpath === "//*[@id='pay-now']", pay && pay.xpath);
    check('卡片允许切换匹配方式', !!pay && pay.canPathMode === true, pay && pay.canPathMode);
    check('可用性：属性/文本/class/结构 有候选，锚点无', !!pay && pay.pathModeAvail &&
      pay.pathModeAvail.auto === true &&
      pay.pathModeAvail.attr === true &&
      pay.pathModeAvail.text === true &&
      pay.pathModeAvail.class === true &&
      pay.pathModeAvail.structure === true &&
      pay.pathModeAvail.anchor === false,
      pay && pay.pathModeAvail);

    // 2) 文本模式：只用文本候选
    const textRes = await toTab({ type: 'xp:setPathMode', id: pay.id, mode: 'text' });
    check('切到文本模式成功', !!textRes && textRes.ok === true, textRes);
    const textItem = await itemAt(0);
    check('文本模式路径只含文本谓词', !!textItem && textItem.xpath.indexOf("normalize-space(.)='立即支付'") >= 0 && textItem.xpath.indexOf('class') < 0, textItem && textItem.xpath);
    check('文本模式命中唯一', !!textItem && textItem.matchCount === 1 && textItem.pathMode === 'text', textItem && { count: textItem.matchCount, mode: textItem.pathMode });

    // 3) class 模式：只用 class 候选
    const classRes = await toTab({ type: 'xp:setPathMode', id: pay.id, mode: 'class' });
    check('切到 class 模式成功', !!classRes && classRes.ok === true, classRes);
    const classItem = await itemAt(0);
    check('class 模式路径只含 class 谓词', !!classItem && /@class/.test(classItem.xpath) && classItem.xpath.indexOf('normalize-space(.)=') < 0, classItem && classItem.xpath);
    check('class 模式命中唯一', !!classItem && classItem.matchCount === 1, classItem && classItem.matchCount);

    // 4) 结构模式：层级路径
    const structRes = await toTab({ type: 'xp:setPathMode', id: pay.id, mode: 'structure' });
    check('切到结构模式成功', !!structRes && structRes.ok === true, structRes);
    const structItem = await itemAt(0);
    check('结构模式不含属性/文本谓词', !!structItem && structItem.xpath.charAt(0) === '/' && structItem.xpath.indexOf('normalize-space(.)=') < 0 && structItem.xpath.indexOf("@id='pay-now'") < 0, structItem && structItem.xpath);
    check('结构模式命中唯一', !!structItem && structItem.matchCount === 1, structItem && structItem.matchCount);

    // 5) 没有锚点时不能选锚点模式
    const noAnchor = await toTab({ type: 'xp:setPathMode', id: pay.id, mode: 'anchor' });
    check('无锚点切锚点模式被拒绝', !!noAnchor && noAnchor.ok === false && /锚点/.test(noAnchor.error || ''), noAnchor);

    // 6) 设置锚点后锚点模式生效
    await toTab({ type: 'xp:pickAnchor', id: pay.id });
    await clickAt(await cornerAt('#cart'));
    const anchoredItem = await itemAt(0);
    check('锚点已标记', !!anchoredItem && anchoredItem.anchorMarked === true, anchoredItem && anchoredItem.anchorExpr);
    check('可用性：设锚点后锚点模式可选', !!anchoredItem && anchoredItem.pathModeAvail && anchoredItem.pathModeAvail.anchor === true, anchoredItem && anchoredItem.pathModeAvail);
    const anchorRes = await toTab({ type: 'xp:setPathMode', id: pay.id, mode: 'anchor' });
    check('切到锚点模式成功', !!anchorRes && anchorRes.ok === true, anchorRes);
    const anchorItem = await itemAt(0);
    check('锚点模式路径以锚点表达式开头', !!anchorItem && anchorItem.anchorExpr && anchorItem.xpath.indexOf(anchorItem.anchorExpr + '/') === 0, anchorItem && { xpath: anchorItem.xpath, expr: anchorItem.anchorExpr });
    check('锚点模式命中唯一', !!anchorItem && anchorItem.matchCount === 1, anchorItem && anchorItem.matchCount);

    // 7) 取消锚点自动回到自动模式
    const cleared = await toTab({ type: 'xp:clearAnchor', id: pay.id });
    check('取消锚点成功', !!cleared && Array.isArray(cleared.items), !!cleared);
    const afterClear = await itemAt(0);
    check('取消锚点后回到自动模式', !!afterClear && afterClear.pathMode === 'auto' && afterClear.anchorMarked === false, afterClear && { mode: afterClear.pathMode, marked: afterClear.anchorMarked });

    // 8) 换目标元素（父级）后匹配方式重置为自动
    await toTab({ type: 'xp:setPathMode', id: pay.id, mode: 'text' });
    const moved = await toTab({ type: 'xp:action', id: pay.id, action: 'parent' });
    check('跳到父级成功', !!moved && Array.isArray(moved.items), !!moved);
    const parentItem = await itemAt(0);
    check('换目标后匹配方式回到自动', !!parentItem && parentItem.pathMode === 'auto', parentItem && parentItem.pathMode);
    check('换目标后按父级重新生成', !!parentItem && parentItem.xpath === "//*[@id='cart']", parentItem && parentItem.xpath);

    // 9) 非法模式被拒绝
    const bogus = await toTab({ type: 'xp:setPathMode', id: pay.id, mode: 'bogus' });
    check('未知匹配方式被拒绝', !!bogus && bogus.ok === false, bogus);

    // 10) 手写 XPath 不允许切模式
    await toTab({ type: 'xp:setXPath', id: pay.id, xpath: '//button[@id="pay-now"]' });
    const customItem = await itemAt(0);
    check('手写后不允许切模式', !!customItem && customItem.canPathMode === false, customItem && customItem.canPathMode);
    const customMode = await toTab({ type: 'xp:setPathMode', id: pay.id, mode: 'text' });
    check('手写条目切模式被拒绝', !!customMode && customMode.ok === false && /手写/.test(customMode.error || ''), customMode);
    await toTab({ type: 'xp:setXPath', id: pay.id, xpath: '' });
    const restored = await itemAt(0);
    check('清空手写后恢复可切模式', !!restored && restored.canPathMode === true, restored && restored.canPathMode);

    // 11) 列表模式下的模式切换
    const op = await pick('#order-table tbody tr:nth-child(2) .op-btn');
    check('拾取行内按钮', !!op && op.tag === 'button', op && op.tag);
    const listed = await toTab({ type: 'xp:setListMode', id: op.id, on: true });
    check('自动模式列表命中 4 行', !!listed && listed.ok === true && listed.count === 4, listed && { ok: listed.ok, count: listed.count });
    const listAuto = await itemAt(1);
    check('列表自动模式不带行序号', !!listAuto && listAuto.listMode === true && !/tr\[\d+\]/.test(listAuto.xpath || ''), listAuto && listAuto.xpath);

    const listText = await toTab({ type: 'xp:setPathMode', id: op.id, mode: 'text' });
    check('列表切文本模式成功', !!listText && listText.ok === true && listText.count === 4, listText && { ok: listText.ok, count: listText.count });
    const listTextItem = await itemAt(1);
    check('列表文本路径按文本批量', !!listTextItem && listTextItem.xpath.indexOf("normalize-space(.)='查看'") >= 0 && listTextItem.pathMode === 'text', listTextItem && listTextItem.xpath);

    const listStruct = await toTab({ type: 'xp:setPathMode', id: op.id, mode: 'structure' });
    check('列表切回结构模式成功', !!listStruct && listStruct.ok === true && listStruct.count === 4, listStruct && { ok: listStruct.ok, count: listStruct.count });
    const listStructItem = await itemAt(1);
    check('列表结构路径按列匹配', !!listStructItem && listStructItem.xpath.indexOf('normalize-space') < 0 && listStructItem.xpath.indexOf('td[3]') >= 0, listStructItem && listStructItem.xpath);

    // 12) 该族没有候选时拒绝并保持原路径
    const plain = await pick('#plain-box span');
    check('拾取无属性无文本元素', !!plain && plain.tag === 'span', plain && plain.tag);
    check('自动模式仍有路径', !!plain && !!plain.xpath && plain.pathMode === 'auto', plain && plain.xpath);
    check('可用性：无属性/文本/class 候选', !!plain && plain.pathModeAvail &&
      plain.pathModeAvail.attr === false &&
      plain.pathModeAvail.text === false &&
      plain.pathModeAvail.class === false &&
      plain.pathModeAvail.structure === true &&
      plain.pathModeAvail.auto === true,
      plain && plain.pathModeAvail);
    const emptyText = await toTab({ type: 'xp:setPathMode', id: plain.id, mode: 'text' });
    check('没有文本候选时拒绝切换', !!emptyText && emptyText.ok === false && /文本/.test(emptyText.error || ''), emptyText);
    const afterEmptyText = await itemAt(2);
    check('拒绝后保持原路径与自动模式', !!afterEmptyText && afterEmptyText.pathMode === 'auto' && afterEmptyText.xpath === plain.xpath, afterEmptyText && { mode: afterEmptyText.pathMode, xpath: afterEmptyText.xpath });
    const emptyClass = await toTab({ type: 'xp:setPathMode', id: plain.id, mode: 'class' });
    check('没有 class 候选时拒绝切换', !!emptyClass && emptyClass.ok === false && /class/.test(emptyClass.error || ''), emptyClass);

    const all = await items();
    check('没有任何条目退回绝对路径', all.every((entry) => !/^\/html\//.test(entry.xpath || '')), all.map((entry) => entry.xpath));
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
