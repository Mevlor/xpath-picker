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

// buildPrompt 是纯函数，直接从 sidepanel.js 里取出源码在 Node 里执行，避免拉起侧边栏页面
function extractFunctionSource(src, name) {
  const marker = 'function ' + name + '(';
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('function not found: ' + name);
  const bodyStart = src.indexOf('{', start);
  if (bodyStart < 0) throw new Error('body not found: ' + name);
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let j = bodyStart; j < src.length; j++) {
    const ch = src[j];
    const next = src[j + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        j++;
      }
      continue;
    }
    if (quote) {
      if (ch === '\\') {
        j++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      j++;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      j++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error('unterminated function: ' + name);
}

function loadBuildPrompt() {
  const src = fs.readFileSync(path.join(ROOT, 'sidepanel.js'), 'utf8');
  const code = extractFunctionSource(src, 'buildPrompt');
  return new Function('return (' + code + ')')();
}

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
      const file = path.join(__dirname, name === 'ai-context-fixture.html' ? name : 'ai-context-fixture.html');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const { server, port } = await serve();
  const pageUrl = 'http://127.0.0.1:' + port + '/ai-context-fixture.html';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-aictx-'));
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
    const buildPrompt = loadBuildPrompt();

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
      pageTarget = list.find((t) => t.type === 'page' && t.url.indexOf('ai-context-fixture') >= 0);
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
      const ready = await pageEval("document.readyState === 'complete' && !!document.getElementById('invoice-panel')");
      if (ready) break;
      await sleep(250);
    }
    await sleep(700);

    const pointAt = (expr) => pageEval(`(() => {
      const el = ${expr};
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + Math.max(4, Math.min(10, r.width / 2))), y: Math.round(r.top + Math.max(4, Math.min(10, r.height / 2))) };
    })()`);
    const pointCenter = (expr) => pageEval(`(() => {
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

    const linkPoint = await pointCenter("document.querySelector('tbody.auxo-table-tbody tr:first-child td:last-child a')");
    await click(linkPoint);
    const link = await item(0);
    check('拾取表格内链接', link && link.tag === 'a', link && link.tag);

    const validateHit = await toTab({ type: 'xp:validate', id: link.id, xpath: link.xpath });
    check('校验结果命中拾取元素', validateHit && validateHit.containsTarget === true, validateHit && validateHit.containsTarget);
    const validateMiss = await toTab({ type: 'xp:validate', id: link.id, xpath: '//table//td[1]' });
    check('校验结果未命中时返回 false', validateMiss && validateMiss.containsTarget === false, validateMiss && validateMiss.containsTarget);
    const validateNoId = await toTab({ type: 'xp:validate', xpath: link.xpath });
    check('不传条目时不返回命中标记', validateNoId && validateNoId.containsTarget === null, validateNoId && validateNoId.containsTarget);

    await toTab({ type: 'xp:pickAnchor', id: link.id });
    await click(await pointAt("document.getElementById('invoice-panel')"));
    const contextA = await toTab({ type: 'xp:getContext', id: link.id, fullHtml: false });
    const anc = contextA && contextA.anchor;
    check('锚点是目标祖先', anc && anc.relation === 'ancestor', anc && anc.relation);
    check('锚点深度为正整数', anc && Number.isInteger(anc.depth) && anc.depth >= 1, anc && anc.depth);
    check('锚点表达式取强身份', anc && /invoice-panel/.test(anc.expr), anc && anc.expr);
    check('锚点匹配数为 1', anc && anc.matchCount === 1, anc && anc.matchCount);
    check('锚点结构摘要带 id', anc && anc.structure && anc.structure.id === 'invoice-panel', anc && anc.structure && anc.structure.id);
    check('祖先锚点不重复发送子树 HTML', anc && anc.html === undefined, anc && (anc.html ? String(anc.html).length : 'undefined'));
    check('上下文保留 currentXpath', contextA && typeof contextA.currentXpath === 'string' && !!contextA.currentXpath, contextA && contextA.currentXpath);
    check('上下文保留 currentMatchCount', contextA && typeof contextA.currentMatchCount === 'number', contextA && contextA.currentMatchCount);
    check('普通链接不标记 valueNode', contextA && !contextA.runtime.valueNode, contextA && contextA.runtime && contextA.runtime.valueNode);

    await toTab({ type: 'xp:clearAnchor', id: link.id });

    const spanPoint = await pointCenter("document.querySelector('.auxo-select-selection-item')");
    await click(spanPoint);
    const span = await item(1);
    check('拾取工具栏 Select 值节点', span && span.tag === 'span', span && span.tag);

    await toTab({ type: 'xp:pickAnchor', id: span.id });
    await click(await pointAt("document.querySelector('.filter-label')"));
    const contextB = await toTab({ type: 'xp:getContext', id: span.id, fullHtml: false });
    const near = contextB && contextB.anchor;
    check('非祖先锚点被识别为 nearby', near && near.relation === 'nearby', near && near.relation);
    check('锚点表达式使用文本', near && /normalize-space\(\.\)='订单状态'/.test(near.expr), near && near.expr);
    check('nearby 锚点附带子树 HTML', near && typeof near.html === 'string' && /filter-label/.test(near.html), near && (near.html || '').length);
    check('锚点文本标签可读', near && /订单状态/.test(near.label), near && near.label);
    check('Select 值节点标记 valueNode', contextB && contextB.runtime && contextB.runtime.valueNode === true, contextB && contextB.runtime && contextB.runtime.valueNode);

    const independent = await pageEval(`(() => {
      try {
        return document.evaluate(${JSON.stringify(contextB.currentXpath)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength;
      } catch (e) { return -1; }
    })()`);
    check('currentMatchCount 与实时求值一致', contextB && contextB.currentMatchCount === independent, contextB && (contextB.currentMatchCount + ' vs ' + independent));

    await toTab({ type: 'xp:clearAnchor', id: span.id });
    const contextC = await toTab({ type: 'xp:getContext', id: span.id, fullHtml: false });
    check('取消锚点后上下文不带 anchor', contextC && contextC.anchor === null, contextC && contextC.anchor);

    const diagA = contextA && contextA.diagnostics;
    check('上下文带 XPath 诊断', !!(diagA && typeof diagA === 'object'), diagA);
    check('诊断命中拾取元素', diagA && diagA.matchesTarget === true, diagA && diagA.matchesTarget);
    check('诊断标记锚点已生效', diagA && diagA.anchorApplied === true, diagA && diagA.anchorApplied);
    check('诊断报告锚点唯一', diagA && diagA.anchorMatchCount === 1, diagA && diagA.anchorMatchCount);
    check('诊断报告非绝对路径', diagA && diagA.absolute === false, diagA && diagA.absolute);
    check('诊断报告下标数量', diagA && typeof diagA.indexCount === 'number', diagA && diagA.indexCount);

    const promptA = buildPrompt(contextA, 'unique', '', '上传发票');
    check('prompt 含锚点章节', promptA.indexOf('## 用户指定的锚点（作用域约束）') >= 0);
    check('prompt 写明祖先关系', promptA.indexOf('- 与目标关系: 目标的第 ') >= 0);
    check('prompt 含锚点表达式', promptA.indexOf(anc.expr) >= 0, anc.expr);
    check('prompt 不重复锚点子树', promptA.indexOf('- 锚点子树（截断）:') < 0);
    check('prompt 含当前 XPath 章节', promptA.indexOf('## 当前自动生成的 XPath（仅作线索）') >= 0);
    check('prompt 唯一模式声明最终数量为 1', promptA.indexOf('唯一模式最终必须恰好匹配 1 个') >= 0);
    check('prompt 含当前匹配数', promptA.indexOf('采集时刻匹配数: ' + contextA.currentMatchCount) >= 0, contextA.currentMatchCount);
    check('prompt 锚点规则编号 12', promptA.indexOf('12. 锚点优先：') >= 0);
    check('prompt 锚点规则编号 13/14', promptA.indexOf('13. 列表模式下锚点即批量作用域') >= 0 && promptA.indexOf('14. 锚点表达式是用户认可的稳定参照') >= 0);
    check('prompt 当前 XPath 规则编号 15', promptA.indexOf('15. 「当前自动生成的 XPath」只是线索') >= 0);
    check('prompt 规则说明唯一模式数量为 1', promptA.indexOf('唯一模式下最终结果必须恰好匹配 1 个') >= 0);
    check('prompt 规则说明列表模式数量不一定等于现状', promptA.indexOf('不一定等于它的采集时刻匹配数') >= 0);

    const promptAList = buildPrompt(contextA, 'list', '', '上传发票');
    check('列表模式 prompt 说明锚点即作用域', promptAList.indexOf('列表模式下锚点即批量作用域') >= 0);
    check('列表模式 prompt 说明数量不一定等于现状', promptAList.indexOf('列表模式要覆盖页面上全部同类元素，不一定等于这个数字') >= 0);
    check('列表模式 prompt 使用列表任务描述', promptAList.indexOf('列表元素：XPath 需要匹配页面上所有同类元素') >= 0);

    const promptB = buildPrompt(contextB, 'unique', '', '订单状态');
    check('nearby prompt 附带锚点子树 HTML', promptB.indexOf('- 锚点子树（截断）:') >= 0 && promptB.indexOf('filter-label') >= 0);
    check('nearby prompt 写明非祖先关系', promptB.indexOf('与目标同处一个页面，但不是目标的祖先') >= 0);
    check('值节点 prompt 禁止用值和 title 做条件', promptB.indexOf('禁止用 @title、value 或显示文本作为匹配条件') >= 0);
    check('值节点 prompt 当前 XPath 规则编号 16', promptB.indexOf('16. 「当前自动生成的 XPath」只是线索') >= 0);
    check('普通元素 prompt 不含值节点规则', promptA.indexOf('禁止用 @title、value 或显示文本作为匹配条件') < 0);
    check('prompt 稳定优先规则', promptA.indexOf('稳定优先：唯一性要来自固定的结构') >= 0);
    check('prompt 列表模式禁止 or 拼接样本值', promptAList.indexOf('列表模式不要用 or 拼接采集时刻看到的具体样本值') >= 0);
    check('prompt 要求 reason 交代业务值取舍', promptA.indexOf('必须在 reason 里写明') >= 0 && promptA.indexOf('让人来判断是否接受') >= 0);
    check('prompt 不再包含自检反馈章节', promptA.indexOf('## 上一轮结果的问题') < 0);
    check('prompt 禁止绝对路径', promptA.indexOf('禁止绝对路径（从 /html 开始逐层写死）') >= 0);
    check('prompt 下标克制但不禁用', promptA.indexOf('位置下标要克制使用，但不是禁用') >= 0);
    check('prompt 说明下标适用场景', promptA.indexOf('下标适合指向稳定作用域里的第几个同类项') >= 0);
    check('prompt 要求下标写进 reason', promptA.indexOf('必须在 reason 里说明下标指向的稳定结构') >= 0);
    check('prompt 含 XPath 诊断章节', promptA.indexOf('## 当前 XPath 诊断（采集时刻）') >= 0);
    check('prompt 诊断报告命中拾取元素', promptA.indexOf('命中当前拾取的元素') >= 0);
    check('prompt 诊断报告锚点生效', promptA.indexOf('已设置，并已作为当前 XPath 的前缀生效') >= 0);
    check('prompt 诊断规则引用诊断章节', promptA.indexOf('对照「当前 XPath 诊断」修正问题') >= 0);
    const promptNoDiag = buildPrompt(Object.assign({}, contextA, { diagnostics: null }), 'unique', '', '上传发票');
    check('无诊断时不出现诊断章节', promptNoDiag.indexOf('## 当前 XPath 诊断') < 0);
    check('无诊断时不出现诊断规则', promptNoDiag.indexOf('对照「当前 XPath 诊断」修正问题') < 0);

    const noAnchor = Object.assign({}, contextA, { anchor: null });
    const promptC = buildPrompt(noAnchor, 'unique', '', '上传发票');
    check('无锚点时不出现锚点章节', promptC.indexOf('## 用户指定的锚点') < 0);
    check('无锚点时不出现锚点规则', promptC.indexOf('锚点优先：') < 0);
    check('无锚点时候选中 XPath 规则为 12', promptC.indexOf('12. 「当前自动生成的 XPath」只是线索') >= 0);

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
