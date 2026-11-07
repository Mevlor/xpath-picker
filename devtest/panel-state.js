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
          setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 15000);
        });
      },
      close() { try { ws.close(); } catch (e) {} }
    };
  });
}

const httpJson = async (url) => (await fetch(url)).json();

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-state-'));
  const chrome = spawn(CHROME, [
    '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=460,820', '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    '--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT,
    'about:blank'
  ], { stdio: 'ignore' });

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  DEBUG_PORT = await readDebugPort(profile);
  if (!DEBUG_PORT) throw new Error('debug port not ready');
  let browser = null;
  try {
    let version = null;
    for (let i = 0; i < 80; i++) {
      try { version = await httpJson('http://127.0.0.1:' + DEBUG_PORT + '/json/version'); break; } catch (e) { await sleep(250); }
    }
    if (!version) throw new Error('debug port not ready');

    let extId = null;
    for (let i = 0; i < 80 && !extId; i++) {
      const list = await httpJson('http://127.0.0.1:' + DEBUG_PORT + '/json/list');
      for (const target of list.filter((t) => t.type === 'service_worker' && /^chrome-extension:/.test(t.url))) {
        const api = await connect(target.webSocketDebuggerUrl);
        await api.send('Runtime.enable');
        const probe = await api.send('Runtime.evaluate', { expression: 'chrome.runtime.getManifest().name', returnByValue: true });
        if (probe.result && probe.result.value === 'XPath Picker') { extId = new URL(target.url).host; api.close(); break; }
        api.close();
      }
      if (!extId) await sleep(250);
    }
    if (!extId) throw new Error('extension not found');

    browser = await connect(version.webSocketDebuggerUrl);
    const created = await browser.send('Target.createTarget', { url: 'chrome-extension://' + extId + '/sidepanel.html', newWindow: true, width: 400, height: 820 });
    const attached = await browser.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
    const session = attached.sessionId;
    const call = (method, params) => browser.send(method, params, session);
    await call('Page.enable');
    await call('Runtime.enable');
    const pageEval = async (expression) => {
      const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };

    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { ready = await pageEval("document.readyState === 'complete' && typeof applyFrameState === 'function'"); } catch (e) {}
      if (ready) break;
      await sleep(250);
    }
    if (!ready) throw new Error('sidepanel not ready');

    // 面板自己打开的标签页是 chrome-extension://，真实链路会报不支持；这里只测状态收敛
    const state = (extra) => Object.assign({
      picking: false, frozen: false, freezeDeep: false, freezeStats: null, frames: 0,
      anchorMode: null, url: 'https://example.com/', items: []
    }, extra);

    const push = async (payload) => pageEval(`(() => {
      supported = true;
      els.unsupported.hidden = true;
      applyFrameState(0, ${JSON.stringify(payload)});
      return { hint: els.pickHint.textContent, frozen: state.frozen, deep: state.freezeDeep, stats: state.freezeStats, frames: state.frames };
    })()`);

    const deep = await push(state({
      frozen: true, freezeDeep: true, frames: 1,
      freezeStats: { frozen: true, timeouts: 2, intervals: 1, rafs: 0, animations: 1, observers: 0, media: 0 }
    }));
    check('applyFrameState 保留 freezeDeep', deep.deep === true, deep);
    check('applyFrameState 保留 freezeStats', deep.stats && deep.stats.timeouts === 2 && deep.stats.animations === 1, deep.stats);
    check('applyFrameState 保留 frames', deep.frames === 1, deep.frames);
    check('深度冻结时不再提示未加载', /^已深度冻结/.test(deep.hint) && !/未加载/.test(deep.hint), deep.hint);
    check('深度冻结时列出暂停统计', /暂停 2 定时器 \/ 1 轮询 \/ 1 动画/.test(deep.hint), deep.hint);
    check('深度冻结时显示 iframe 数量', /1 个 iframe 同步冻结/.test(deep.hint), deep.hint);

    const deepPicking = await push(state({
      picking: true, frozen: true, freezeDeep: true, frames: 0,
      freezeStats: { frozen: true, timeouts: 1, intervals: 0, rafs: 0, animations: 0, observers: 0, media: 0 }
    }));
    check('冻结 + 拾取时提示可捕获', /拾取中：点击捕获/.test(deepPicking.hint) && !/F8/.test(deepPicking.hint), deepPicking.hint);

    const shallow = await push(state({ frozen: true, freezeDeep: false, frames: 0, freezeStats: null }));
    check('引擎缺失时提示未加载', /深度冻结未加载/.test(shallow.hint), shallow.hint);

    const idle = await push(state({}));
    check('解冻后回到普通提示', !/冻结/.test(idle.hint), idle.hint);

    const noStats = await push(state({ frozen: true, freezeDeep: true, frames: 0, freezeStats: { frozen: true, timeouts: 0, intervals: 0, rafs: 0, animations: 0, observers: 0, media: 0 } }));
    check('无活动任务时给出明确说明', /页面当前没有活动的定时器或动画/.test(noStats.hint), noStats.hint);

    await push(state({
      items: [{
        id: '1', n: 1, color: '#f59e0b', tag: 'td', label: '状态', name: '状态',
        xpath: '//td[1]', origin: null, aiApplied: false, listMode: false, canList: false,
        matchCount: 1, xpathError: null, stale: false, anchorBroken: false,
        facts: [], size: null, anchorHint: '', path: 'table > tbody > tr > td', preview: [],
        relation: null, isRoot: false, isAnchor: false, anchorMarked: false, anchorLabel: '',
        canRoot: false, canParent: true, canChild: false, canPrev: true, canNext: false
      }]
    }));

    const reasonText = '表头文本定位表格，行序号会随列表增删变化。';
    const withReason = await pageEval(`(() => {
      aiOriginal = { name: '状态', xpath: '//td[1]' };
      aiItemId = 1;
      els.aiModal.hidden = false;
      renderTaskInModal({
        itemId: 1, status: 'done', mode: 'unique', name: '订单状态',
        xpath: "//table[.//th[normalize-space(.)='状态']]//tbody/tr[2]/td[1]",
        reason: ${JSON.stringify(reasonText)}
      });
      return { hidden: els.aiReason.hidden, text: els.aiReasonText.textContent, result: els.aiResult.hidden };
    })()`);
    check('AI 结果展示稳定性说明', withReason.hidden === false && withReason.text === reasonText, withReason);
    check('稳定性说明与结果同时可见', withReason.result === false, withReason);

    const noReason = await pageEval(`(() => {
      renderTaskInModal({ itemId: 1, status: 'done', mode: 'unique', name: '订单状态', xpath: '//td[1]' });
      return { hidden: els.aiReason.hidden, text: els.aiReasonText.textContent };
    })()`);
    check('没有说明文本时不显示说明块', noReason.hidden === true && noReason.text === '', noReason);

    const rerun = await pageEval(`(() => {
      renderTaskInModal({ itemId: 1, status: 'running', mode: 'unique', reason: '上一条的说明' });
      return { hidden: els.aiReason.hidden, text: els.aiReasonText.textContent };
    })()`);
    check('重新生成时清空旧说明', rerun.hidden === true && rerun.text === '', rerun);

    const baseItem = {
      id: '1', n: 1, color: '#f59e0b', tag: 'div', label: '订单状态', name: '状态',
      xpath: "//table[.//th[normalize-space(.)='状态']]//tbody/tr[2]/td[1]", origin: null,
      aiApplied: false, listMode: false, canList: false, matchCount: 1, xpathError: null,
      stale: false, anchorBroken: false, facts: [], size: null, anchorHint: '',
      path: 'table > tbody > tr > td', preview: [], relation: null, isRoot: false,
      isAnchor: false, canRoot: false, canParent: true, canChild: false, canPrev: true,
      canNext: false
    };
    const pushItem = async (extra) => {
      await push(state({ items: [Object.assign({}, baseItem, extra)] }));
      return pageEval(`(() => {
        const facts = document.querySelector('.item .facts');
        const nodes = facts ? Array.from(facts.children) : [];
        return {
          chips: nodes.map((node) => node.textContent),
          warn: !!document.querySelector('.item .fact.anchor.warn'),
          badClear: !!document.querySelector('.item button.fact.bad[data-clear-anchor]')
        };
      })()`);
    };

    const anchorIndexed = await pushItem({
      anchorMarked: true, anchorLabel: '订单状态', anchorExpr: "(//div[normalize-space(.)='订单状态'])[2]",
      anchorMatchCount: 1, anchorIndexed: true, anchorApplied: true, anchorSkipped: false, anchorIneffective: false
    });
    check('卡片展示锚点表达式', anchorIndexed.chips.some((text) => /锚点式 \(?\/\/div/.test(text)), anchorIndexed.chips);
    check('下标锚点标黄', anchorIndexed.warn === true, anchorIndexed.chips);
    check('锚点生效时不显示未生效', !anchorIndexed.chips.includes('锚点未生效'), anchorIndexed.chips);

    const anchorDead = await pushItem({
      anchorMarked: true, anchorLabel: '订单状态', anchorExpr: "(//div[normalize-space(.)='订单状态'])[2]",
      anchorMatchCount: 0, anchorIndexed: true, anchorApplied: false, anchorSkipped: false, anchorIneffective: true
    });
    check('锚点未生效时明确提示', anchorDead.chips.includes('锚点未生效'), anchorDead.chips);
    check('未生效提示可一键清锚点', anchorDead.badClear === true, anchorDead.badClear);

    const anchorSkipped = await pushItem({
      anchorMarked: true, anchorLabel: '订单状态', anchorExpr: '//div[@data-row=1]',
      anchorMatchCount: 1, anchorIndexed: false, anchorApplied: false, anchorSkipped: true, anchorIneffective: false
    });
    check('目标自带强身份时说明锚点未参与', anchorSkipped.chips.includes('锚点未参与'), anchorSkipped.chips);
    check('锚点未参与不算未生效', !anchorSkipped.chips.includes('锚点未生效'), anchorSkipped.chips);

    const copyResult = await pageEval(`(() => {
      aiItemId = 1;
      els.aiModal.hidden = false;
      els.aiXpath.value = "//td[@data-testid='status']";
      els.aiName.value = '状态';
      const calls = [];
      const prev = copyText;
      copyText = (text) => calls.push(text);
      els.aiCopy.click();
      copyText = prev;
      return calls;
    })()`);
    check('AI 复制只输出纯 XPath', copyResult.length === 1 && copyResult[0] === "//td[@data-testid='status']", copyResult);

    const aiGuards = await pageEval(`(async () => {
      const prevFetch = window.fetch;
      const prevPrompt = buildPrompt;
      const prevSettings = settings;
      buildPrompt = () => 'prompt';
      settings = Object.assign({}, DEFAULT_SETTINGS, { apiKey: 'test-key' });
      const run = async (fakeFetch) => {
        window.fetch = fakeFetch;
        try { await requestAI({}, { mode: 'unique' }); return ''; }
        catch (e) { return e && e.message; }
      };
      const abortedFetch = await run(async () => { throw new DOMException('aborted', 'AbortError'); });
      const abortedBody = await run(async () => ({ ok: true, status: 200, json: async () => { throw new DOMException('aborted', 'AbortError'); }, text: async () => '' }));
      let fetchCalls = 0;
      settings = Object.assign({}, DEFAULT_SETTINGS);
      const unconfigured = await run(async () => { fetchCalls++; return { ok: true, status: 200, json: async () => ({}) }; });
      settings = Object.assign({}, DEFAULT_SETTINGS, { apiBase: 'http://127.0.0.1:11434/v1', apiKey: '' });
      const localBaseOk = aiConfigError();
      settings = prevSettings;
      window.fetch = prevFetch;
      buildPrompt = prevPrompt;
      return { abortedFetch, abortedBody, unconfigured, fetchCalls, localBaseOk, concurrent: AI_MAX_CONCURRENT };
    })()`);
    check('批量 AI 并发上限为 5', aiGuards.concurrent === 5, aiGuards.concurrent);
    check('连接阶段中断报 60 秒超时', aiGuards.abortedFetch === '请求超时（60 秒），请检查接口地址或稍后重试', aiGuards.abortedFetch);
    check('读取响应体中断也报超时', aiGuards.abortedBody === '请求超时（60 秒），请检查接口地址或稍后重试', aiGuards.abortedBody);
    check('未配置 AI Key 时直接报错且不发请求', aiGuards.unconfigured === '请先在「AI 设置」中填写 API Key' && aiGuards.fetchCalls === 0, aiGuards);
    check('自建地址允许留空 Key', aiGuards.localBaseOk === '', aiGuards.localBaseOk);

    const aiTest = await pageEval(`(async () => {
      const prevFetch = window.fetch;
      const prevSettings = settings;
      const calls = [];
      const setFields = (base, key) => {
        els.apiBase.value = base;
        els.apiKey.value = key;
        els.model.value = 'test-model';
      };
      window.fetch = async (url, init) => {
        calls.push({ url, auth: (init.headers && init.headers.Authorization) || '', model: JSON.parse(init.body).model });
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) };
      };
      setFields('http://127.0.0.1:11434/v1', '');
      await testAIConnection();
      const okText = els.aiTestResult.textContent;
      const okClass = els.aiTestResult.className;
      const runtimeBase = settings.apiBase;
      const stored = await chrome.storage.local.get('xpSettings');
      const saved = stored && stored.xpSettings ? stored.xpSettings : null;
      const before = calls.length;
      setFields('https://api.openai.com/v1', '');
      await testAIConnection();
      const missingText = els.aiTestResult.textContent;
      const missingCalls = calls.length - before;
      window.fetch = prevFetch;
      settings = prevSettings;
      await chrome.storage.local.remove('xpSettings');
      setFields('', '');
      return { okText, okClass, runtimeBase, saved, missingText, missingCalls, calls, button: !!els.testAI };
    })()`);
    check('AI 设置有测试连接按钮', aiTest.button);
    check('测试连接请求 chat/completions 且不带空 Key', aiTest.calls.length === 1 && aiTest.calls[0].url === 'http://127.0.0.1:11434/v1/chat/completions' && aiTest.calls[0].auth === '' && aiTest.calls[0].model === 'test-model', aiTest.calls);
    check('测试连接成功显示耗时并自动保存', aiTest.okClass.indexOf('ok') >= 0 && /^连接正常 · \d+ ms，已保存设置$/.test(aiTest.okText) && aiTest.runtimeBase === 'http://127.0.0.1:11434/v1' && !!aiTest.saved && aiTest.saved.apiBase === 'http://127.0.0.1:11434/v1' && aiTest.saved.apiKey === '' && aiTest.saved.model === 'test-model', { text: aiTest.okText, runtimeBase: aiTest.runtimeBase, saved: aiTest.saved });
    check('未填 Key 时测试连接直接报错不发请求', aiTest.missingCalls === 0 && aiTest.missingText === '请先在「AI 设置」中填写 API Key', aiTest.missingText);

    const matchCopy = await pageEval(`(async () => {
      els.validateView.hidden = false;
      els.validateList.textContent = '';
      const row = matchRow({ index: 1, color: '#4f7cff', tag: 'div', cls: 'Beast__300gW', text: '售后编码：23755054145138 售后类型：补寄…', width: 428, height: 482, visible: true });
      els.validateList.appendChild(row);
      const calls = [];
      let sent = null;
      const prevCopy = copyText;
      const prevSend = sendToFrame;
      copyText = (text, message) => calls.push({ text, message });
      sendToFrame = async (frameId, message) => { sent = message; return { ok: true, text: '售后编码：23755054145138 售后类型：补寄 申请原因：其他原因' }; };
      row.querySelector('.match-copy').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      copyText = prevCopy;
      sendToFrame = prevSend;
      els.validateList.textContent = '';
      els.validateView.hidden = true;
      return { calls, sent };
    })()`);
    check('验证卡片复制请求完整文本', !!matchCopy.sent && matchCopy.sent.type === 'xp:previewText' && matchCopy.sent.index === 0, matchCopy.sent);
    check('验证卡片复制粘贴元素文本', matchCopy.calls.length === 1 && matchCopy.calls[0].text === '售后编码：23755054145138 售后类型：补寄 申请原因：其他原因' && matchCopy.calls[0].message === '已复制文本', matchCopy.calls);

    const cardCopyResult = await pageEval(`(() => {
      const calls = [];
      const prev = copyText;
      copyText = (text) => calls.push(text);
      document.querySelector('.item button[data-act="copy"]').click();
      copyText = prev;
      return calls;
    })()`);
    check('卡片复制只输出纯 XPath', cardCopyResult[0] === "//table[.//th[normalize-space(.)='状态']]//tbody/tr[2]/td[1]", cardCopyResult);

    const batchCopyResult = await pageEval(`(() => {
      const calls = [];
      const prev = copyText;
      copyText = (text) => calls.push(text);
      els.batchCopyBtn.click();
      copyText = prev;
      return calls;
    })()`);
    check('批量复制输出变量名 = XPath', /^状态_唯一 = ".*"$/.test(batchCopyResult[0] || ''), batchCopyResult);

    await push(state({
      items: [
        Object.assign({}, baseItem, { id: '1', n: 1 }),
        Object.assign({}, baseItem, {
          id: '2', n: 2, name: '行', tag: 'tr', 'xpath': '//table//tbody/tr',
          listMode: true, matchCount: 3, path: 'table > tbody > tr'
        })
      ]
    }));
    const batchModes = await pageEval(`(() => {
      const calls = [];
      const prev = copyText;
      copyText = (text) => calls.push(text);
      els.batchCopyBtn.click();
      copyText = prev;
      return calls;
    })()`);
    const modeLines = String(batchModes[0] || '').split('\n');
    check(
      '批量复制按模式加 _唯一/_列表 后缀',
      modeLines.length === 2 &&
        /^状态_唯一 = ".*"$/.test(modeLines[0]) &&
        /^行_列表 = ".*"$/.test(modeLines[1]),
      modeLines
    );

    // 页面刷新/换帧后列表重建，滚动位置按视口顶部那张卡片恢复（v1.28.6）
    const scrollKeep = await pageEval(`(() => {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      const base = ${JSON.stringify(baseItem)};
      const items = Array.from({ length: 10 }, (_, i) => Object.assign({}, base, {
        id: 's' + i, n: i + 1, name: '条目' + (i + 1), pickedAt: 1000 + i
      }));
      const apply = (list) => applyFrameState(0, {
        picking: false, frozen: false, freezeDeep: false, freezeStats: null,
        frames: 0, anchorMode: null, url: 'https://example.com/', items: list
      });
      const topCard = (box) => Array.from(box.children).find(
        (li) => li.offsetTop - box.offsetTop + li.offsetHeight > box.scrollTop + 1
      ).dataset.id;
      supported = true;
      els.unsupported.hidden = true;
      apply(items);
      const box = els.items;
      const max = box.scrollHeight - box.clientHeight;
      box.scrollTop = Math.round(max / 2);
      const before = box.scrollTop;
      const anchorId = topCard(box);
      apply([]);
      apply(items);
      return { before, after: box.scrollTop, max, anchorId, anchorAfter: topCard(box) };
    })()`);
    check(
      '刷新恢复列表后滚动位置留在原处',
      scrollKeep.before > 0 && Math.abs(scrollKeep.after - scrollKeep.before) <= 2 && scrollKeep.after < scrollKeep.max,
      scrollKeep
    );
    check('刷新后视口顶部仍是同一条目', scrollKeep.anchorAfter === scrollKeep.anchorId, scrollKeep);

    // XPath 框 45-110px 随文本自适应（v1.28.7）
    const autoHeight = await pageEval(`(() => {
      const base = ${JSON.stringify(baseItem)};
      const apply = (xpath) => applyFrameState(0, {
        picking: false, frozen: false, freezeDeep: false, freezeStats: null,
        frames: 0, anchorMode: null, url: 'https://example.com/',
        items: [Object.assign({}, base, { id: 'h1', n: 1, name: '长路径', xpath, pickedAt: 2000 })]
      });
      const heightOf = () => els.items.querySelector('.xpath-input').offsetHeight;
      apply([]);
      apply('//div[' + 'c'.repeat(240) + ']');
      const firstLong = heightOf();
      apply('//div[@id="short"]');
      const short = heightOf();
      const box = els.items.querySelector('.xpath-input');
      box.value = '//p[' + 'b'.repeat(240) + ']';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      const typed = box.offsetHeight;
      apply('//div[' + 'a'.repeat(240) + ']');
      const long = heightOf();
      apply('//div[' + 'a'.repeat(2000) + ']');
      const huge = heightOf();
      return { firstLong, short, typed, long, huge };
    })()`);
    check('列表从空到第一条时 XPath 框也自适应', autoHeight.firstLong > autoHeight.short + 10, autoHeight);
    check('输入长文本时 XPath 框实时增高', autoHeight.typed > autoHeight.short + 10, autoHeight);
    check('XPath 框随长文本增高', autoHeight.long > autoHeight.short + 10 && autoHeight.long <= 110, autoHeight);
    check('XPath 框高度上限 110px', autoHeight.huge === 110, autoHeight);

    // 侧栏重新打开/拖动宽度后折行变化，要按新宽度重算（v1.28.9）
    const widthFit = await pageEval(`(async () => {
      const base = ${JSON.stringify(baseItem)};
      applyFrameState(0, {
        picking: false, frozen: false, freezeDeep: false, freezeStats: null,
        frames: 0, anchorMode: null, url: 'https://example.com/',
        items: [Object.assign({}, base, { id: 'w1', n: 1, name: '宽度', xpath: '//div[' + 'a'.repeat(240) + ']', pickedAt: 3000 })]
      });
      const box = els.items.querySelector('.xpath-input');
      const wide = box.offsetHeight;
      els.items.style.width = '220px';
      await new Promise((r) => setTimeout(r, 150));
      const narrow = box.offsetHeight;
      els.items.style.width = '';
      await new Promise((r) => setTimeout(r, 150));
      return { wide, narrow, back: box.offsetHeight };
    })()`);
    check(
      '宽度变化后 XPath 框按新折行重算',
      widthFit.narrow > widthFit.wide && Math.abs(widthFit.back - widthFit.wide) <= 2,
      widthFit
    );
  } catch (e) {
    check('no exception', false, String((e && e.stack) || e));
  } finally {
    const failed = checks.filter((c) => !c.ok);
    console.log(JSON.stringify({ checks, failed: failed.length }, null, 2));
    try { if (browser) browser.close(); } catch (e) {}
    try { chrome.kill(); } catch (e) {}
    await sleep(600);
    for (let i = 0; i < 10; i++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch (e) { await sleep(400); }
    }
    process.exit(failed.length ? 1 : 0);
  }
}

main();
