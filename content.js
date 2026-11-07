(() => {
  'use strict';

  if (window.__XP_PICKER_LOADED__) return;
  window.__XP_PICKER_LOADED__ = true;

  // 子框架也运行同一套逻辑，但只管理本帧文档内的元素与列表；
  // 冻结由 frame-freeze.js 负责，面板状态由顶层汇报
  const IS_TOP = window.top === window;

  const COLORS = [
    '#ff6b6b', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7',
    '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#14b8a6'
  ];
  const MAX_DRAWN_MATCHES = 80;
  const MAX_PREVIEW_MATCHES = 120;
  const ATTR_PRIORITY = [
    'data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy',
    'name', 'aria-label', 'label', 'placeholder', 'title', 'alt', 'role'
  ];
  // 值型属性：内容/状态会随页面操作变化，有锚点时不再当自身身份
  const VALUE_ATTRS = new Set(['title', 'alt', 'placeholder', 'aria-label']);
  const XHTML_NS = 'http://www.w3.org/1999/xhtml';
  const NAME_ATTRS = [
    'data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy',
    'name', 'id', 'aria-label', 'placeholder', 'role'
  ];
  const FACT_ATTRS = [
    'data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy',
    'id', 'name', 'type', 'role', 'aria-label', 'placeholder', 'href', 'title', 'alt'
  ];
  const FREEZE_CSS = `
    *, *::before, *::after {
      animation-play-state: paused !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      scroll-behavior: auto !important;
    }
  `;
  // 冻结期间吞掉页面输入：点击、按键、滚轮、触摸、拖拽、焦点变更都不允许到达页面。
  // 悬停「进入/移动」类事件刻意不拦：拾取高亮靠 mousemove，且 hover 菜单需要能展开；
  // 离开类事件必须拦死，否则已展开的浮层会立刻收起。
  const FROZEN_EVENTS = [
    'click', 'dblclick', 'contextmenu', 'auxclick',
    'mousedown', 'mouseup', 'pointerdown', 'pointerup',
    'mouseout', 'mouseleave', 'pointerout', 'pointerleave', 'dragleave',
    'focus', 'blur', 'focusin', 'focusout',
    'dragstart', 'dragenter', 'dragover', 'drop', 'selectstart',
    'keydown', 'keyup', 'keypress',
    'wheel', 'touchstart', 'touchmove', 'touchend'
  ];

  let picking = false;
  let frozen = false;
  let freezeStats = null;
  let freezeDeep = false;
  let freezeToken = 0;
  let anchorModeId = null;
  let items = [];
  let pickSeq = 0;
  // 页面角标编号由面板跨帧统一分配，内容脚本只负责按 id 映射显示
  let itemNumbers = {};
  // 每次注入生成一个文档标识：面板据此判断帧是否换了新文档，需要重发编号
  const DOC_ID = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  // 用户最近一次拾取的时间戳；恢复快照不算，面板据此判断验证/预览该跟随哪个 frame
  let lastPickAt = 0;
  let hoverEl = null;
  let boxes = [];
  let anchorBoxes = [];
  let previewBoxes = [];
  let previewNodes = [];
  let previewCount = 0;
  // 存下验证的 XPath：页面重渲染替换节点后可以重新查询，不必等用户再次输入
  let previewXPath = '';
  // 验证视图打开时面板会让拾取高亮让位，只保留验证蚂蚁线
  let suppressItemBoxes = false;
  let flashIndex = -1;
  let hoverBox = null;
  let hoverLabel = null;
  let modeChip = null;
  let freezeTint = null;
  let freezeBadge = null;
  let freezeBadgeHint = null;
  let drawScheduled = false;
  let cursorSheet = null;
  let freezeSheet = null;
  let validSignature = null;

  // ---------------- overlay ----------------
  const host = document.createElement('div');
  host.id = '__xp_picker_host__';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';

  const shadow = host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host { all: initial; }
    .xp-box, .xp-hover, .xp-hover-label, .xp-mode, .xp-num { box-sizing: border-box; }
    .xp-box {
      position: fixed;
      display: none;
      z-index: 1;
      border: 2px solid var(--xp-c, #ff6b6b);
      background: var(--xp-bg, rgba(255, 107, 107, .1));
      border-radius: 3px;
      pointer-events: none;
    }
    .xp-num {
      position: absolute;
      top: -20px;
      left: -2px;
      z-index: 2;
      min-width: 18px;
      height: 18px;
      padding: 0 5px 0 6px;
      border-radius: 4px;
      background: var(--xp-c, #ff6b6b);
      color: #fff;
      font: 600 11px/18px "Segoe UI", "Microsoft YaHei", Arial, sans-serif;
      font-variant-numeric: tabular-nums;
      text-align: center;
      text-shadow: 0 1px 2px rgba(0, 0, 0, .35);
      white-space: nowrap;
      box-shadow: 0 1px 3px rgba(0, 0, 0, .3);
    }
    .xp-box.num-below .xp-num {
      top: calc(100% + 2px);
    }
    .xp-box.num-inside .xp-num {
      top: 2px;
      left: 2px;
    }
    .xp-num-sub {
      font-size: 8px;
      font-weight: 500;
      opacity: .8;
      margin-left: 3px;
      vertical-align: 2px;
    }
    .xp-num-rel {
      font-size: 10px;
      font-weight: 500;
      opacity: .9;
    }
    .xp-box.xp-anchor {
      z-index: 0;
      border-width: 1px;
      border-style: dashed;
      background: transparent;
    }
    .xp-box.xp-preview {
      z-index: 3;
      border: 0;
      border-radius: 2px;
      background-color: var(--xp-bg, rgba(79, 124, 255, .08));
      /* 四条边各一层虚线，按周期平移 background-position 形成循环蚂蚁线 */
      background-image:
        repeating-linear-gradient(90deg, var(--xp-c, #4f7cff) 0 6px, transparent 6px 12px),
        repeating-linear-gradient(90deg, var(--xp-c, #4f7cff) 0 6px, transparent 6px 12px),
        repeating-linear-gradient(0deg, var(--xp-c, #4f7cff) 0 6px, transparent 6px 12px),
        repeating-linear-gradient(0deg, var(--xp-c, #4f7cff) 0 6px, transparent 6px 12px);
      background-size: 12px 2px, 12px 2px, 2px 12px, 2px 12px;
      background-position: 0 0, 0 100%, 0 0, 100% 0;
      background-repeat: repeat-x, repeat-x, repeat-y, repeat-y;
      animation: xpPreviewAnts .6s linear infinite;
    }
    @keyframes xpPreviewAnts {
      to {
        background-position: 12px 0, -12px 100%, 0 -12px, 100% 12px;
      }
    }
    .xp-box.xp-preview .xp-num {
      background: var(--xp-c, #4f7cff);
    }
    .xp-box.xp-preview.flash {
      animation: xpPreviewFlash .9s ease-out, xpPreviewAnts .6s linear infinite;
    }
    @keyframes xpPreviewFlash {
      0% { box-shadow: 0 0 0 3px var(--xp-c, #4f7cff); }
      100% { box-shadow: 0 0 0 0 transparent; }
    }
    .xp-anchor-tag {
      position: absolute;
      top: -2px;
      right: -2px;
      height: 16px;
      padding: 0 4px;
      border-radius: 3px;
      background: var(--xp-c, #ff6b6b);
      color: #fff;
      font: 700 10px/16px ui-monospace, SFMono-Regular, Consolas, monospace;
      text-shadow: 0 1px 2px rgba(0, 0, 0, .35);
      white-space: nowrap;
    }
    .xp-hover {
      position: fixed;
      display: none;
      z-index: 5;
      border: 2px dashed #fbbf24;
      background: rgba(251, 191, 36, .1);
      border-radius: 3px;
      pointer-events: none;
    }
    .xp-hover.xp-hover-anchor {
      border-color: #a78bfa;
      background: rgba(167, 139, 250, .12);
    }
    .xp-hover-label {
      position: fixed;
      display: none;
      z-index: 6;
      max-width: 70vw;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 2px 6px;
      border-radius: 4px;
      background: #fbbf24;
      color: #111827;
      font: 600 11px/14px ui-monospace, SFMono-Regular, Consolas, monospace;
      box-shadow: 0 2px 8px rgba(0, 0, 0, .25);
      pointer-events: none;
    }
    .xp-hover-label.xp-hover-anchor {
      background: #a78bfa;
      color: #1e1b4b;
    }
    .xp-mode {
      position: fixed;
      display: none;
      z-index: 7;
      top: 12px;
      left: 50%;
      transform: translateX(-50%);
      padding: 6px 12px;
      border-radius: 999px;
      background: rgba(15, 17, 21, .92);
      border: 1px solid rgba(255, 255, 255, .16);
      color: #f8fafc;
      font: 500 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .35);
      white-space: nowrap;
      pointer-events: none;
    }
    .xp-freeze-tint {
      position: fixed;
      inset: 0;
      display: none;
      z-index: 0;
      background: rgba(15, 17, 21, .3);
      box-shadow: inset 0 0 0 2px rgba(251, 191, 36, .55);
      pointer-events: none;
    }
    .xp-freeze-badge {
      position: fixed;
      display: none;
      z-index: 8;
      top: 12px;
      right: 12px;
      padding: 5px 9px 6px;
      border-radius: 8px;
      background: rgba(15, 17, 21, .92);
      border: 1px solid rgba(251, 191, 36, .55);
      color: #f8fafc;
      font: 500 10px/1.4 "Segoe UI", "Microsoft YaHei", Arial, sans-serif;
      text-align: right;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .35);
      pointer-events: none;
    }
    .xp-freeze-badge b {
      display: block;
      color: #fbbf24;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .08em;
    }
    .xp-freeze-badge span {
      display: block;
      color: #cbd5e1;
      white-space: nowrap;
    }
  `);
  shadow.adoptedStyleSheets = [sheet];

  const layer = document.createElement('div');
  layer.style.cssText = 'position:fixed;inset:0;';
  shadow.appendChild(layer);
  (document.documentElement || document.body).appendChild(host);

  // ---------------- helpers ----------------
  function findItem(id) {
    return items.find((item) => item.id === id) || null;
  }

  function truncate(value, max) {
    const text = String(value == null ? '' : value);
    return text.length > max ? text.slice(0, max) + '…' : text;
  }

  // 裸标签名匹配不到非 XHTML 命名空间元素（//svg 在 HTML 文档里恒为空）
  function xpathTag(el) {
    const tag = el.tagName.toLowerCase();
    return el.namespaceURI && el.namespaceURI !== XHTML_NS
      ? "*[local-name()='" + tag + "']"
      : tag;
  }

  function sanitizeIdentifier(value) {
    let out = String(value == null ? '' : value).trim();
    if (!out) return '';
    try {
      out = out.replace(/[^\p{L}\p{N}_$]+/gu, '_');
    } catch (e) {
      out = out.replace(/[^A-Za-z0-9_$]+/g, '_');
    }
    out = out.replace(/_+/g, '_').replace(/^[\p{N}_]+/u, '').replace(/_+$/u, '');
    return out.slice(0, 40);
  }

  function directText(el) {
    let out = '';
    try {
      for (const node of Array.from(el.childNodes)) {
        if (node.nodeType === 3) out += node.nodeValue || '';
      }
    } catch (e) {}
    return out.replace(/\s+/g, ' ').trim();
  }

  // 先取直接文本节点：容器里的角标（如未读数 0）不能混进变量名
  function shortCjkText(el) {
    let text = directText(el);
    if (!text) {
      try {
        text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      } catch (e) {}
    }
    if (!text || text.length > 8) return '';
    if (!/^[\p{L}\p{N}]+$/u.test(text) || !/[\u4e00-\u9fff]/.test(text)) return '';
    if (valueHasHash(text)) return '';
    return text;
  }

  // 大小写比例失衡的类名多是构建工具生成的随机串（POvAGNG、KChM）
  function looksRandomWord(word) {
    const text = String(word || '');
    if (!text) return false;
    if (isHashedToken(text)) return true;
    let upper = 0;
    let lower = 0;
    for (const ch of text) {
      if (/[A-Z]/.test(ch)) upper++;
      else if (/[a-z]/.test(ch)) lower++;
    }
    if (!upper || !lower) return false;
    return upper / (upper + lower) >= 0.5;
  }

  function headerTextFor(node) {
    if (!node) return '';
    let text = '';
    try {
      text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
    } catch (e) {}
    if (!text || text.length > 10) return '';
    if (!/[\u4e00-\u9fff]/.test(text) || !/^[\p{L}\p{N}]+$/u.test(text)) return '';
    if (valueHasHash(text)) return '';
    return text;
  }

  // 表格单元格按列头命名（订单金额、下单时间），比单元格里的具体值稳定
  function columnHeaderFor(cell) {
    const tag = cell.tagName.toLowerCase();
    if (tag !== 'td' && tag !== 'th') return '';
    for (const id of (cell.getAttribute('headers') || '').split(/\s+/).filter(Boolean)) {
      const text = headerTextFor(document.getElementById(id));
      if (text) return text;
    }
    const index = cell.cellIndex;
    if (index < 0) return '';
    const table = cell.closest('table');
    if (table) {
      const rows = table.querySelectorAll('thead tr');
      for (let i = rows.length - 1; i >= 0; i--) {
        const text = headerTextFor(rows[i].children[index]);
        if (text) return text;
      }
    }
    const grid = cell.closest('[role="grid"], [role="table"]');
    const headRow = grid && grid.querySelector('[role="row"]');
    if (headRow) {
      const headers = Array.from(headRow.children).filter(
        (child) => child.getAttribute('role') === 'columnheader'
      );
      const text = headerTextFor(headers[index]);
      if (text) return text;
    }
    return '';
  }

  // 多格子行容器（role=row 或 data-testid 带 row/grid 的 div）直接按「表格行」命名
  function rowContainerName(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.tagName.toLowerCase() === 'tr') return '';
    if (el.children.length < 3) return '';
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role === 'row') return '表格行';
    return /(^|[-_ ])(row|grid)([-_ ]|$)/i.test(elementSignature(el)) ? '表格行' : '';
  }

  function nameBaseFor(el) {
    if (!el || el.nodeType !== 1) return 'element';
    const tag = el.tagName.toLowerCase();

    const header = columnHeaderFor(el);
    if (header) return header;

    const cjkText = shortCjkText(el);
    if (cjkText) return cjkText;

    const rowName = rowContainerName(el);
    if (rowName) return rowName;

    const attrValues = [];
    for (const attr of NAME_ATTRS) {
      const value = el.getAttribute(attr);
      if (value && value.length <= 48) attrValues.push(value);
    }
    for (const value of attrValues) {
      const word = semanticCjk(value);
      if (word) return word;
    }
    for (const value of attrValues) {
      if (looksLikeStructureValue(value)) continue;
      const word = semanticBase(value);
      if (word) return word;
    }

    const classes = Array.from(el.classList || []).filter(
      (name) => name.length <= 40 && !STYLE_PREFIX.test(name)
    );
    for (let i = classes.length - 1; i >= 0; i--) {
      const word = semanticCjk(classes[i]);
      if (word) return word;
    }
    for (let i = classes.length - 1; i >= 0; i--) {
      if (isStateSegment(classes[i])) continue;
      const word = semanticBase(classes[i]);
      if (word) return word;
    }

    return ROLE_WORDS[tag] || tag;
  }

  const ROLE_WORDS = {
    a: '链接', button: '按钮', img: '图片', input: '输入框', textarea: '输入框',
    select: '下拉框', option: '选项', label: '标签', li: '列表项', tr: '行',
    td: '单元格', th: '表头', h1: '标题', h2: '标题', h3: '标题', h4: '标题',
    h5: '标题', h6: '标题', article: '卡片', section: '区块', nav: '导航',
    ul: '列表', ol: '列表', table: '表格', time: '时间', dt: '标题',
    dd: '内容', summary: '标题', span: '文本', p: '文本', div: '区块',
    i: '图标', svg: '图标', b: '文本', strong: '文本', em: '文本'
  };

  function listScopeFor(el) {
    if (inNavContext(el)) return '导航';
    let node = el.parentElement;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 4) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'table' || tag === 'tbody' || tag === 'thead' || tag === 'tr') return '表格';
      if (tag === 'article') return '卡片';
      node = node.parentElement;
      depth++;
    }
    return '';
  }

  function listNameBase(el) {
    if (!el || el.nodeType !== 1) return '列表';
    const role = ROLE_WORDS[el.tagName.toLowerCase()] || '元素';
    const scope = listScopeFor(el);
    if (!scope) return /列表$|表格$|导航$/.test(role) ? role : role + '列表';
    if (role === '列表' || role === '表格' || role === '导航') return role;
    if (role === '列表项') return scope === '卡片' ? '卡片列表项' : '列表项';
    if (scope === '卡片') return role === '卡片' ? '卡片' : '卡片' + role;
    if (scope === '导航') return role === '链接' ? '导航链接' : '导航' + role;
    if (role === '表头') return '表头';
    if (role === '行' || role === '单元格') return '表格' + role;
    return scope + role;
  }

  function uniqueName(base, id) {
    const used = new Set(
      items.filter((item) => item.id !== id).map((item) => item.name)
    );
    if (!used.has(base)) return base;
    let n = 2;
    while (used.has(base + '_' + n)) n++;
    return base + '_' + n;
  }

  function autoNameFor(el, listMode, id) {
    const raw = listMode ? listNameBase(el) : nameBaseFor(el);
    const base = sanitizeIdentifier(raw) || 'element';
    return uniqueName(base, id);
  }

  function defaultNameFor(el, id) {
    return autoNameFor(el, false, id);
  }

  // ---------------- stability analysis ----------------
  const STYLE_PREFIX = /^(css|sc|jsx|tw|svelte|emotion|styled|jss|ember|ext|radix|headlessui|headless)$/i;
  const GENERIC_WORDS = new Set([
    'container', 'wrapper', 'inner', 'outer', 'root', 'app', 'main', 'content',
    'item', 'row', 'col', 'box', 'grid', 'list', 'section', 'page', 'view',
    'layout', 'block', 'area', 'group', 'panel', 'el', 'div', 'span',
    'input', 'button', 'link', 'icon', 'image', 'img', 'text', 'control', 'field'
  ]);

  // 组件库/设计系统前缀：beast-core-grid-row、auxo-table-cell 这类只描述结构，不能当变量名
  const STRUCTURE_TOKENS = new Set([
    'core', 'base', 'common', 'default', 'primary', 'beast', 'auxo', 'arco',
    'ant', 'antd', 'semi', 'tdesign', 'fusion', 'material', 'mui', 'next',
    'ui', 'kit', 'ds', 'theme', 'style', 'styles', 'v1', 'v2', 'v3'
  ]);

  function looksLikeStructureValue(value) {
    const parts = String(value == null ? '' : value).split(/[-_\s]+/).filter(Boolean);
    if (parts.length < 2) return false;
    let structural = 0;
    for (const part of parts) {
      const word = part.toLowerCase();
      if (GENERIC_WORDS.has(word) || STRUCTURE_TOKENS.has(word)) structural++;
    }
    return structural >= 2;
  }

  function tokenParts(value) {
    const text = String(value == null ? '' : value);
    const parts = [];
    const re = /[\p{L}\p{N}]+/gu;
    let match;
    while ((match = re.exec(text))) {
      parts.push({ text: match[0], start: match.index, end: match.index + match[0].length });
    }
    return parts;
  }

  function isHashedToken(token) {
    const t = String(token || '');
    if (t.length < 4 || /^\d+$/.test(t)) return false;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return true;
    if (/^[0-9a-f]{8,}$/i.test(t) && /\d/.test(t) && /[a-f]/i.test(t)) return true;
    if (t.length >= 16 && /[A-Z]/.test(t) && /[a-z]/.test(t) && /\d/.test(t)) return true;
    if (t.length < 6 || !/^[A-Za-z0-9]+$/.test(t)) return false;
    let flips = 0;
    let caseFlips = 0;
    for (let i = 1; i < t.length; i++) {
      const a = t[i - 1];
      const b = t[i];
      if (/\d/.test(a) !== /\d/.test(b)) flips++;
      if (/[a-z]/.test(a) && /[A-Z]/.test(b)) caseFlips++;
      else if (/[A-Z]/.test(a) && /[a-z]/.test(b)) caseFlips++;
    }
    if (flips >= 2) return true;
    return caseFlips >= 4 && new Set(t).size / t.length >= 0.7;
  }

  function valueHasHash(value) {
    const text = String(value == null ? '' : value);
    if (/(^|[^\w]):r[0-9a-z]+:($|[^\w])/i.test(text)) return true;
    if (/[-_][0-9a-f]{5,}$/i.test(text)) return true;
    return tokenParts(text).some((part) => isHashedToken(part.text));
  }

  function stableWords(value) {
    return tokenParts(value)
      .map((part) => part.text)
      .filter((t) => {
        if (!/[\p{L}]/u.test(t) || isHashedToken(t)) return false;
        return t.length >= 3 || /[\u4e00-\u9fff]/.test(t);
      });
  }

  function semanticBase(value) {
    const words = stableWords(value).filter(
      (word) =>
        !GENERIC_WORDS.has(word.toLowerCase()) &&
        !STRUCTURE_TOKENS.has(word.toLowerCase()) &&
        !looksRandomWord(word)
    );
    if (!words.length) return '';
    return words[words.length - 1];
  }

  function semanticCjk(value) {
    const words = stableWords(value).filter(
      (word) => /[\u4e00-\u9fff]/.test(word) && !GENERIC_WORDS.has(word) && !looksRandomWord(word)
    );
    if (!words.length) return '';
    return words[words.length - 1];
  }

  // 属性值里的自增序号/短哈希，和 class 的 isHashSegment 用同一套阈值：
  // 纯数字 ≥4 位、十六进制 ≥4 位、字母+数字 ≥5 位。只用于属性值，不用于可见文本。
  function isDynamicAttrToken(token) {
    const t = String(token || '');
    return /\d/.test(t) && isHashSegment(t);
  }

  function attrExpressions(tag, name, value) {
    const text = String(value == null ? '' : value);
    const out = [];
    if (!text || text.length > 120 || /^\d+$/.test(text)) return out;
    const dynamic = valueHasHash(text) || tokenParts(text).some((part) => isDynamicAttrToken(part.text));
    if (!dynamic) {
      out.push('//' + tag + '[@' + name + '=' + xpLiteral(text) + ']');
      return out;
    }
    const parts = tokenParts(text);
    const first = parts.find((part) => isHashedToken(part.text) || isDynamicAttrToken(part.text));
    if (first && first.start > 0) {
      const prefix = text.slice(0, first.start).replace(/[^\p{L}\p{N}]+$/u, '');
      const head = prefix.split(/[^\p{L}\p{N}]+/u)[0] || '';
      if (prefix.length >= 4 && !STYLE_PREFIX.test(head)) {
        out.push('//' + tag + '[starts-with(@' + name + ',' + xpLiteral(prefix) + ')]');
      }
    }
    const words = stableWords(text)
      .filter((word) => word.length >= 4 && !/\d/.test(word) && !GENERIC_WORDS.has(word.toLowerCase()))
      .sort((a, b) => b.length - a.length);
    for (const word of words) {
      if (STYLE_PREFIX.test(word)) continue;
      out.push('//' + tag + '[contains(@' + name + ',' + xpLiteral(word) + ')]');
      if (out.length >= 3) break;
    }
    return out;
  }

  // mode: 'strong' 跳过值型属性 / 'weak' 只取值型属性 / 缺省取全部
  function selfCandidates(el, mode) {
    const out = [];
    const seen = new Set();
    const push = (expr) => {
      if (!expr || seen.has(expr)) return;
      seen.add(expr);
      out.push(expr);
    };
    const wantStrong = mode !== 'weak';
    const wantWeak = mode !== 'strong';
    const tag = xpathTag(el);
    if (wantStrong && el.id) attrExpressions('*', 'id', el.id).forEach(push);
    for (const name of ATTR_PRIORITY) {
      if (VALUE_ATTRS.has(name) ? !wantWeak : !wantStrong) continue;
      const value = el.getAttribute(name);
      if (!value) continue;
      if (name === 'label' && looksLikeDataText(value)) continue;
      attrExpressions(tag, name, value).forEach(push);
    }
    if (wantStrong) {
      try {
        for (const attr of Array.from(el.attributes)) {
          const name = attr.name;
          if (name === 'id' || name === 'class' || name === 'style' || /^on/i.test(name)) continue;
          if (ATTR_PRIORITY.includes(name)) continue;
          if (!/^(data|aria)-/i.test(name)) continue;
          if (/^data-v-|^data-react|^data-n-head/i.test(name)) continue;
          if (/^aria-(expanded|selected|checked|hidden|current|pressed|disabled|busy|live|valuenow|valuemin|valuemax)$/i.test(name)) continue;
          if (/^data-(state|active|selected|checked|open|closed|disabled)$/i.test(name)) continue;
          if (!attr.value || attr.value.length > 120) continue;
          attrExpressions(tag, name, attr.value).forEach(push);
        }
      } catch (e) {}
    }
    return out;
  }

  const DATA_WORDS = /(^|[-_ ])(product|goods|item|card|list|cell|row|result|entry|post|article|sku|offer|order|record|comment|review|price|detail|feed)([-_ ]|$)/i;
  const STRONG_DATA_WORDS = /(^|[-_ ])(product|goods|sku|offer|price|detail|order|record|comment|review)([-_ ]|$)/i;
  const NAV_WORDS = /(^|[-_ ])(nav|menu|tab|breadcrumb|pagination|footer|sidebar)([-_ ]|$)/i;

  function elementSignature(el) {
    const cls = typeof el.className === 'string' ? el.className : '';
    return [el.id, el.getAttribute('data-testid') || '', cls]
      .join(' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase();
  }

  function inNavContext(el) {
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 4) {
      if (/^(nav|header|footer)$/i.test(node.tagName)) return true;
      const role = node.getAttribute('role') || '';
      if (/^(navigation|menu|menubar|tablist|banner|contentinfo)$/i.test(role)) return true;
      const sig = elementSignature(node);
      if (NAV_WORDS.test(sig) && !DATA_WORDS.test(sig)) return true;
      node = node.parentElement;
      depth++;
    }
    return false;
  }

  function hasRepeatedSiblings(el) {
    const parent = el.parentElement;
    if (!parent) return false;
    const same = Array.from(parent.children).filter((child) => child.tagName === el.tagName);
    return same.length >= 2;
  }

  function textInDataContainer(el) {
    let node = el.parentElement;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 5) {
      if (node.tagName === 'ARTICLE' || node.tagName === 'TR') return true;
      const sig = elementSignature(node);
      const nav = inNavContext(node) || NAV_WORDS.test(sig);
      if (!nav && (STRONG_DATA_WORDS.test(sig) || (hasRepeatedSiblings(node) && (node.tagName === 'LI' || DATA_WORDS.test(sig))))) {
        return true;
      }
      node = node.parentElement;
      depth++;
    }
    return false;
  }

  // 按钮/链接等交互控件里的文字是界面固定文案，即使嵌套在表格行里也不是业务数据
  function inControlContext(el) {
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 3) {
      if (/^(BUTTON|A|LABEL|TH|SUMMARY|OPTION|LEGEND)$/.test(node.tagName)) return true;
      const role = node.getAttribute('role') || '';
      if (/^(button|link|tab|menuitem|option|switch|checkbox|radio)$/i.test(role)) return true;
      node = node.parentElement;
      depth++;
    }
    return false;
  }

  function isUiLabel(el) {
    if (/^(A|BUTTON|LABEL|TH|SUMMARY|DT|OPTION|LEGEND)$/.test(el.tagName)) return true;
    const role = el.getAttribute('role') || '';
    if (/^(button|link|tab|menuitem|option|switch|checkbox|radio)$/i.test(role)) return true;
    if (inControlContext(el)) return true;
    return inNavContext(el);
  }

  function looksLikeDataText(text) {
    const value = String(text == null ? '' : text).trim();
    if (!value) return false;
    if (/\d{3,}/.test(value)) return true;
    if (/[¥$€£]\s?\d/.test(value)) return true;
    if (/\d{4}[-/.年]\d{1,2}/.test(value)) return true;
    return false;
  }

  function textIsStable(el, text) {
    if (!text || text.length < 2 || text.length > 16) return false;
    if (/[\d¥$€£%]/.test(text) || valueHasHash(text)) return false;
    if (!/^[\p{L}\p{N} ·\-_/&]+$/u.test(text)) return false;
    if (el.tagName === 'H1') return false;
    if (isUiLabel(el)) return true;
    return !textInDataContainer(el);
  }

  function stableText(el) {
    let text = '';
    try {
      text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    } catch (e) {}
    return textIsStable(el, text) ? text : '';
  }

  function textCandidates(el) {
    const text = stableText(el);
    if (!text) return [];
    return ['//' + xpathTag(el) + '[normalize-space(.)=' + xpLiteral(text) + ']'];
  }

  // 文本重复（多行同款按钮）时，用 class 与文本的交集收窄
  function textClassCandidates(el) {
    const text = stableText(el);
    if (!text) return [];
    const cls = analyzeClass(el);
    if (!cls.predicate) return [];
    return ['//' + xpathTag(el) + '[' + cls.predicate + '][normalize-space(.)=' + xpLiteral(text) + ']'];
  }

  const SEMANTIC_ROLES = new Set([
    'tab', 'tablist', 'tabpanel', 'dialog', 'alertdialog', 'menu', 'menubar', 'menuitem',
    'navigation', 'tree', 'treeitem', 'grid', 'gridcell', 'row', 'listbox', 'option',
    'search', 'form', 'region', 'toolbar', 'table', 'columnheader', 'rowheader', 'banner', 'main'
  ]);

  // 从复合 id 里取最后一段语义片段：rc-tabs-0-tab-/ffa/saas/platform-invoice → platform-invoice
  function idTailFragment(id) {
    const text = String(id || '').trim();
    if (!text || text.length > 160) return '';
    const parts = text
      .split(/[/:#.\s_]+/)
      .map((part) => part.replace(/^-+|-+$/g, ''))
      .filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (part.length < 4 || part.length > 40) continue;
      if (!/[\p{L}]/u.test(part)) continue;
      if (!/^[\p{L}\p{N}-]+$/u.test(part)) continue;
      if (/\d$/.test(part)) continue;
      if (valueHasHash(part) || isHashedToken(part)) continue;
      if (GENERIC_WORDS.has(part.toLowerCase())) continue;
      return part;
    }
    return '';
  }

  function semanticPrefix(node) {
    const tag = xpathTag(node);
    const role = String(node.getAttribute('role') || '').trim().toLowerCase();
    const semanticRole = SEMANTIC_ROLES.has(role) ? role : '';
    const fragment = idTailFragment(node.id);
    if (semanticRole && fragment) {
      return (
        '//' + tag + "[@role='" + semanticRole + "' and contains(@id," + xpLiteral(fragment) + ')]'
      );
    }
    if (semanticRole) return '//' + tag + "[@role='" + semanticRole + "']";
    if (fragment) return '//' + tag + '[contains(@id,' + xpLiteral(fragment) + ')]';
    return '';
  }

  // 语义祖先 + 文本终点：//div[@role='tab' and contains(@id,'...')]//span[normalize-space(.)='...']
  function contextualTextCandidates(el) {
    const text = stableText(el);
    if (!text) return [];
    const terminal = '//' + xpathTag(el) + '[normalize-space(.)=' + xpLiteral(text) + ']';
    const out = [];
    let node = el.parentElement;
    let depth = 0;
    while (node && node.nodeType === 1 && node !== document.body && depth < 4) {
      const prefix = semanticPrefix(node);
      if (prefix) {
        out.push(prefix + terminal);
        if (out.length >= 2) break;
      }
      node = node.parentElement;
      depth++;
    }
    return out;
  }

  function matchesOnly(xpath, el) {
    if (!xpath) return false;
    const result = evaluateXPath(xpath, 2);
    return !result.error && result.count === 1 && result.nodes[0] === el;
  }

  function firstMatching(candidates, el) {
    for (const expr of candidates) {
      if (matchesOnly(expr, el)) return expr;
    }
    return '';
  }

  function stepsFromAncestor(ancestor, el) {
    const steps = [];
    let node = el;
    while (node && node !== ancestor) {
      if (node.nodeType !== 1) return null;
      let seg = xpathTag(node);
      const parent = node.parentElement;
      if (!parent) return null;
      const same = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
      if (same.length > 1) seg += '[' + (same.indexOf(node) + 1) + ']';
      steps.unshift(seg);
      node = parent;
    }
    return node === ancestor ? steps : null;
  }

  function absolutePath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      let seg = xpathTag(node);
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (same.length > 1) seg += '[' + (same.indexOf(node) + 1) + ']';
      }
      parts.unshift(seg);
      node = node.parentElement;
    }
    return '/' + parts.join('/');
  }

  // 结构根：强身份优先；没有 id/data-* 时退到「class 唯一」的容器——class 同样是稳定结构
  function stableRootExpr(node) {
    return firstMatching(selfCandidates(node), node) || classUniqueExpr(node);
  }

  function structuralPath(el) {
    let node = el.parentElement;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 8) {
      const rootExpr = stableRootExpr(node);
      if (rootExpr) {
        const steps = stepsFromAncestor(node, el);
        if (steps && steps.length) {
          const path = rootExpr + '/' + steps.join('/');
          if (matchesOnly(path, el)) return path;
        }
      }
      node = node.parentElement;
      depth++;
    }
    return '';
  }

  function terminalStep(el) {
    const tag = xpathTag(el);
    const parent = el.parentElement;
    if (!parent) return tag;
    const same = Array.from(parent.children).filter((child) => child.tagName === el.tagName);
    return same.length > 1 ? tag + '[' + (same.indexOf(el) + 1) + ']' : tag;
  }

  // 稳定祖先 + 后代轴：跳过中间包裹层，抗页面加壳/减壳
  function elasticPath(el) {
    const step = terminalStep(el);
    let node = el.parentElement;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 8) {
      const rootExpr = stableRootExpr(node);
      if (rootExpr) {
        const path = rootExpr + '//' + step;
        if (matchesOnly(path, el)) return path;
      }
      node = node.parentElement;
      depth++;
    }
    return '';
  }

  function pathFragility(expr) {
    if (!expr) return Infinity;
    const indexes = (expr.match(/\[\d+\]/g) || []).length;
    const steps = (expr.match(/\//g) || []).length;
    return indexes * 4 + steps;
  }

  function betterPath(a, b) {
    if (!a) return b;
    if (!b) return a;
    return pathFragility(b) < pathFragility(a) ? b : a;
  }

  // 没有稳定身份的单元格：用「表头文本定位表格 + 行/列序号」代替 /html/... 绝对路径
  function tableCellPath(el) {
    if (!el || el.tagName.toLowerCase() !== 'td') return '';
    const header = columnHeaderFor(el);
    if (!header) return '';
    const table = el.closest('table');
    if (!table) return '';
    const row = el.parentElement;
    const body = row && row.parentElement;
    if (!row || !body) return '';
    if (row.tagName.toLowerCase() !== 'tr' || body.tagName.toLowerCase() !== 'tbody') return '';
    const rows = Array.from(body.children).filter((child) => child.tagName === row.tagName);
    const rowIndex = rows.indexOf(row) + 1;
    const cells = Array.from(row.children).filter((child) => child.tagName === el.tagName);
    const cellIndex = cells.indexOf(el) + 1;
    if (rowIndex < 1 || cellIndex < 1) return '';
    const expr =
      '//table[.//th[normalize-space(.)=' + xpLiteral(header) + ']]//tbody/tr[' +
      rowIndex + ']/td[' + cellIndex + ']';
    return matchesOnly(expr, el) ? expr : '';
  }

  function nearSiblings(el, radius) {
    const out = [];
    let node = el.previousElementSibling;
    for (let i = 0; node && i < radius; i++) {
      out.push(node);
      node = node.previousElementSibling;
    }
    node = el.nextElementSibling;
    for (let i = 0; node && i < radius; i++) {
      out.push(node);
      node = node.nextElementSibling;
    }
    return out;
  }

  function referenceExprFor(el) {
    return firstMatching(selfCandidates(el), el);
  }

  // 锚点基表达式：强属性 → 文本 → class+文本 → 稳定祖先+文本 → 弱属性 → 结构/class → 文本下标 → 绝对路径
  function anchorExprFor(anchor) {
    if (!anchor) return '';
    return (
      firstMatching(selfCandidates(anchor, 'strong'), anchor) ||
      firstMatching(anchorTextCandidates(anchor), anchor) ||
      anchorClassTextExpr(anchor) ||
      firstMatching(anchorContextTextCandidates(anchor), anchor) ||
      firstMatching(selfCandidates(anchor, 'weak'), anchor) ||
      indexedAnchorTextExpr(anchor) ||
      structuralPath(anchor) ||
      classUniqueExpr(anchor) ||
      absolutePath(anchor)
    );
  }

  // 锚点常是表单标签：内/外部文本都收，短且非数据即可，不受「数据容器」启发式限制
  function anchorTexts(el) {
    const out = [];
    const pushText = (value) => {
      const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
      if (!text || text.length < 2 || text.length > 24) return;
      if (!/[\p{L}]/u.test(text)) return;
      if (looksLikeDataText(text) || valueHasHash(text)) return;
      if (!out.includes(text)) out.push(text);
    };
    try { pushText(el.innerText); } catch (e) {}
    try { pushText(el.textContent); } catch (e) {}
    return out;
  }

  function anchorTextCandidates(el) {
    const tag = xpathTag(el);
    const texts = anchorTexts(el);
    const out = [];
    const seen = new Set();
    const push = (expr) => {
      if (!expr || seen.has(expr)) return;
      seen.add(expr);
      out.push(expr);
    };
    for (const text of texts) {
      const lit = xpLiteral(text);
      push('//' + tag + '[normalize-space(.)=' + lit + ']');
      push('//' + tag + '[normalize-space(text())=' + lit + ']');
    }
    if (texts.length) push('//' + tag + '[starts-with(normalize-space(.),' + xpLiteral(texts[0]) + ')]');
    return out;
  }

  function anchorClassTextExpr(el) {
    const texts = anchorTexts(el);
    if (!texts.length) return '';
    const tag = xpathTag(el);
    for (const seg of stepClassSegments(el)) {
      for (const text of texts) {
        const lit = xpLiteral(text);
        const pred = classPredicateFor(el, seg);
        const exact = '//' + tag + '[' + pred + ' and normalize-space(.)=' + lit + ']';
        if (matchesOnly(exact, el)) return exact;
        const prefix = '//' + tag + '[' + pred + ' and starts-with(normalize-space(.),' + lit + ')]';
        if (matchesOnly(prefix, el)) return prefix;
      }
    }
    return '';
  }

  function anchorContextTextCandidates(el) {
    const texts = anchorTexts(el);
    if (!texts.length) return [];
    const tag = xpathTag(el);
    const out = [];
    let node = el.parentElement;
    let depth = 0;
    while (node && node.nodeType === 1 && node !== document.body && depth < 5) {
      const prefix = firstMatching(selfCandidates(node, 'strong'), node);
      if (prefix) {
        for (const text of texts.slice(0, 2)) {
          out.push(prefix + '//' + tag + '[normalize-space(.)=' + xpLiteral(text) + ']');
        }
      }
      node = node.parentElement;
      depth++;
    }
    return out;
  }

  // 同名标签多处出现时，仍用文本定位，按文档顺序取对应下标
  function indexedAnchorTextExpr(el) {
    const tag = xpathTag(el);
    for (const text of anchorTexts(el)) {
      const exprs = [
        '//' + tag + '[normalize-space(.)=' + xpLiteral(text) + ']',
        '//' + tag + '[normalize-space(text())=' + xpLiteral(text) + ']'
      ];
      for (const expr of exprs) {
        const result = evaluateXPath(expr, 9);
        if (result.error || result.count < 2 || result.count > 8) continue;
        const index = result.nodes.indexOf(el) + 1;
        if (index > 0) return '(' + expr + ')[' + index + ']';
      }
    }
    return '';
  }

  function referencePathTo(ref, el, expr, opts) {
    if (!ref || !el || ref === el || !ref.isConnected || !el.isConnected) return '';
    const base = expr || referenceExprFor(ref);
    if (!base) return '';
    const chain = new Map();
    let node = ref;
    let up = 0;
    while (node) {
      chain.set(node, up++);
      node = node.parentElement;
    }
    let common = el;
    while (common && !chain.has(common)) common = common.parentElement;
    if (!common) return '';
    const upSteps = chain.get(common);
    const downSteps =
      opts && opts.conditional
        ? conditionalStepsFrom(common, el, !!opts.valueNode)
        : stepsFromAncestor(common, el);
    if (!downSteps || upSteps + downSteps.length > 8) return '';
    let path = base;
    for (let i = 0; i < upSteps; i++) path += '/..';
    if (downSteps.length) path += '/' + downSteps.join('/');
    return matchesOnly(path, el) ? path : '';
  }

  const VALUE_CLASS_RE = /(selection-item|selected-value|select-value|current-value|selection-value|current-selection)/i;
  const SELECT_CONTAINER_RE = /(^|[-_ ])(select|selector|combobox|dropdown)([-_ ]|$)/i;

  // 当前值展示节点（如 Select 的 auxo-select-selection-item）：自身文本/标题随用户操作变化，不能当身份
  function isValueDisplay(el) {
    if (!el || el.nodeType !== 1) return false;
    if (VALUE_CLASS_RE.test(el.getAttribute('class') || '')) return true;
    if (!el.hasAttribute('title')) return false;
    let node = el.parentElement;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 4) {
      if (SELECT_CONTAINER_RE.test(node.getAttribute('class') || '')) return true;
      const role = node.getAttribute('role') || '';
      if (role === 'combobox' || role === 'listbox') return true;
      node = node.parentElement;
      depth++;
    }
    return false;
  }

  const STEP_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'name', 'role', 'type'];

  function stepClassSegments(el) {
    const out = [];
    for (const token of (el.getAttribute('class') || '').split(/\s+/).filter(Boolean)) {
      for (const seg of tokenSegments(token)) {
        if (!seg || out.includes(seg)) continue;
        if (isHashSegment(seg) || valueHasHash(seg) || STYLE_PREFIX.test(seg)) continue;
        if (isStateSegment(seg)) continue;
        if (!stableWords(seg).length) continue;
        out.push(seg);
      }
    }
    out.sort((a, b) => classSemanticScore(b) - classSemanticScore(a) || a.length - b.length);
    return out;
  }

  // 单步条件：属性 → class → 文本，都不唯一才退回下标；值型节点禁用文本
  function stableStep(node, valueNode) {
    const parent = node.parentElement;
    if (!parent) return '';
    const tag = xpathTag(node);
    const same = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
    if (same.length === 1) return tag;
    if (!valueNode) {
      for (const name of STEP_ATTRS) {
        const value = node.getAttribute(name);
        if (!value || value.length > 60 || valueHasHash(value)) continue;
        if (same.filter((peer) => peer.getAttribute(name) === value).length !== 1) continue;
        return tag + '[@' + name + '=' + xpLiteral(value) + ']';
      }
      const text = stableText(node);
      if (text) {
        const peers = same.filter((peer) => stableText(peer) === text);
        if (peers.length === 1) return tag + '[normalize-space(.)=' + xpLiteral(text) + ']';
      }
    }
    for (const seg of stepClassSegments(node)) {
      if (same.filter((peer) => isFullTokenClass(peer, seg)).length !== 1) continue;
      return tag + '[' + classPredicateFor(node, seg) + ']';
    }
    return tag + '[' + (same.indexOf(node) + 1) + ']';
  }

  function conditionalStepsFrom(ancestor, el, valueNode) {
    const steps = [];
    let node = el;
    while (node && node !== ancestor) {
      if (node.nodeType !== 1) return null;
      const step = stableStep(node, valueNode && node === el);
      if (!step) return null;
      steps.unshift(step);
      node = node.parentElement;
    }
    if (node !== ancestor) return null;
    return steps;
  }

  // 值型节点优先：锚点 → 最近的公共容器 → 值节点的稳定 class
  function valueAnchorPath(anchor, el, base) {
    const chain = new Map();
    let node = anchor;
    let ups = 0;
    while (node) {
      chain.set(node, ups++);
      node = node.parentElement;
    }
    let scope = el.parentElement;
    while (scope && !chain.has(scope)) scope = scope.parentElement;
    if (!scope) return '';
    const upSteps = chain.get(scope);
    if (upSteps > 4) return '';
    const cls = analyzeClass(el);
    if (!cls.predicate) return '';
    let expr = base;
    for (let i = 0; i < upSteps; i++) expr += '/..';
    const path = expr + '//' + xpathTag(el) + '[' + cls.predicate + ']';
    return matchesOnly(path, el) ? path : '';
  }

  // 唯一模式锚点路径：锚点必先生效，下行优先条件步，拼不出才用结构步
  function anchoredPathTo(anchor, el) {
    if (!anchor || !el || anchor === el || !anchor.isConnected || !el.isConnected) return '';
    const base = anchorExprFor(anchor);
    if (!base) return '';
    const valueNode = isValueDisplay(el);
    if (valueNode) {
      const scoped = valueAnchorPath(anchor, el, base);
      if (scoped) return scoped;
    }
    if (anchor.contains(el)) {
      const steps = conditionalStepsFrom(anchor, el, valueNode);
      if (steps && steps.length) {
        const path = base + '/' + steps.join('/');
        if (matchesOnly(path, el)) return path;
      }
    }
    return (
      referencePathTo(anchor, el, base, { conditional: true, valueNode }) ||
      anchoredStructuralPath(anchor, el, base)
    );
  }

  // 锚点强制作用域的第二档：条件步拼不出时，用锚点 + 结构步（放宽层数，路径仍在锚点作用域内）
  function anchoredStructuralPath(anchor, el, base) {
    if (!anchor || !el || !base || !anchor.isConnected || !el.isConnected) return '';
    const chain = new Map();
    let node = anchor;
    let up = 0;
    while (node) {
      chain.set(node, up++);
      node = node.parentElement;
    }
    let common = el;
    while (common && !chain.has(common)) common = common.parentElement;
    if (!common) return '';
    const upSteps = chain.get(common);
    const downSteps = stepsFromAncestor(common, el);
    if (!downSteps || upSteps + downSteps.length > 20) return '';
    let path = base;
    for (let i = 0; i < upSteps; i++) path += '/..';
    if (downSteps.length) path += '/' + downSteps.join('/');
    return matchesOnly(path, el) ? path : '';
  }

  function referenceCandidates(el) {
    const out = [];
    const parent = el.parentElement;
    if (!parent || !parent.parentElement) return out;
    const refs = [];
    for (const sib of nearSiblings(el, 2)) refs.push(sib);
    for (const uncle of nearSiblings(parent, 2)) {
      refs.push(uncle);
      for (const cousin of Array.from(uncle.children).slice(0, 3)) refs.push(cousin);
    }
    for (const ref of refs) {
      const path = referencePathTo(ref, el);
      if (path) out.push(path);
      if (out.length >= 3) break;
    }
    return out;
  }

  // 深度放宽：设计系统常有 button > 4 层 div > td 这种嵌套，6 层到不了重复行
  function hasRepeatedAncestor(el) {
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && node !== document.body && depth < 12) {
      const parent = node.parentElement;
      if (
        parent &&
        parent !== document.body &&
        parent !== document.documentElement &&
        Array.from(parent.children).filter((c) => c.tagName === node.tagName).length >= 2
      ) {
        return true;
      }
      node = parent;
      depth++;
    }
    return false;
  }

  const CLASS_SEMANTIC_WORDS = new Set([
    'submit', 'login', 'logout', 'search', 'filter', 'delete', 'edit', 'save', 'close', 'open',
    'user', 'profile', 'menu', 'nav', 'header', 'footer', 'button', 'btn', 'input', 'form',
    'select', 'option', 'dropdown', 'modal', 'dialog', 'alert', 'notification', 'toast',
    'tab', 'panel', 'card', 'list', 'item', 'row', 'cell', 'table', 'field', 'label', 'title',
    'content', 'text', 'link', 'icon', 'image', 'video', 'audio', 'avatar', 'badge', 'tag', 'price'
  ]);
  const CLASS_BOILERPLATE = /^(sc|css|jsx|emotion|chakra|mui|ant|ng|sb|styled|styles|style)$/i;
  const classCache = new WeakMap();

  // 状态类名随交互变化（hover/active/open…），既不能当元素身份，也不能当变量名
  const STATE_WORDS = new Set([
    'hover', 'hovered', 'hovering', 'active', 'activated', 'selected', 'checked',
    'unchecked', 'focus', 'focused', 'current', 'disabled', 'enabled', 'open',
    'opened', 'closed', 'expanded', 'collapsed', 'pressed', 'loading', 'loaded',
    'highlight', 'highlighted', 'show', 'shown', 'hide', 'hidden', 'visible',
    'invisible', 'dragging', 'dragover', 'dragenter', 'visited', 'readonly',
    'indeterminate', 'clicked', 'touched', 'entered', 'leaving', 'error',
    'warning', 'success', 'danger'
  ]);

  function classWords(segment) {
    return String(segment == null ? '' : segment)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }

  // 整段是状态词，或最后一个词是状态词（auxo-table-cell-row-hover、is-open）
  function isStateSegment(segment) {
    const raw = String(segment == null ? '' : segment).toLowerCase();
    if (!raw) return false;
    if (STATE_WORDS.has(raw)) return true;
    const words = classWords(segment);
    return words.length > 1 && STATE_WORDS.has(words[words.length - 1]);
  }

  function classSemanticScore(seg) {
    if (!seg || isHashSegment(seg) || isStateSegment(seg)) return 0;
    const lower = seg.toLowerCase();
    if (/(close|open|submit|login|search|filter|delete|edit|save|add)/.test(lower)) return 100;
    if (/(wrapper|container|input|button|form|field|list|item|tab|nav|panel|card)/.test(lower)) return 80;
    if (CLASS_SEMANTIC_WORDS.has(lower)) return 60;
    if (/^[a-z]+(-[a-z0-9]+)+$/.test(seg) && seg.length <= 24) return 45;
    return 0;
  }

  function isHashSegment(segment) {
    if (!segment) return false;
    const raw = String(segment);
    const lower = raw.toLowerCase();
    if (CLASS_BOILERPLATE.test(lower)) return true;
    if (lower.length < 3) return false;
    if (/^\d+$/.test(lower) && lower.length >= 4) return true;
    if (/^[0-9a-f]+$/.test(lower) && lower.length >= 4) return true;
    if (/^[a-z0-9]+$/.test(lower) && /\d/.test(lower) && lower.length >= 5) return true;
    if (isHashedToken(lower)) return true;
    if (/^[a-z]+$/.test(lower) && lower.length >= 5 && lower.length <= 10) {
      let upper = raw[0] === raw[0].toUpperCase();
      let flips = 0;
      for (let i = 1; i < raw.length; i++) {
        const nowUpper = raw[i] === raw[i].toUpperCase();
        if (nowUpper !== upper) {
          flips++;
          upper = nowUpper;
        }
      }
      if (flips / (raw.length - 1) >= 0.6) return true;
    }
    return false;
  }

  // 按 -/_ 切分；在第一个数字处剥哈希后缀；驼峰标识保持完整
  function splitClassToken(token) {
    const parts = String(token).split(/[-_]+/);
    const segs = [];
    for (const part of parts) {
      if (!part) continue;
      const digitAt = part.search(/[0-9]/);
      if (digitAt > 0) {
        const lead = part.slice(0, digitAt).replace(/[A-Z]$/, '');
        const tail = part.slice(digitAt);
        if (tail.length >= 4 && lead.length >= 2) {
          segs.push(lead, tail);
          continue;
        }
      }
      segs.push(part);
    }
    return segs;
  }

  // 纯语义 token 整词保留，避免 contains('no') 误中 info/normal 这类子串
  function tokenSegments(token) {
    const segs = splitClassToken(token);
    for (const seg of segs) {
      if (isHashSegment(seg)) return segs;
    }
    return [token];
  }

  function isFullTokenClass(el, seg) {
    const cls = el.getAttribute('class') || '';
    return cls.split(/\s+/).filter(Boolean).includes(seg);
  }

  function classPredicateFor(el, seg) {
    return isFullTokenClass(el, seg)
      ? "contains(concat(' ', normalize-space(@class), ' '), " + xpLiteral(' ' + seg + ' ') + ')'
      : 'contains(@class, ' + xpLiteral(seg) + ')';
  }

  // 同父同标签兄弟 + 叔伯下的同标签子节点，用于判断哪些 class 段是模块常量
  function findSiblingInstances(el) {
    const tag = el.tagName;
    const set = [];
    const add = (node) => {
      if (node && node !== el && set.indexOf(node) < 0) set.push(node);
    };
    const parent = el.parentElement;
    if (parent) {
      for (const child of Array.from(parent.children)) {
        if (set.length >= 16) break;
        if (child.tagName === tag) add(child);
      }
    }
    const grand = parent && parent.parentElement;
    if (grand) {
      for (const uncle of Array.from(grand.children)) {
        if (uncle === parent) continue;
        for (const child of Array.from(uncle.children)) {
          if (set.length >= 16) break;
          if (child.tagName === tag) add(child);
        }
      }
    }
    return set;
  }

  function analyzeClass(el) {
    const cls = el.getAttribute('class') || '';
    const cached = classCache.get(el);
    if (cached && cached.cls === cls) return cached.result;
    const result = computeClass(el);
    classCache.set(el, { cls, result });
    return result;
  }

  function computeClass(el) {
    const clsAttr = el.getAttribute('class');
    if (!clsAttr) return { predicate: null, segments: [] };
    const tokens = clsAttr.split(/\s+/).filter(Boolean);
    if (!tokens.length) return { predicate: null, segments: [] };

    const current = new Set();
    for (const token of tokens) {
      for (const seg of tokenSegments(token)) current.add(seg);
      const prefix = token.replace(/[-_][0-9][A-Za-z0-9_-]*$/, '');
      if (prefix.length >= 3 && prefix !== token && !isHashSegment(prefix)) current.add(prefix);
    }

    const siblings = findSiblingInstances(el);
    const total = siblings.length;
    const seenIn = new Map();
    if (total >= 2) {
      for (const sibling of siblings) {
        const local = new Set();
        const cls = sibling.getAttribute('class') || '';
        for (const token of cls.split(/\s+/).filter(Boolean)) {
          for (const seg of tokenSegments(token)) local.add(seg);
        }
        for (const seg of local) seenIn.set(seg, (seenIn.get(seg) || 0) + 1);
      }
    }

    const keep = [];
    for (const seg of current) {
      if (!seg || keep.includes(seg)) continue;
      if (isStateSegment(seg)) continue;
      if (classSemanticScore(seg) > 0) {
        keep.push(seg);
        continue;
      }
      if (isHashSegment(seg) || valueHasHash(seg)) continue;
      if (total >= 2) {
        if ((seenIn.get(seg) || 0) >= total) continue;
        keep.push(seg);
      } else if (seg.length >= 3) {
        keep.push(seg);
      }
    }
    if (!keep.length) return { predicate: null, segments: [] };

    keep.sort(
      (a, b) =>
        classSemanticScore(b) - classSemanticScore(a) ||
        a.length - b.length ||
        a.localeCompare(b)
    );

    const tag = xpathTag(el);
    const nodesFor = (segs) => {
      const xpath =
        '//' + tag + '[' + segs.map((seg) => classPredicateFor(el, seg)).join(' and ') + ']';
      const result = evaluateXPath(xpath, 200);
      if (result.error || !result.count) return null;
      if (!result.nodes.includes(el)) return null;
      return { count: result.count, nodes: result.nodes };
    };
    const sameSet = (a, b) => {
      if (!a || !b || a.count !== b.count) return false;
      for (let i = 0; i < a.nodes.length; i++) {
        if (a.nodes[i] !== b.nodes[i]) return false;
      }
      return true;
    };

    // 最小充分子集：以「命中集合完全相同」为准，而不是命中数相同
    const reference = nodesFor(keep);
    let chosen = keep.slice();
    if (reference) {
      const single = keep.find((seg) => sameSet(nodesFor([seg]), reference));
      if (single) {
        chosen = [single];
      } else {
        for (let i = keep.length - 1; i >= 0 && chosen.length > 1; i--) {
          const seg = keep[i];
          if (!chosen.includes(seg)) continue;
          const trial = chosen.filter((item) => item !== seg);
          if (sameSet(nodesFor(trial), reference)) chosen = trial;
        }
      }
    }

    return {
      predicate: chosen.map((seg) => classPredicateFor(el, seg)).join(' and '),
      segments: chosen
    };
  }

  function usableClassName(name) {
    return (
      name.length <= 40 &&
      !STYLE_PREFIX.test(name) &&
      !isHashSegment(name) &&
      !isStateSegment(name) &&
      !valueHasHash(name) &&
      stableWords(name).length > 0
    );
  }

  function classUniqueExpr(el) {
    const cls = analyzeClass(el);
    if (!cls.predicate) return '';
    const expr = '//' + xpathTag(el) + '[' + cls.predicate + ']';
    return matchesOnly(expr, el) ? expr : '';
  }

  function listBaseFor(parent) {
    const self = firstMatching(selfCandidates(parent), parent);
    if (self) return self;
    const structural = structuralPath(parent);
    if (structural && !/\[\d+\]/.test(structural)) return structural;
    const cls = classUniqueExpr(parent);
    if (cls) return cls;
    return structural || absolutePath(parent);
  }

  function listPathAt(node, el, base) {
    const parent = node.parentElement;
    if (!parent) return null;
    const group = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
    if (group.length < 2) return null;
    const scope = base || listBaseFor(parent);
    if (!scope) return null;
    const steps = stepsFromAncestor(node, el);
    if (!steps) return null;
    const path = scope + '/' + xpathTag(node) + (steps.length ? '/' + steps.join('/') : '');
    const result = evaluateXPath(path, group.length + 10);
    if (result.error || result.count !== group.length || !result.nodes.includes(el)) return null;
    const parents = new Set(result.nodes.map((item) => item.parentElement));
    return { path, count: result.count, spread: parents.size, anchored: !!base };
  }

  // 列候选：目标在重复行内时，按「行内固定位置」取一列，每行至多命中一个
  function listColumnCandidate(node, el, base) {
    if (!node || node === el) return null;
    const parent = node.parentElement;
    if (!parent) return null;
    const rows = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
    if (rows.length < 2) return null;
    const steps = stepsFromAncestor(node, el);
    if (!steps || !steps.length) return null;
    const scope = base || listBaseFor(parent);
    if (!scope) return null;
    const path = scope + '/' + xpathTag(node) + '/' + steps.join('/');
    const result = evaluateXPath(path, rows.length + 10);
    if (result.error || result.count < 2) return null;
    if (!result.nodes.includes(el)) return null;
    const parents = new Set(result.nodes.map((item) => item.parentElement));
    if (parents.size !== result.count) return null;
    return { path, count: result.count, spread: parents.size, column: true, anchored: !!base };
  }

  // 列表兜底：命中元素必须是「同类」——同标签、同近亲父级链、稳定 class 一致
  function shapeSignature(node) {
    const chain = [];
    let parent = node.parentElement;
    let depth = 0;
    while (parent && parent.nodeType === 1 && depth < 3) {
      chain.push(parent.tagName);
      parent = parent.parentElement;
      depth++;
    }
    const classes = Array.from(node.classList || [])
      .filter((name) => usableClassName(name))
      .sort();
    return node.tagName + '|' + chain.join('>') + '|' + classes.join('.');
  }

  function sameShapes(nodes, el) {
    const signature = shapeSignature(el);
    return nodes.every((node) => shapeSignature(node) === signature);
  }

  function classListCandidates(el) {
    const tag = xpathTag(el);
    const out = [];
    const seen = new Set();
    const names = [];
    for (const token of Array.from(el.classList || [])) {
      names.push(token);
      for (const seg of tokenSegments(token)) {
        if (seg !== token) names.push(seg);
      }
    }
    for (const name of names) {
      if (!usableClassName(name)) continue;
      const expr = '//' + tag + '[' + classPredicateFor(el, name) + ']';
      if (seen.has(expr)) continue;
      seen.add(expr);
      const result = evaluateXPath(expr, 80);
      if (result.error || result.count < 2 || result.count > 60) continue;
      if (!result.nodes.includes(el)) continue;
      const parents = new Set(result.nodes.map((item) => item.parentElement));
      out.push({ path: expr, count: result.count, spread: parents.size });
    }
    return out;
  }

  function listCandidateFor(el, expr, flags) {
    if (!expr) return null;
    const result = evaluateXPath(expr, 80);
    if (result.error || result.count < 2 || result.count > 60) return null;
    if (!result.nodes.includes(el)) return null;
    const parents = new Set(result.nodes.map((item) => item.parentElement));
    const out = { path: expr, count: result.count, spread: parents.size };
    if (flags && flags.anchored) out.anchored = true;
    if (flags && flags.text) out.text = true;
    return out;
  }

  function listTextCandidate(el) {
    const exprs = textCandidates(el);
    if (!exprs.length) return null;
    return listCandidateFor(el, exprs[0], { text: true });
  }

  // 锚点作为列表作用域：只在锚点子树内拼路径，避免 /.. 逃出锚点
  function scopedPathTo(anchor, anchorExpr, node) {
    if (!anchor || !anchorExpr || !node) return '';
    if (anchor === node) return anchorExpr;
    if (!anchor.contains(node)) return '';
    const steps = stepsFromAncestor(anchor, node);
    if (!steps || !steps.length) return '';
    const path = anchorExpr + '/' + steps.join('/');
    return matchesOnly(path, node) ? path : '';
  }

  // 没有结构候选时的属性批量兜底：命中元素必须同类
  function attrListCandidate(el) {
    for (const expr of selfCandidates(el)) {
      const result = evaluateXPath(expr, 80);
      if (result.error || result.count < 2 || result.count > 60) continue;
      if (!result.nodes.includes(el)) continue;
      if (!sameShapes(result.nodes, el)) continue;
      const parents = new Set(result.nodes.map((item) => item.parentElement));
      return { path: expr, count: result.count, spread: parents.size };
    }
    return null;
  }

  function listCandidates(el, anchor, wantAll) {
    const candidates = [];
    const pushCandidate = (candidate, family) => {
      if (!candidate) return;
      if (candidates.some((item) => item.path === candidate.path && item.family === family)) return;
      candidate.family = family || '';
      candidates.push(candidate);
    };
    const anchorExpr = anchorExprFor(anchor);
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && node !== document.body && depth < 7) {
      const parent = node.parentElement;
      const scoped = parent ? scopedPathTo(anchor, anchorExpr, parent) : '';
      pushCandidate(listPathAt(node, el, scoped), 'structure');
      pushCandidate(listColumnCandidate(node, el, scoped), 'structure');
      node = parent;
      depth++;
    }

    if (!candidates.length || wantAll) pushCandidate(attrListCandidate(el), 'attr');
    if (!candidates.length || wantAll) {
      for (const candidate of classListCandidates(el)) pushCandidate(candidate, 'class');
    }

    pushCandidate(listTextCandidate(el), 'text');

    if (anchorExpr && anchor !== el) {
      const exprs = textCandidates(el);
      if (exprs.length) {
        pushCandidate(
          listCandidateFor(el, anchorExpr + exprs[0], { text: true, anchored: true }),
          'text'
        );
      }
      const cls = analyzeClass(el);
      if (cls.predicate) {
        pushCandidate(
          listCandidateFor(el, anchorExpr + '//' + xpathTag(el) + '[' + cls.predicate + ']', {
            anchored: true
          }),
          'class'
        );
      }
    }
    return candidates;
  }

  function pickListCandidate(candidates, mode) {
    if (!candidates.length) return null;
    let pool = candidates;
    if (mode === 'anchor') pool = candidates.filter((candidate) => candidate.anchored);
    else if (mode !== 'auto') pool = candidates.filter((candidate) => candidate.family === mode);
    if (!pool.length) return null;
    pool.sort(
      (a, b) => Number(!!b.anchored) - Number(!!a.anchored) || b.spread - a.spread || b.count - a.count
    );
    const best = pool[0];
    // 同一作用域内，命中数相同时优先下标更少的文本批量
    const textLike = pool.find(
      (c) =>
        c !== best &&
        c.text &&
        !!c.anchored === !!best.anchored &&
        c.count === best.count &&
        (c.path.match(/\[\d+\]/g) || []).length < (best.path.match(/\[\d+\]/g) || []).length
    );
    return textLike || best;
  }

  function listXPath(el, anchor, pathMode) {
    if (!el || el.nodeType !== 1) return '';
    const mode = PATH_MODES.indexOf(pathMode) >= 0 ? pathMode : 'auto';
    // 指定方式时要凑齐所有族再过滤；自动模式保持原来的「没结构才看属性/class」
    const best = pickListCandidate(listCandidates(el, anchor, mode !== 'auto'), mode);
    return best ? best.path : '';
  }

  const PATH_MODES = ['auto', 'attr', 'text', 'class', 'structure', 'anchor'];
  const PATH_MODE_LABELS = {
    auto: '自动',
    attr: '属性',
    text: '文本',
    class: 'class',
    structure: '结构',
    anchor: '锚点'
  };

  // via: self（目标自带强身份） / anchor（锚点前缀） / auto（自动规则） / absolute（绝对路径）
  // pathMode 非 auto 时只取该族候选；取不到就留空，交给调用方提示，不跨族兜底
  function autoXPathInfo(el, anchor, pathMode) {
    if (!el || el.nodeType !== 1) return { xpath: '', via: 'none' };
    const mode = PATH_MODES.indexOf(pathMode) >= 0 ? pathMode : 'auto';
    const useAnchor = !!(anchor && anchor !== el && anchor.isConnected);
    let hierarchy = null;
    const hierarchical = () => {
      if (hierarchy === null) hierarchy = betterPath(structuralPath(el), elasticPath(el));
      return hierarchy;
    };
    const steps = [
      {
        family: 'attr',
        via: 'self',
        run: () => firstMatching(selfCandidates(el, useAnchor ? 'strong' : undefined), el)
      }
    ];
    if (useAnchor) {
      steps.push({ family: 'anchor', via: 'anchor', run: () => anchoredPathTo(anchor, el) });
      // 锚点拼不出相对路径时才允许值型属性兜底，仍然不做绝对路径
      steps.push({
        family: 'attr',
        via: 'self',
        run: () => firstMatching(selfCandidates(el, 'weak'), el)
      });
    }
    steps.push(
      { family: 'text', via: 'auto', run: () => firstMatching(contextualTextCandidates(el), el) },
      { family: 'text', via: 'auto', run: () => firstMatching(textCandidates(el), el) },
      { family: 'text', via: 'auto', run: () => firstMatching(textClassCandidates(el), el) },
      {
        family: 'structure',
        via: 'auto',
        run: () => {
          const path = hierarchical();
          return path && !/\[\d+\]/.test(path) ? path : '';
        }
      },
      { family: 'class', via: 'auto', run: () => classUniqueExpr(el) },
      { family: 'text', via: 'auto', run: () => scopedSemanticPath(el) },
      { family: 'structure', via: 'auto', run: () => hierarchical() },
      { family: 'structure', via: 'auto', run: () => tableCellPath(el) },
      { family: 'structure', via: 'auto', run: () => referenceCandidates(el)[0] || '' }
    );
    for (const step of steps) {
      if (mode !== 'auto' && step.family !== mode) continue;
      const xpath = step.run();
      if (xpath) return { xpath, via: step.via };
    }
    if (mode !== 'auto') return { xpath: '', via: 'mode-empty' };
    // 有锚点时绝不再退回 /html 绝对路径：宁可留空让面板提示「锚点未生效」
    if (useAnchor) return { xpath: '', via: 'anchor-failed' };
    return { xpath: absolutePath(el), via: 'absolute' };
  }

  // 稳定根 + 行序号 + 语义叶子，例如 //tbody[cl]/tr[2]//span[class 谓词][文本]。
  // 同一行里重复多行的按钮，不需要把中间的多层包裹 div 全写死。
  function leafPredicate(el) {
    const parts = [];
    const text = stableText(el);
    if (text) parts.push('normalize-space(.)=' + xpLiteral(text));
    const cls = analyzeClass(el);
    if (cls.predicate) parts.push(cls.predicate);
    return parts.join(' and ');
  }

  function scopedSemanticPath(el) {
    const pred = leafPredicate(el);
    if (!pred) return '';
    const tag = xpathTag(el);
    let node = el.parentElement;
    let depth = 0;
    let best = '';
    while (node && node.nodeType === 1 && node !== document.body && depth < 8) {
      const base = structuralPath(node);
      if (base && (!best || pathFragility(base) < pathFragility(best))) {
        const path = base + '//' + tag + '[' + pred + ']';
        if (matchesOnly(path, el)) best = base;
      }
      node = node.parentElement;
      depth++;
    }
    return best ? best + '//' + tag + '[' + pred + ']' : '';
  }

  function autoXPath(el, anchor) {
    return autoXPathInfo(el, anchor).xpath;
  }

  function attrFacts(el) {
    const out = [];
    const seen = new Set();
    const push = (name) => {
      if (out.length >= 6 || seen.has(name)) return;
      seen.add(name);
      let value = '';
      try {
        value = el.getAttribute(name) || '';
      } catch (e) {}
      if (!value) return;
      out.push({ name, value: truncate(value, 56) });
    };

    for (const name of FACT_ATTRS) push(name);
    try {
      for (const attr of Array.from(el.attributes)) {
        if (out.length >= 6) break;
        if (attr.name === 'class' || attr.name === 'style' || attr.name.indexOf('on') === 0) {
          continue;
        }
        push(attr.name);
      }
    } catch (e) {}
    return out;
  }

  function elementSize(el) {
    const info = { width: 0, height: 0, visible: false, inViewport: false, disabled: false };
    try {
      const rect = el.getBoundingClientRect();
      info.width = Math.round(rect.width);
      info.height = Math.round(rect.height);
      info.visible = info.width > 0 && info.height > 0;
      if (info.visible) {
        const style = getComputedStyle(el);
        info.visible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      }
      info.inViewport =
        info.visible &&
        rect.bottom > 0 && rect.right > 0 &&
        rect.top < window.innerHeight && rect.left < window.innerWidth;
    } catch (e) {}
    try {
      info.disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
    } catch (e) {}
    return info;
  }

  function ancestorInfo(el) {
    const path = [];
    let anchor = '';
    let node = el.parentElement;
    let depth = 0;

    while (node && node.nodeType === 1 && depth < 5) {
      let seg = node.tagName.toLowerCase();
      if (node.id) {
        seg += '#' + truncate(node.id, 24);
      } else {
        const testId = node.getAttribute('data-testid') || '';
        if (testId) seg += '[' + truncate(testId, 24) + ']';
      }
      path.unshift(seg);
      if (!anchor) {
        const expr = firstMatching(selfCandidates(node), node);
        if (expr) anchor = expr;
      }
      node = node.parentElement;
      depth++;
    }

    return { anchor, path: path.join(' > ') };
  }

  function isSelfAnchored(el) {
    return !!firstMatching(selfCandidates(el), el);
  }

  function matchPreview(node) {
    if (!node || node.nodeType !== 1) return '';
    let text = '';
    try {
      text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
    } catch (e) {}
    let label = node.tagName.toLowerCase();
    if (node.id) label += '#' + node.id;
    return truncate(text ? label + ' · ' + text : label, 56);
  }

  function relationBetween(root, el) {
    if (!root || !el) return { kind: 'none', label: '' };
    if (root === el) return { kind: 'root', label: '原始' };

    const up = new Map();
    let node = root;
    let upSteps = 0;
    while (node) {
      up.set(node, upSteps++);
      node = node.parentElement;
    }

    node = el;
    let downSteps = 0;
    while (node) {
      if (up.has(node)) {
        const u = up.get(node);
        if (u === 0) {
          return { kind: 'child', label: '子级' + (downSteps > 1 ? ' ↓' + downSteps : '') };
        }
        if (downSteps === 0) {
          return { kind: 'parent', label: '父级' + (u > 1 ? ' ↑' + u : '') };
        }
        if (u === 1 && downSteps === 1) {
          const kids = node.children ? Array.from(node.children) : [];
          const a = kids.indexOf(root);
          const b = kids.indexOf(el);
          const dist = Math.abs(b - a);
          return {
            kind: b < a ? 'prev' : 'next',
            label: (b < a ? '上兄弟' : '下兄弟') + (dist > 1 ? ' ×' + dist : '')
          };
        }
        return { kind: 'mixed', label: '父级↑' + u + ' · 子级↓' + downSteps };
      }
      node = node.parentElement;
      downSteps++;
    }
    return { kind: 'other', label: '同页相关' };
  }

  function xpLiteral(value) {
    const text = String(value);
    if (!text.includes("'")) return "'" + text + "'";
    if (!text.includes('"')) return '"' + text + '"';
    return 'concat(' + text.split('"').map((part) => '"' + part + '"').join(', \'"\', ') + ')';
  }

  function hexToRgba(hex, alpha) {
    try {
      const raw = hex.replace('#', '');
      const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
      const num = parseInt(full, 16);
      const r = (num >> 16) & 255;
      const g = (num >> 8) & 255;
      const b = num & 255;
      return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
    } catch (e) {
      return 'rgba(255, 107, 107, ' + alpha + ')';
    }
  }

  function evaluateXPath(xpath, limit) {
    const empty = { count: 0, nodes: [], error: null };
    if (!xpath || typeof xpath !== 'string') {
      return Object.assign({}, empty, { error: 'XPath 为空' });
    }
    try {
      const result = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      const count = result.snapshotLength;
      const nodes = [];
      const cap = Math.min(count, limit || 0);
      for (let i = 0; i < cap; i++) {
        const node = result.snapshotItem(i);
        if (node && node.nodeType === 1) nodes.push(node);
      }
      return { count, nodes, error: null };
    } catch (err) {
      return {
        count: 0,
        nodes: [],
        error: (err && err.message) || 'XPath 语法错误'
      };
    }
  }

  // evaluateXPath 不传 limit 时 nodes 为空，只适合取 count；需要判断「是否包含某元素」时用这个
  function xpathHits(xpath, el) {
    if (!xpath || !el || !el.isConnected) return false;
    try {
      const result = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      for (let i = 0; i < result.snapshotLength; i++) {
        if (result.snapshotItem(i) === el) return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  function isUniqueXPath(xpath) {
    try {
      const result = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      return result.snapshotLength === 1;
    } catch (e) {
      return false;
    }
  }

  function matchSummary(node, index) {
    const rect = node.getBoundingClientRect();
    let text = '';
    try {
      text = (node.innerText || '').trim().replace(/\s+/g, ' ');
    } catch (e) {}
    if (!text) {
      try {
        text = (node.textContent || '').trim().replace(/\s+/g, ' ');
      } catch (e) {}
    }
    let visible = rect.width > 0 && rect.height > 0;
    if (visible) {
      try {
        const style = getComputedStyle(node);
        visible = style.display !== 'none' && style.visibility !== 'hidden';
      } catch (e) {}
    }
    const classes = Array.from(node.classList || []).slice(0, 3).join(' ');
    return {
      index: index + 1,
      tag: node.tagName.toLowerCase(),
      id: truncate(node.id || '', 40),
      cls: truncate(classes, 60),
      text: truncate(text, 80),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      visible
    };
  }

  function clearPreview() {
    flashIndex = -1;
    previewXPath = '';
    if (!previewNodes.length && !previewCount) return;
    previewNodes = [];
    previewCount = 0;
    scheduleDraw();
  }

  function setPreview(xpath) {
    const raw = typeof xpath === 'string' ? xpath.trim() : '';
    if (!raw) {
      clearPreview();
      return { ok: true, count: 0, shown: 0, matches: [] };
    }
    const result = evaluateXPath(raw, MAX_PREVIEW_MATCHES);
    if (result.error) {
      previewXPath = '';
      previewNodes = [];
      previewCount = 0;
      scheduleDraw();
      return { ok: false, count: 0, shown: 0, matches: [], error: result.error };
    }
    previewXPath = raw;
    previewNodes = result.nodes;
    previewCount = result.count;
    flashIndex = -1;
    scheduleDraw();
    const matches = [];
    for (let i = 0; i < previewNodes.length; i++) {
      const summary = matchSummary(previewNodes[i], i);
      summary.color = COLORS[i % COLORS.length];
      matches.push(summary);
    }
    return { ok: true, count: result.count, shown: previewNodes.length, matches };
  }

  // 页面重渲染会替换掉快照里的节点；快照失效时按存下的 XPath 重新查询，
  // 元素暂时不存在也继续等，出现后自动恢复蚂蚁线
  function refreshDetachedPreview() {
    if (!previewXPath) return;
    const stale = previewCount === 0 || previewNodes.some((node) => !node.isConnected);
    if (!stale) return;
    setPreview(previewXPath);
  }

  function focusPreview(index) {
    const node = previewNodes[index];
    if (!node || !node.isConnected) return { ok: false };
    try {
      node.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    } catch (e) {
      try {
        node.scrollIntoView();
      } catch (err) {}
    }
    flashIndex = index;
    scheduleDraw();
    setTimeout(() => {
      if (flashIndex === index) {
        flashIndex = -1;
        scheduleDraw();
      }
    }, 1100);
    return { ok: true };
  }

  // 验证卡片复制用：返回预览节点的完整文本，不受卡片 80 字预览截断
  function previewText(index) {
    const node = previewNodes[index];
    if (!node || !node.isConnected) return { ok: false };
    let text = '';
    try {
      text = (node.innerText || '').trim().replace(/\s+/g, ' ');
    } catch (e) {}
    if (!text) {
      try {
        text = (node.textContent || '').trim().replace(/\s+/g, ' ');
      } catch (e) {}
    }
    return { ok: true, text };
  }

  function xpathFor(el) {
    if (!el || el.nodeType !== 1) return '';
    try {
      return autoXPath(el, null);
    } catch (e) {
      return '';
    }
  }

  // 缓存只在路径仍能命中目标时有效：文本/标题被页面改掉后立即失效重算
  function cacheStillValid(item) {
    const cache = item.xpCache;
    if (!cache || !cache.xpath || !item.target || !item.target.isConnected) return false;
    if (item.listMode) {
      const result = evaluateXPath(cache.xpath, 80);
      return !result.error && result.count >= 2 && result.nodes.includes(item.target);
    }
    return matchesOnly(cache.xpath, item.target);
  }

  function activeAnchor(item) {
    return item.anchorMarked && item.anchor && item.anchor.isConnected && item.anchor !== item.target
      ? item.anchor
      : null;
  }

  // 锚点表达式（标记时刻固定）失效时不再静默改写成绝对路径：保留上次 XPath 并标记锚点失效
  function anchorStillValid(item) {
    if (!item.anchorMarked) return true;
    if (!item.anchor || !item.anchor.isConnected) return false;
    if (item.anchor === item.target) return true;
    if (!item.anchorExpr) return false;
    const result = evaluateXPath(item.anchorExpr, 2);
    return !result.error && result.count === 1 && result.nodes[0] === item.anchor;
  }

  function itemXPath(item) {
    if (item.customXPath) return item.customXPath;
    if (!item.target) return '';
    const anchor = activeAnchor(item);
    const mode = item.listMode ? 'list' : 'unique';
    const pathMode = item.pathMode || 'auto';
    item.anchorBroken = !anchorStillValid(item);
    if (item.anchorBroken) return item.lastXPath || '';
    if (
      item.xpCache &&
      item.xpCache.el === item.target &&
      item.xpCache.anchor === anchor &&
      item.xpCache.mode === mode &&
      item.xpCache.pathMode === pathMode &&
      cacheStillValid(item)
    ) {
      return item.xpCache.xpath;
    }
    item.modeAvail = null;
    let xpath = '';
    let listOk = false;
    let via = '';
    if (item.listMode) {
      xpath = listXPath(item.target, anchor, pathMode);
      listOk = !!xpath;
      if (xpath) via = 'list';
    }
    if (!xpath) {
      const info = autoXPathInfo(item.target, anchor, pathMode);
      xpath = info.xpath;
      via = info.via;
    }
    if (xpath) item.lastXPath = xpath;
    item.xpCache = { el: item.target, anchor, mode, pathMode, xpath, listOk, via };
    return xpath;
  }

  // 每种匹配方式当前有没有候选：面板据此把没有后续的选项灰掉、禁止点击。
  // 结果缓存到 item.modeAvail，随目标 / 锚点 / 唯一-列表切换失效。
  function modeAvailability(item) {
    if (!item.target || !item.target.isConnected) return null;
    const anchor = activeAnchor(item);
    const listMode = !!item.listMode;
    const cached = item.modeAvail;
    if (
      cached &&
      cached.target === item.target &&
      cached.anchor === anchor &&
      cached.listMode === listMode
    ) {
      return cached.modes;
    }
    const modes = { auto: true };
    let listPool = null;
    const pool = () => {
      if (!listPool) listPool = listCandidates(item.target, anchor, true);
      return listPool;
    };
    for (const mode of PATH_MODES) {
      if (mode === 'auto') continue;
      let xpath = '';
      if (listMode) {
        const best = pickListCandidate(pool(), mode);
        if (best) xpath = best.path;
      }
      if (!xpath) xpath = autoXPathInfo(item.target, anchor, mode).xpath;
      modes[mode] = !!xpath;
    }
    item.modeAvail = { target: item.target, anchor, listMode, modes };
    return modes;
  }

  // 生成结果是否真的以锚点表达式为前缀（锚点表达式在标记时冻结，不会随页面重算）
  function usesAnchorPrefix(xpath, expr) {
    if (!xpath || !expr) return false;
    return xpath === expr || xpath.indexOf(expr + '/') === 0 || xpath.indexOf(expr + '//') === 0;
  }

  function describeLabel(el) {
    if (!el) return '';
    let out = el.tagName.toLowerCase();
    if (el.id) out += '#' + el.id;
    const classes = Array.from(el.classList || []);
    if (classes.length) out += '.' + classes.slice(0, 2).join('.');
    let text = '';
    try {
      text = (el.innerText || '').trim().replace(/\s+/g, ' ');
    } catch (e) {}
    if (!text) {
      try {
        text = (el.textContent || '').trim().replace(/\s+/g, ' ');
      } catch (e) {}
    }
    if (text) out += ' · ' + text.slice(0, 42);
    return out;
  }

  function hoverTagLabel(el) {
    let out = el.tagName.toLowerCase();
    if (el.id) out += '#' + el.id;
    const classes = Array.from(el.classList || []);
    if (classes.length) out += '.' + classes.slice(0, 2).join('.');
    return truncate(out, 70);
  }

  function safeOuterHTML(el) {
    try {
      return el.outerHTML || '';
    } catch (e) {
      return '';
    }
  }

  // ---------------- picking ----------------
  function normalizeElement(el) {
    if (!el || el.nodeType !== 1) return null;
    while (el.getRootNode && el.getRootNode() !== document) {
      const root = el.getRootNode();
      if (root === shadow) return null;
      if (!root.host) break;
      el = root.host;
    }
    if (el === host) return null;
    return el;
  }

  function resolveTarget(event) {
    let el = null;
    if (typeof event.composedPath === 'function') {
      const path = event.composedPath();
      for (const node of path) {
        if (node && node.nodeType === 1) {
          el = node;
          break;
        }
      }
    }
    if (!el) el = event.target;
    return normalizeElement(el);
  }

  function adoptSheet(target) {
    try {
      document.adoptedStyleSheets = document.adoptedStyleSheets.concat([target]);
      return true;
    } catch (e) {
      return false;
    }
  }

  function dropSheet(target) {
    try {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== target);
    } catch (e) {}
  }

  // 深度冻结逻辑在 MAIN world 的 inject-freeze.js 里（隔离世界改不到页面的定时器），
  // 这里只通过 postMessage 下发指令并拿回暂停统计。
  function requestFreezeEngine(on) {
    return new Promise((resolve) => {
      const requestId = 'fz_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      let timer = 0;
      const finish = (value) => {
        window.removeEventListener('message', onMessage);
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      const onMessage = (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.__xpFreeze !== true || data.type !== 'result') return;
        if (data.requestId !== requestId) return;
        finish(data);
      };
      window.addEventListener('message', onMessage);
      try {
        window.postMessage({ __xpFreeze: true, type: on ? 'freeze' : 'unfreeze', requestId }, '*');
      } catch (e) {
        finish(null);
        return;
      }
      timer = setTimeout(() => finish(null), 800);
    });
  }

  function syncFreezeEngine(on) {
    const token = ++freezeToken;
    freezeStats = null;
    freezeDeep = false;
    requestFreezeEngine(on).then((res) => {
      if (token !== freezeToken || frozen !== on) return;
      if (!res || !res.ok) return;
      freezeDeep = true;
      freezeStats = res.stats || null;
      pushState();
    });
  }

  // 子框架（iframe）有自己的内容脚本，顶层只负责广播冻结状态，由 background 转发到每一帧
  function syncFrameFreeze(on) {
    if (!IS_TOP) return;
    try {
      const promise = chrome.runtime.sendMessage({ type: 'xp:freezeFrames', on: on });
      if (promise && typeof promise.catch === 'function') promise.catch(() => {});
    } catch (e) {}
  }

  function setPicking(next) {
    const value = !!next;
    if (!value) anchorModeId = null;
    if (value) {
      // 重新开始拾取说明用户已经离开验证视图
      suppressItemBoxes = false;
      clearPreview();
    }
    picking = value;
    hoverEl = null;
    setCursor(picking || !!anchorModeId);
    scheduleDraw();
  }

  function applyFrozen(value) {
    // 子框架的冻结/解冻由 frame-freeze.js 负责，这里不接管
    if (!IS_TOP) return;
    if (value === frozen) return;
    frozen = value;
    try {
      if (frozen) {
        if (!freezeSheet) {
          freezeSheet = new CSSStyleSheet();
          freezeSheet.replaceSync(FREEZE_CSS);
          if (!adoptSheet(freezeSheet)) freezeSheet = null;
        }
      } else if (freezeSheet) {
        dropSheet(freezeSheet);
        freezeSheet = null;
      }
    } catch (e) {
      freezeSheet = null;
    }
    syncFreezeEngine(value);
    syncFrameFreeze(value);
  }

  // 冻结与拾取是两个独立功能：冻结只锁页面，不改变拾取状态，也不画十字光标/悬停框；
  // 需要边冻结边捕获时，再单独开启拾取即可
  function setFrozen(next) {
    const value = !!next;
    const changed = value !== frozen;
    applyFrozen(value);
    hoverEl = null;
    setCursor(picking || !!anchorModeId);
    scheduleDraw();
    if (changed) pushState();
  }

  function setCursor(on) {
    try {
      if (on) {
        if (!cursorSheet) {
          cursorSheet = new CSSStyleSheet();
          cursorSheet.replaceSync('*, *::before, *::after { cursor: crosshair !important; }');
          if (!adoptSheet(cursorSheet)) cursorSheet = null;
        }
      } else if (cursorSheet) {
        dropSheet(cursorSheet);
        cursorSheet = null;
      }
    } catch (e) {
      cursorSheet = null;
    }
  }

  function addItem(el) {
    pickSeq += 1;
    const pickedAt = Date.now();
    lastPickAt = pickedAt;
    itemsOwned = true;
    items.push({
      id: 'xp_' + pickedAt.toString(36) + '_' + pickSeq,
      pickedAt,
      color: COLORS[(pickSeq - 1) % COLORS.length],
      root: el,
      anchor: el,
      anchorMarked: false,
      anchorExpr: '',
      anchorBroken: false,
      target: el,
      name: defaultNameFor(el),
      nameCustom: false,
      customXPath: null,
      lastXPath: '',
      origin: null,
      listMode: false,
      pathMode: 'auto',
      xpCache: null
    });
    scheduleDraw();
    pushState();
  }

  function assignAnchor(id, el) {
    const item = findItem(id);
    anchorModeId = null;
    if (item) {
      item.anchor = el;
      item.anchorMarked = true;
      item.anchorExpr = anchorExprFor(el);
      item.anchorBroken = false;
      item.xpCache = null;
      item.lastXPath = '';
    }
    hoverEl = null;
    setCursor(picking);
    scheduleDraw();
    pushState();
  }

  function onPageClick(event) {
    if (!picking && !anchorModeId) return;
    const el = resolveTarget(event);
    if (!el) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (anchorModeId) {
      assignAnchor(anchorModeId, el);
      return;
    }
    addItem(el);
  }

  function onPageMouseDown(event) {
    if (!picking && !anchorModeId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onPointerMove(event) {
    if (!picking && !anchorModeId) return;
    const el = resolveTarget(event);
    if (el !== hoverEl) hoverEl = el;
    scheduleDraw();
  }

  function onFrozenEvent(event) {
    if (!frozen) return;
    const target = event.target;
    if (target && target.nodeType === 1 && target.closest && target.closest('#__xp_picker_host__')) {
      return;
    }
    // 只拦传播挡不住滚轮/键盘/拖拽的默认行为，必须 preventDefault
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && anchorModeId) {
      anchorModeId = null;
      hoverEl = null;
      setCursor(picking);
      scheduleDraw();
      pushState();
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.key === 'Escape' && frozen) {
      setFrozen(false);
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.key === 'Escape' && picking) {
      setPicking(false);
      pushState();
      // 其它 iframe 可能还在拾取，通知面板统一停掉
      announcePickEsc();
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.key === 'Escape' && previewNodes.length) {
      clearPreview();
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
  }

  window.addEventListener('click', onPageClick, true);
  window.addEventListener('mousedown', onPageMouseDown, true);
  window.addEventListener('mousemove', onPointerMove, true);
  window.addEventListener('keydown', onKeyDown, true);
  for (const type of FROZEN_EVENTS) {
    // window 上的 wheel/touch 监听默认是 passive，必须显式 passive:false 才能 preventDefault 阻止滚动
    window.addEventListener(type, onFrozenEvent, { capture: true, passive: false });
  }
  window.addEventListener('resize', () => {
    if (items.length || picking || previewNodes.length) scheduleDraw();
  }, true);
  window.addEventListener('scroll', () => {
    if (items.length || picking || previewNodes.length) scheduleDraw();
  }, true);
  window.addEventListener('load', () => {
    if (items.length || picking || previewNodes.length) scheduleDraw();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (items.length || picking || previewNodes.length)) scheduleDraw();
  });
  setInterval(() => {
    if (!items.length && !picking && !previewNodes.length && !previewXPath) return;
    refreshDetachedPreview();
    const revived = reviveStale();
    const signature = validitySignature();
    if (revived || signature !== validSignature) {
      validSignature = signature;
      pushState();
    }
    scheduleDraw();
  }, 500);

  // 刷新/跳转前立刻落盘，避免 debounce 还没触发就丢
  window.addEventListener('pagehide', saveItems, true);
  window.addEventListener('pagehide', announceFrameGone, true);
  // bfcache 恢复时页面没有重新加载，需要重新报到
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) announceFrame(null);
  });

  // ---------------- drawing ----------------
  function scheduleDraw() {
    if (drawScheduled) return;
    drawScheduled = true;
    requestAnimationFrame(draw);
  }

  function draw() {
    drawScheduled = false;
    const entries = [];
    const anchors = [];
    // 验证期间隐藏拾取高亮：面板显式声明验证视图，或页面上正有验证预览
    const hidePicked = suppressItemBoxes || previewNodes.length > 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const n = itemNumbers[item.id] || i + 1;
      const relation =
        item.root && item.target ? relationBetween(item.root, item.target) : null;
      if (item.customXPath) {
        const result = evaluateXPath(item.customXPath, MAX_DRAWN_MATCHES);
        if (result.error) continue;
        for (let k = 0; k < result.nodes.length; k++) {
          entries.push({
            el: result.nodes[k],
            color: item.color,
            n,
            seq: result.nodes.length > 1 ? k + 1 : 0,
            rel: ''
          });
        }
      } else if (item.target && item.target.isConnected) {
        let drawn = false;
        if (item.listMode) {
          const xpath = itemXPath(item);
          const result = xpath ? evaluateXPath(xpath, MAX_DRAWN_MATCHES) : { nodes: [] };
          for (let k = 0; k < result.nodes.length; k++) {
            const node = result.nodes[k];
            entries.push({
              el: node,
              color: item.color,
              n,
              seq: k + 1,
              rel: node === item.target && relation && relation.kind !== 'root' ? relation.label : ''
            });
            drawn = true;
          }
        }
        if (!drawn) {
          entries.push({
            el: item.target,
            color: item.color,
            n,
            seq: 0,
            rel: relation && relation.kind !== 'root' ? relation.label : ''
          });
        }
      }
      if (
        item.anchorMarked &&
        item.anchor &&
        item.anchor.isConnected &&
        item.anchor !== item.target
      ) {
        anchors.push({ el: item.anchor, color: item.color, n });
      }
    }

    while (boxes.length < entries.length) {
      const box = document.createElement('div');
      box.className = 'xp-box';
      const num = document.createElement('span');
      num.className = 'xp-num';
      const main = document.createElement('span');
      main.className = 'xp-num-main';
      const sub = document.createElement('span');
      sub.className = 'xp-num-sub';
      const rel = document.createElement('span');
      rel.className = 'xp-num-rel';
      num.appendChild(main);
      num.appendChild(sub);
      num.appendChild(rel);
      box.appendChild(num);
      layer.appendChild(box);
      boxes.push({ box, num, main, sub, rel, text: '' });
    }

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const slot = boxes[i];
      const rect = entry.el.getBoundingClientRect();
      const visible =
        rect.width > 0 && rect.height > 0 &&
        rect.bottom > 0 && rect.right > 0 &&
        rect.top < window.innerHeight && rect.left < window.innerWidth;

      if (!visible || hidePicked) {
        slot.box.style.display = 'none';
        continue;
      }
      slot.box.style.display = 'block';
      slot.box.style.left = rect.left + 'px';
      slot.box.style.top = rect.top + 'px';
      slot.box.style.width = rect.width + 'px';
      slot.box.style.height = rect.height + 'px';
      slot.box.style.setProperty('--xp-c', entry.color);
      slot.box.style.setProperty('--xp-bg', hexToRgba(entry.color, 0.1));
      slot.box.classList.toggle('num-below', rect.top < 20 && rect.bottom + 20 <= window.innerHeight);
      slot.box.classList.toggle('num-inside', rect.top < 20 && rect.bottom + 20 > window.innerHeight);
      const text = entry.n + '|' + (entry.seq || 0) + '|' + entry.rel;
      if (slot.text !== text) {
        slot.text = text;
        slot.main.textContent = String(entry.n);
        slot.sub.textContent = entry.seq ? String(entry.seq) : '';
        slot.sub.style.display = entry.seq ? '' : 'none';
        slot.rel.textContent = entry.rel ? ' · ' + entry.rel : '';
        slot.rel.style.display = entry.rel ? '' : 'none';
      }
    }

    for (let i = entries.length; i < boxes.length; i++) {
      boxes[i].box.style.display = 'none';
    }

    while (previewBoxes.length < previewNodes.length) {
      const box = document.createElement('div');
      box.className = 'xp-box xp-preview';
      const num = document.createElement('span');
      num.className = 'xp-num';
      const main = document.createElement('span');
      main.className = 'xp-num-main';
      num.appendChild(main);
      box.appendChild(num);
      layer.appendChild(box);
      previewBoxes.push({ box, num, main, text: '' });
    }

    for (let i = 0; i < previewNodes.length; i++) {
      const node = previewNodes[i];
      const slot = previewBoxes[i];
      if (!node.isConnected) {
        slot.box.style.display = 'none';
        continue;
      }
      const rect = node.getBoundingClientRect();
      const visible =
        rect.width > 0 && rect.height > 0 &&
        rect.bottom > 0 && rect.right > 0 &&
        rect.top < window.innerHeight && rect.left < window.innerWidth;
      if (!visible) {
        slot.box.style.display = 'none';
        continue;
      }
      slot.box.style.display = 'block';
      slot.box.style.left = rect.left + 'px';
      slot.box.style.top = rect.top + 'px';
      slot.box.style.width = rect.width + 'px';
      slot.box.style.height = rect.height + 'px';
      const color = COLORS[i % COLORS.length];
      slot.box.style.setProperty('--xp-c', color);
      slot.box.style.setProperty('--xp-bg', hexToRgba(color, 0.08));
      slot.box.classList.toggle('num-below', rect.top < 20 && rect.bottom + 20 <= window.innerHeight);
      slot.box.classList.toggle('num-inside', rect.top < 20 && rect.bottom + 20 > window.innerHeight);
      slot.box.classList.toggle('flash', flashIndex === i);
      const text = String(i + 1);
      if (slot.text !== text) {
        slot.text = text;
        slot.main.textContent = text;
      }
    }

    for (let i = previewNodes.length; i < previewBoxes.length; i++) {
      previewBoxes[i].box.style.display = 'none';
      previewBoxes[i].box.classList.remove('flash');
    }

    while (anchorBoxes.length < anchors.length) {
      const box = document.createElement('div');
      box.className = 'xp-box xp-anchor';
      const tag = document.createElement('span');
      tag.className = 'xp-anchor-tag';
      box.appendChild(tag);
      layer.appendChild(box);
      anchorBoxes.push({ box, tag });
    }

    for (let i = 0; i < anchors.length; i++) {
      const entry = anchors[i];
      const slot = anchorBoxes[i];
      const rect = entry.el.getBoundingClientRect();
      const visible =
        rect.width > 0 && rect.height > 0 &&
        rect.bottom > 0 && rect.right > 0 &&
        rect.top < window.innerHeight && rect.left < window.innerWidth;
      if (!visible || hidePicked) {
        slot.box.style.display = 'none';
        continue;
      }
      slot.box.style.display = 'block';
      slot.box.style.left = rect.left + 'px';
      slot.box.style.top = rect.top + 'px';
      slot.box.style.width = rect.width + 'px';
      slot.box.style.height = rect.height + 'px';
      slot.box.style.setProperty('--xp-c', entry.color);
      const text = '锚 ' + entry.n;
      if (slot.tag.textContent !== text) slot.tag.textContent = text;
    }

    for (let i = anchors.length; i < anchorBoxes.length; i++) {
      anchorBoxes[i].box.style.display = 'none';
    }

    drawHover();
    drawModeChip();
    drawFreezeOverlay();
  }

  function drawHover() {
    if ((!picking && !anchorModeId) || !hoverEl || !hoverEl.isConnected) {
      if (hoverBox) hoverBox.style.display = 'none';
      if (hoverLabel) hoverLabel.style.display = 'none';
      return;
    }

    if (!hoverBox) {
      hoverBox = document.createElement('div');
      hoverBox.className = 'xp-hover';
      layer.appendChild(hoverBox);
      hoverLabel = document.createElement('div');
      hoverLabel.className = 'xp-hover-label';
      layer.appendChild(hoverLabel);
    }

    const anchorHover = !!anchorModeId;
    hoverBox.classList.toggle('xp-hover-anchor', anchorHover);
    hoverLabel.classList.toggle('xp-hover-anchor', anchorHover);

    const rect = hoverEl.getBoundingClientRect();
    const visible =
      rect.width > 0 && rect.height > 0 &&
      rect.bottom > 0 && rect.right > 0 &&
      rect.top < window.innerHeight && rect.left < window.innerWidth;

    if (!visible) {
      hoverBox.style.display = 'none';
      hoverLabel.style.display = 'none';
      return;
    }

    hoverBox.style.display = 'block';
    hoverBox.style.left = rect.left + 'px';
    hoverBox.style.top = rect.top + 'px';
    hoverBox.style.width = rect.width + 'px';
    hoverBox.style.height = rect.height + 'px';

    hoverLabel.textContent = hoverTagLabel(hoverEl);
    hoverLabel.style.display = 'block';
    const labelWidth = hoverLabel.offsetWidth;
    const labelHeight = hoverLabel.offsetHeight;
    let top = rect.top - labelHeight - 4;
    if (top < 4) top = rect.top + 2;
    const left = Math.min(
      Math.max(4, rect.left),
      Math.max(4, window.innerWidth - labelWidth - 4)
    );
    hoverLabel.style.left = left + 'px';
    hoverLabel.style.top = top + 'px';
  }

  function drawModeChip() {
    if (anchorModeId) {
      if (!modeChip) {
        modeChip = document.createElement('div');
        modeChip.className = 'xp-mode';
        layer.appendChild(modeChip);
      }
      const index = items.findIndex((item) => item.id === anchorModeId);
      const anchorItem = index >= 0 ? items[index] : null;
      const anchorNo = anchorItem ? itemNumbers[anchorItem.id] || index + 1 : 0;
      const text =
        '为 #' + anchorNo + ' 选择锚点 · 点击元素设置 · Esc 取消';
      if (modeChip.textContent !== text) modeChip.textContent = text;
      modeChip.style.display = 'block';
    } else if (picking) {
      if (!modeChip) {
        modeChip = document.createElement('div');
        modeChip.className = 'xp-mode';
        layer.appendChild(modeChip);
      }
      const text = frozen
        ? '拾取中 · 页面已冻结 · 点击捕获 · Esc 解冻'
        : 'XPath 拾取中 · 点击元素即可捕获 · Esc 退出';
      if (modeChip.textContent !== text) modeChip.textContent = text;
      modeChip.style.display = 'block';
    } else if (modeChip) {
      modeChip.style.display = 'none';
    }
  }

  // 冻结遮罩：顶层固定覆盖（含 iframe 区域），pointer-events:none 不挡悬停与后续拾取
  function drawFreezeOverlay() {
    if (!frozen) {
      if (freezeTint) freezeTint.style.display = 'none';
      if (freezeBadge) freezeBadge.style.display = 'none';
      return;
    }
    if (!freezeTint) {
      freezeTint = document.createElement('div');
      freezeTint.className = 'xp-freeze-tint';
      layer.appendChild(freezeTint);
    }
    freezeTint.style.display = 'block';
    if (!freezeBadge) {
      freezeBadge = document.createElement('div');
      freezeBadge.className = 'xp-freeze-badge';
      const title = document.createElement('b');
      title.textContent = '页面已冻结';
      const hint = document.createElement('span');
      freezeBadge.appendChild(title);
      freezeBadge.appendChild(hint);
      freezeBadgeHint = hint;
      layer.appendChild(freezeBadge);
    }
    const hintText = picking ? '点击捕获 · Esc 解冻' : 'Esc 解冻 · 面板开启拾取后可捕获';
    if (freezeBadgeHint.textContent !== hintText) freezeBadgeHint.textContent = hintText;
    freezeBadge.style.display = 'block';
  }

  // ---------------- state ----------------
  function getState() {
    return {
      picking,
      frozen,
      freezeStats: frozen ? freezeStats : null,
      freezeDeep: frozen ? freezeDeep : false,
      frames: IS_TOP ? document.querySelectorAll('iframe, frame').length : 0,
      anchorMode: anchorModeId,
      pickedAt: lastPickAt,
      url: location.href,
      docId: DOC_ID,
      isTop: IS_TOP,
      frameUrl: persistedUrl(location.href),
      frameTitle: document.title,
      items: items.map((item, index) => {
        const connected = !!(item.target && item.target.isConnected);
        const xpath = item.customXPath || (connected ? itemXPath(item) : item.lastXPath || '');
        const anchorBroken = !!(connected && !item.customXPath && item.anchorBroken);
        const result = xpath ? evaluateXPath(xpath, 3) : { count: 0, nodes: [], error: null };
        const listActive = !!(
          connected &&
          item.listMode &&
          !item.customXPath &&
          item.xpCache &&
          item.xpCache.el === item.target &&
          item.xpCache.listOk
        );
        const canList = !!(
          connected &&
          !item.customXPath &&
          (item.listMode || hasRepeatedAncestor(item.target))
        );
        const canPathMode = !!(connected && !item.customXPath && !item.anchorBroken);
        const ancestors = connected ? ancestorInfo(item.target) : null;
        const rootConnected = !!(item.root && item.root.isConnected);
        const anchorConnected = !!(item.anchor && item.anchor.isConnected);
        const relation =
          connected && rootConnected ? relationBetween(item.root, item.target) : null;
        const facts = connected ? attrFacts(item.target) : null;
        const size = connected ? elementSize(item.target) : null;
        const anchorHint = connected && !isSelfAnchored(item.target) ? ancestors.anchor : '';
        const anchorExpr =
          connected && item.anchorMarked && !item.customXPath ? item.anchorExpr || '' : '';
        const anchorMatchCount = anchorExpr ? evaluateXPath(anchorExpr, 2).count : 0;
        const anchorApplied = !!(anchorExpr && xpath && usesAnchorPrefix(xpath, anchorExpr));
        const cacheVia =
          connected && item.xpCache && item.xpCache.el === item.target ? item.xpCache.via : '';
        const anchorSkipped =
          !!(anchorExpr && xpath && !anchorApplied && cacheVia === 'self');
        const anchorIneffective = !!(
          anchorExpr &&
          !anchorBroken &&
          (!xpath || (!anchorApplied && cacheVia !== 'self'))
        );
        if (connected) {
          item.snapshot = {
            tag: item.target.tagName.toLowerCase(),
            label: describeLabel(item.target),
            facts,
            size,
            anchorHint,
            path: ancestors.path,
            relation: relation ? { kind: relation.kind, label: relation.label } : null
          };
        }
        // 失效后沿用最后一次快照：卡片只灰化，字段不抽空
        const snap = item.snapshot || {};
        const shownRelation = relation
          ? { kind: relation.kind, label: relation.label }
          : connected
            ? null
            : snap.relation || null;

        return {
          id: item.id,
          n: index + 1,
          pickedAt: item.pickedAt || 0,
          color: item.color,
          tag: connected ? snap.tag : snap.tag || '?',
          label: connected ? snap.label : snap.label || '元素已失效',
          name: item.name || '',
          xpath,
          origin: item.origin || null,
          aiApplied: item.origin === 'ai',
          listMode: listActive,
          pathMode: item.pathMode || 'auto',
          pathModeAvail: canPathMode ? modeAvailability(item) : null,
          canPathMode,
          canList,
          matchCount: result.count,
          xpathError: result.error || null,
          stale: !connected || anchorBroken,
          anchorBroken,
          facts: connected ? facts : snap.facts || [],
          size: connected ? size : snap.size || null,
          anchorHint: connected ? anchorHint : snap.anchorHint || '',
          path: connected ? ancestors.path : snap.path || '',
          preview: result.count > 1 ? result.nodes.map(matchPreview).filter(Boolean) : [],
          relation: shownRelation,
          isRoot: connected && item.target === item.root,
          isAnchor: connected && item.target === item.anchor,
          anchorMarked: !!item.anchorMarked,
          anchorLabel: item.anchorMarked && anchorConnected && !anchorBroken ? describeLabel(item.anchor) : '',
          anchorExpr,
          anchorMatchCount,
          anchorIndexed: /\[\s*\d+\s*\]/.test(anchorExpr),
          anchorApplied,
          anchorSkipped,
          anchorIneffective,
          canRoot: connected && rootConnected && item.target !== item.root,
          canParent: connected && !!item.target.parentElement,
          canChild: connected && !!item.target.firstElementChild,
          canPrev: connected && !!item.target.previousElementSibling,
          canNext: connected && !!item.target.nextElementSibling
        };
      })
    };
  }

  function pushState() {
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.id) return;
      const promise = chrome.runtime.sendMessage({ type: 'xp:push', state: getState() });
      if (promise && typeof promise.catch === 'function') promise.catch(() => {});
    } catch (e) {}
    scheduleSaveItems();
  }

  // 面板按 sender.frameId 归并各帧状态；子框架主动报到，动态插入的 iframe 也能被发现
  function announceFrame(scan) {
    if (!chrome || !chrome.runtime || !chrome.runtime.id) return;
    try {
      const promise = chrome.runtime.sendMessage({
        type: 'xp:frameState',
        scan: scan == null ? null : scan,
        state: getState()
      });
      if (promise && typeof promise.catch === 'function') promise.catch(() => {});
    } catch (e) {}
  }

  function announceFrameGone() {
    if (IS_TOP || !chrome || !chrome.runtime || !chrome.runtime.id) return;
    try {
      const promise = chrome.runtime.sendMessage({ type: 'xp:frameGone', url: location.href });
      if (promise && typeof promise.catch === 'function') promise.catch(() => {});
    } catch (e) {}
  }

  function announcePickEsc() {
    if (!chrome || !chrome.runtime || !chrome.runtime.id) return;
    try {
      const promise = chrome.runtime.sendMessage({ type: 'xp:pickEsc' });
      if (promise && typeof promise.catch === 'function') promise.catch(() => {});
    } catch (e) {}
  }

  // 刷新后恢复列表：按 tabId + URL 存放在 background 的 storage.session 里
  function persistedUrl(url) {
    try {
      const parsed = new URL(url);
      parsed.hash = '';
      return parsed.href;
    } catch (e) {
      return String(url || '');
    }
  }

  function serializeItems() {
    return items.map((item) => ({
      id: item.id,
      pickedAt: item.pickedAt || 0,
      color: item.color,
      name: item.name || '',
      nameCustom: !!item.nameCustom,
      customXPath: item.customXPath || null,
      origin: item.origin || null,
      listMode: !!item.listMode,
      pathMode: item.pathMode || 'auto',
      anchorMarked: !!item.anchorMarked,
      anchorExpr: item.anchorExpr || '',
      lastXPath: item.lastXPath || '',
      snapshot: item.snapshot || null
    }));
  }

  let saveTimer = null;
  // 只有本页真正持有一份列表（恢复或拾取过）才允许写盘，否则离开空页面会把别的页面留下的快照清掉
  let itemsOwned = false;

  function scheduleSaveItems() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveItems, 180);
  }

  function saveItems() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!itemsOwned) return;
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.id) return;
      const promise = chrome.runtime.sendMessage({
        type: 'xp:persist',
        url: persistedUrl(location.href),
        items: serializeItems()
      });
      if (promise && typeof promise.catch === 'function') promise.catch(() => {});
    } catch (e) {}
  }

  // 恢复时用保存的 XPath 重新找元素；找不到就保持失效态，沿用快照显示
  function restoreItem(raw) {
    if (!raw || typeof raw.id !== 'string' || !raw.id) return null;
    const item = {
      id: raw.id,
      pickedAt: Number(raw.pickedAt) || 0,
      color: raw.color || COLORS[0],
      root: null,
      anchor: null,
      anchorMarked: !!raw.anchorMarked,
      anchorExpr: typeof raw.anchorExpr === 'string' ? raw.anchorExpr : '',
      anchorBroken: false,
      target: null,
      name: typeof raw.name === 'string' ? raw.name : '',
      nameCustom: !!raw.nameCustom,
      customXPath: typeof raw.customXPath === 'string' && raw.customXPath ? raw.customXPath : null,
      lastXPath: typeof raw.lastXPath === 'string' ? raw.lastXPath : '',
      origin: typeof raw.origin === 'string' ? raw.origin : null,
      listMode: !!raw.listMode,
      pathMode: PATH_MODES.indexOf(raw.pathMode) >= 0 ? raw.pathMode : 'auto',
      snapshot: raw.snapshot && typeof raw.snapshot === 'object' ? raw.snapshot : null,
      xpCache: null
    };
    const xpath = item.customXPath || item.lastXPath;
    if (xpath) {
      const result = evaluateXPath(xpath, 2);
      if (!result.error && result.count >= 1 && (result.count === 1 || item.listMode)) {
        item.target = result.nodes[0];
        item.root = result.nodes[0];
      }
    }
    if (item.anchorMarked && item.anchorExpr) {
      const hit = evaluateXPath(item.anchorExpr, 2);
      item.anchor = !hit.error && hit.count === 1 ? hit.nodes[0] : null;
    } else {
      item.anchor = item.root;
    }
    return item;
  }

  async function restorePersistedItems() {
    if (!chrome || !chrome.runtime || !chrome.runtime.id) return;
    let stored = null;
    try {
      stored = await chrome.runtime.sendMessage({
        type: 'xp:restore',
        url: persistedUrl(location.href)
      });
    } catch (e) {
      return;
    }
    if (!stored || !Array.isArray(stored.items) || !stored.items.length) return;
    itemsOwned = true;
    if (items.length) return;
    const restored = [];
    for (const raw of stored.items) {
      const item = restoreItem(raw);
      if (item) restored.push(item);
    }
    if (!restored.length) return;
    items = restored;
    pickSeq = restored.length;
    validSignature = validitySignature();
    scheduleDraw();
    pushState();
  }

  // 失效条目按保存的 XPath 重新绑定：元素重新出现（重新挂载或重渲染）后卡片自动恢复
  function reviveStale() {
    let revived = false;
    for (const item of items) {
      if (item.target && item.target.isConnected) continue;
      const xpath = item.customXPath || item.lastXPath || '';
      if (!xpath) continue;
      const result = evaluateXPath(xpath, 2);
      if (result.error || result.count !== 1) continue;
      item.target = result.nodes[0];
      item.xpCache = null;
      revived = true;
    }
    return revived;
  }

  function validitySignature() {
    let out = '';
    for (const item of items) out += item.target && item.target.isConnected ? '1' : '0';
    return out;
  }

  function performAction(id, action) {
    const item = findItem(id);
    if (!item || !item.target || !item.target.isConnected) return;

    const current = item.target;
    let next = null;
    if (action === 'root') next = item.root;
    else if (action === 'parent') next = current.parentElement;
    else if (action === 'child') next = current.firstElementChild;
    else if (action === 'prev') next = current.previousElementSibling;
    else if (action === 'next') next = current.nextElementSibling;
    if (!next || !next.isConnected) return;

    item.target = next;
    item.customXPath = null;
    item.origin = null;
    item.pathMode = 'auto';
    item.xpCache = null;
    item.lastXPath = '';
    scheduleDraw();
    pushState();
  }

  function applyAI(id, xpath, name) {
    const item = findItem(id);
    if (!item || !item.target || !item.target.isConnected) {
      return { ok: false, error: '元素已失效，请重新拾取' };
    }
    const value = String(xpath || '').trim();
    if (!value) return { ok: false, error: 'XPath 不能为空' };

    const result = evaluateXPath(value, MAX_DRAWN_MATCHES);
    if (result.error) return { ok: false, error: 'XPath 无效：' + result.error };
    if (result.count === 0) return { ok: false, error: 'XPath 未匹配到任何元素' };

    item.customXPath = value;
    item.origin = 'ai';
    const cleaned = sanitizeIdentifier(name);
    if (cleaned) {
      item.name = uniqueName(cleaned, item.id);
      item.nameCustom = true;
    }
    scheduleDraw();
    pushState();
    return { ok: true, count: result.count, state: getState() };
  }

  function renameItem(id, name) {
    const item = findItem(id);
    if (!item) return { ok: false, error: '条目不存在' };
    const cleaned = sanitizeIdentifier(name);
    const fallbackEl = item.target && item.target.isConnected ? item.target : item.anchor;
    item.name = cleaned || autoNameFor(fallbackEl, item.listMode, item.id);
    item.nameCustom = !!cleaned;
    pushState();
    return { ok: true, name: item.name, state: getState() };
  }

  function setItemXPath(id, xpath) {
    const item = findItem(id);
    if (!item) return { ok: false, error: '条目不存在' };
    const value = String(xpath == null ? '' : xpath).trim();

    if (!value) {
      if (!item.target || !item.target.isConnected) {
        return { ok: false, error: '元素已失效，无法恢复自动生成的 XPath' };
      }
      item.customXPath = null;
      item.origin = null;
      item.xpCache = null;
      scheduleDraw();
      pushState();
      return { ok: true, count: evaluateXPath(itemXPath(item)).count, state: getState() };
    }

    const result = evaluateXPath(value);
    if (result.error) return { ok: false, error: 'XPath 无效：' + result.error };

    item.customXPath = value;
    item.origin = 'manual';
    scheduleDraw();
    pushState();
    return { ok: true, count: result.count, state: getState() };
  }

  // ---------------- AI context ----------------
  function describeNode(el, depth) {
    const attrs = {};
    try {
      let count = 0;
      for (const attr of Array.from(el.attributes)) {
        if (count >= 10) break;
        if (attr.name === 'class' || attr.name === 'style' || attr.name.indexOf('on') === 0) {
          continue;
        }
        attrs[attr.name] = truncate(attr.value, 120);
        count++;
      }
    } catch (e) {}

    let index = 1;
    let sameTagCount = 1;
    if (el.parentElement) {
      const sameTag = Array.from(el.parentElement.children).filter(
        (child) => child.tagName === el.tagName
      );
      sameTagCount = sameTag.length;
      index = Math.max(1, sameTag.indexOf(el) + 1);
    }

    let directText = '';
    try {
      directText = Array.from(el.childNodes)
        .filter((node) => node.nodeType === 3)
        .map((node) => node.textContent)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    } catch (e) {}

    return {
      depth,
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      idUnique: el.id ? isUniqueXPath('//*[@id=' + xpLiteral(el.id) + ']') : undefined,
      classes: Array.from(el.classList || []).slice(0, 6),
      attrs,
      directText: directText ? truncate(directText, 120) : undefined,
      indexAmongSameTag: index,
      sameTagCount,
      childElementCount: el.childElementCount
    };
  }

  function escapeAttr(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeTextValue(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function compactHtml(el, maxLen) {
    try {
      const clone = el.cloneNode(true);
      if (!clone || clone.nodeType !== 1) return truncate(safeOuterHTML(el), maxLen);
      const junk = clone.querySelectorAll('script,style,noscript,template,link,meta');
      for (const node of Array.from(junk)) node.remove();
      const nodes = [clone].concat(Array.from(clone.querySelectorAll('*')));
      for (const node of nodes) {
        if (!node.attributes) continue;
        node.removeAttribute('style');
        for (const attr of Array.from(node.attributes)) {
          if (/^on/i.test(attr.name)) {
            node.removeAttribute(attr.name);
            continue;
          }
          if (attr.value.length > 200) node.setAttribute(attr.name, attr.value.slice(0, 120) + '…');
        }
        const cls = node.getAttribute('class');
        if (cls) {
          const kept = cls.split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
          if (kept) node.setAttribute('class', kept);
          else node.removeAttribute('class');
        }
      }
      const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT, null);
      let textNode;
      while ((textNode = walker.nextNode())) {
        const value = textNode.nodeValue || '';
        if (value.length > 160) textNode.nodeValue = value.replace(/\s+/g, ' ').trim().slice(0, 160) + '…';
      }
      return truncate((clone.outerHTML || '').replace(/\s+/g, ' '), maxLen);
    } catch (e) {
      return truncate(safeOuterHTML(el), maxLen);
    }
  }

  function shallowHtml(el, maxLen) {
    try {
      const tag = el.tagName.toLowerCase();
      const attrs = [];
      for (const attr of Array.from(el.attributes)) {
        if (attr.name === 'style' || /^on/i.test(attr.name)) continue;
        let value = attr.value;
        if (attr.name === 'class') {
          value = value.split(/\s+/).filter(Boolean).slice(0, 5).join(' ');
        }
        if (!value) {
          attrs.push(attr.name);
          continue;
        }
        if (value.length > 80) value = value.slice(0, 60) + '…';
        attrs.push(attr.name + '="' + escapeAttr(value) + '"');
      }
      const counts = new Map();
      for (const child of Array.from(el.children)) {
        const name = child.tagName.toLowerCase();
        counts.set(name, (counts.get(name) || 0) + 1);
      }
      const summary = Array.from(counts.entries())
        .map(([name, count]) => (count > 1 ? count + '×' + name : name))
        .join(', ');
      let direct = '';
      try {
        direct = Array.from(el.childNodes)
          .filter((node) => node.nodeType === 3)
          .map((node) => node.nodeValue)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
      } catch (e) {}
      let inner = '';
      if (direct) inner += escapeTextValue(truncate(direct, 40));
      if (summary) inner += (inner ? ' ' : '') + '<!-- ' + summary + ' -->';
      const out = '<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '') + '>' + inner + '</' + tag + '>';
      return truncate(out, maxLen);
    } catch (e) {
      return '';
    }
  }

  function shortNodeLabel(node) {
    if (!node || !node.tagName) return '?';
    let out = node.tagName.toLowerCase();
    if (node.id) out += '#' + truncate(node.id, 24);
    const cls = Array.from(node.classList || []).slice(0, 2).join('.');
    if (cls) out += '.' + cls;
    return truncate(out, 60);
  }

  // 结构信息回答「XPath 稳不稳」，运行时事实回答「定位得到却点不动为什么」
  function runtimeFacts(el) {
    const out = {};
    let rect = null;
    try {
      rect = el.getBoundingClientRect();
      out.size = Math.round(rect.width) + '×' + Math.round(rect.height);
      out.inViewport = !!(
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    } catch (e) {}

    let style = null;
    try {
      style = getComputedStyle(el);
    } catch (e) {}
    try {
      out.visible =
        typeof el.checkVisibility === 'function'
          ? el.checkVisibility({
              checkOpacity: true,
              checkVisibilityCSS: true,
              contentVisibilityAuto: true,
              opacityProperty: true,
              visibilityProperty: true
            })
          : !!(
              rect &&
              rect.width > 0 &&
              rect.height > 0 &&
              style &&
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              style.opacity !== '0'
            );
    } catch (e) {
      out.visible = false;
    }
    if (style && style.pointerEvents && style.pointerEvents !== 'auto') {
      out.pointerEvents = style.pointerEvents;
    }
    try {
      if (el.disabled === true) out.disabled = true;
      if (el.getAttribute('aria-disabled') === 'true') out.ariaDisabled = true;
      if (el.getAttribute('aria-hidden') === 'true') out.ariaHidden = true;
    } catch (e) {}

    try {
      if (isValueDisplay(el)) out.valueNode = true;
    } catch (e) {}

    try {
      if (rect && rect.width > 0 && rect.height > 0) {
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        if (x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight) {
          const stack = document.elementsFromPoint(x, y) || [];
          const blockers = [];
          for (const node of stack) {
            if (node === el || node.contains(el)) break;
            if (el.contains(node) || node === host || node.getRootNode() === shadow) continue;
            blockers.push(shortNodeLabel(node));
            if (blockers.length >= 3) break;
          }
          if (blockers.length) out.coveredBy = blockers;
        }
      }
    } catch (e) {}

    try {
      const root = el.getRootNode && el.getRootNode();
      if (root && root !== document && root.host) {
        out.inShadowRoot = true;
        out.shadowHost = shortNodeLabel(root.host);
      }
    } catch (e) {}
    return out;
  }

  function anchorContext(item) {
    const anchor = activeAnchor(item);
    if (!anchor) return null;
    const el = item.target;
    const expr = item.anchorExpr || anchorExprFor(anchor);
    const result = expr ? evaluateXPath(expr, 1) : { count: 0 };
    const own = describeNode(anchor, 0);
    const payload = {
      label: describeLabel(anchor),
      expr: expr || '',
      matchCount: result.count || 0,
      broken: !anchorStillValid(item),
      structure: {
        tag: own.tag,
        id: own.id,
        idUnique: own.idUnique,
        classes: own.classes,
        attrs: own.attrs,
        directText: own.directText,
        indexAmongSameTag: own.indexAmongSameTag,
        sameTagCount: own.sameTagCount,
        childElementCount: own.childElementCount
      }
    };
    if (anchor.contains(el)) {
      payload.relation = 'ancestor';
      let depth = 0;
      let node = el;
      while (node && node !== anchor && depth < 30) {
        node = node.parentElement;
        depth++;
      }
      payload.depth = depth;
    } else if (el.contains(anchor)) {
      payload.relation = 'inside';
    } else {
      payload.relation = 'nearby';
      payload.html = compactHtml(anchor, 1600);
    }
    return payload;
  }

  // 给 AI 的脆弱性诊断：只描述当前 XPath 的现状，不替人做取舍
  function xpathDiagnostics(item, xpath) {
    const el = item.target;
    const anchorExpr = item.anchorMarked && item.anchorExpr ? item.anchorExpr : '';
    const result = xpath ? evaluateXPath(xpath) : { count: 0, nodes: [], error: null };
    const matchesTarget = !result.error && xpathHits(xpath, el);
    const anchorApplied = !!(anchorExpr && xpath && usesAnchorPrefix(xpath, anchorExpr));
    const cacheVia = item.xpCache && item.xpCache.el === el ? item.xpCache.via : '';
    return {
      xpath,
      valid: !result.error,
      error: result.error || null,
      absolute: /^\(\s*\/html(\/|\[|$)/.test(xpath) || /^\/html(\/|$)/.test(xpath),
      indexCount: (xpath.match(/\[\s*\d+\s*\]/g) || []).length,
      matchCount: result.count,
      matchesTarget,
      mode: item.listMode ? 'list' : 'unique',
      anchorMarked: !!item.anchorMarked,
      anchorExpr,
      anchorMatchCount: anchorExpr ? evaluateXPath(anchorExpr, 2).count : 0,
      anchorBroken: !!item.anchorBroken,
      anchorApplied,
      anchorSkipped: !!(anchorExpr && xpath && !anchorApplied && cacheVia === 'self')
    };
  }

  function getContext(id, fullHtml) {
    const item = findItem(id);
    if (!item || !item.target || !item.target.isConnected) return null;
    const el = item.target;

    const ancestors = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth <= 6) {
      const info = describeNode(node, depth);
      info.html =
        depth === 0
          ? compactHtml(node, 3200)
          : fullHtml
            ? compactHtml(node, 1600)
            : shallowHtml(node, 700);
      ancestors.push(info);
      node = node.parentElement;
      depth++;
    }

    const siblingSamples = [];
    if (el.parentElement) {
      const siblings = Array.from(el.parentElement.children).filter((child) => child !== el);
      for (const sibling of siblings.slice(0, 2)) {
        siblingSamples.push({
          tag: sibling.tagName.toLowerCase(),
          html: compactHtml(sibling, 600)
        });
      }
    }

    const currentXpath = itemXPath(item);
    const diagnostics = xpathDiagnostics(item, currentXpath);

    return {
      url: location.href,
      title: document.title,
      frame: { url: location.href, title: document.title, isTop: IS_TOP },
      text: truncate((el.innerText || '').trim().replace(/\s+/g, ' '), 160),
      ancestors,
      siblingSamples,
      runtime: runtimeFacts(el),
      anchor: anchorContext(item),
      currentXpath,
      currentMatchCount: diagnostics.matchCount,
      diagnostics,
      name: item.name || ''
    };
  }

  // ---------------- messaging ----------------
  restorePersistedItems()
    .catch(() => {})
    .then(() => {
      if (!IS_TOP) announceFrame(null);
    });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string' || message.type.indexOf('xp:') !== 0) {
      return;
    }
    // 子框架只处理针对自己的条目操作；顶层状态、拾取开关、冻结仍由顶层或 frame-freeze.js 负责，
    // 避免 chrome.tabs.sendMessage 广播时子框架抢答把顶层响应顶掉
    if (!IS_TOP) {
      if (message.type === 'xp:frameReport') {
        announceFrame(message.scan);
        return;
      }
      if (
        message.type === 'xp:getState' ||
        message.type === 'xp:togglePick' ||
        message.type === 'xp:toggleFreeze' ||
        message.type === 'xp:setFreeze'
      ) {
        return;
      }
    }
    try {
      switch (message.type) {
        case 'xp:getState':
          sendResponse(getState());
          break;
        case 'xp:frameGetState':
          sendResponse(getState());
          break;
        case 'xp:frameReport':
          sendResponse(getState());
          announceFrame(message.scan);
          break;
        case 'xp:togglePick':
          setPicking(!picking);
          sendResponse(getState());
          pushState();
          break;
        case 'xp:setPick':
          setPicking(!!message.on);
          sendResponse(getState());
          pushState();
          break;
        case 'xp:action':
          performAction(message.id, message.action);
          sendResponse(getState());
          break;
        case 'xp:setListMode': {
          const item = findItem(message.id);
          if (!item || !item.target || !item.target.isConnected) {
            sendResponse({ ok: false, error: '元素已失效，请重新拾取' });
            break;
          }
          if (message.on) {
            const pathMode = item.pathMode || 'auto';
            const path = listXPath(item.target, activeAnchor(item), pathMode);
            if (!path) {
              const label = PATH_MODE_LABELS[pathMode];
              sendResponse({
                ok: false,
                error:
                  pathMode === 'auto'
                    ? '没有找到可复用的列表结构，可手动填写 XPath'
                    : '「' + label + '」没有可用的列表候选，可换一种匹配方式或手动填写 XPath'
              });
              break;
            }
            item.listMode = true;
            item.xpCache = null;
            if (!item.nameCustom) item.name = autoNameFor(item.target, true, item.id);
            const count = evaluateXPath(itemXPath(item)).count;
            scheduleDraw();
            pushState();
            sendResponse({ ok: true, listMode: true, count, name: item.name, state: getState() });
          } else {
            item.listMode = false;
            item.xpCache = null;
            if (!item.nameCustom) item.name = autoNameFor(item.target, false, item.id);
            const count = evaluateXPath(itemXPath(item)).count;
            scheduleDraw();
            pushState();
            sendResponse({ ok: true, listMode: false, count, name: item.name, state: getState() });
          }
          break;
        }
        case 'xp:setPathMode': {
          const item = findItem(message.id);
          if (!item || !item.target || !item.target.isConnected) {
            sendResponse({ ok: false, error: '元素已失效，请重新拾取' });
            break;
          }
          const nextMode = PATH_MODES.indexOf(message.mode) >= 0 ? message.mode : '';
          if (!nextMode) {
            sendResponse({ ok: false, error: '未知的匹配方式' });
            break;
          }
          if (item.customXPath) {
            sendResponse({ ok: false, error: '手写 / AI 的 XPath 不参与匹配方式切换' });
            break;
          }
          if (nextMode === 'anchor' && (!activeAnchor(item) || !anchorStillValid(item))) {
            sendResponse({ ok: false, error: '锚点不可用，请先重新设置锚点元素' });
            break;
          }
          const prevMode = item.pathMode || 'auto';
          item.pathMode = nextMode;
          item.xpCache = null;
          const xpath = itemXPath(item);
          if (!xpath) {
            item.pathMode = prevMode;
            item.xpCache = null;
            itemXPath(item);
            sendResponse({
              ok: false,
              error: '「' + PATH_MODE_LABELS[nextMode] + '」没有可用候选，保持原来的匹配方式'
            });
            break;
          }
          const count = evaluateXPath(xpath).count;
          scheduleDraw();
          pushState();
          sendResponse({ ok: true, mode: nextMode, xpath, count, state: getState() });
          break;
        }
        case 'xp:pickAnchor': {
          const target = findItem(message.id);
          if (!target || !target.target || !target.target.isConnected) {
            anchorModeId = null;
          } else {
            anchorModeId = anchorModeId === message.id ? null : message.id;
          }
          hoverEl = null;
          setCursor(picking || !!anchorModeId);
          scheduleDraw();
          pushState();
          sendResponse(getState());
          break;
        }
        case 'xp:cancelAnchor':
          if (anchorModeId) {
            anchorModeId = null;
            hoverEl = null;
            setCursor(picking);
            scheduleDraw();
            pushState();
          }
          sendResponse(getState());
          break;
        case 'xp:clearAnchor': {
          const item = findItem(message.id);
          if (item) {
            item.anchor = item.root;
            item.anchorMarked = false;
            item.anchorExpr = '';
            item.anchorBroken = false;
            item.xpCache = null;
            // 锚点没了，「只按锚点」这种匹配方式就无从谈起，回到自动
            if (item.pathMode === 'anchor') item.pathMode = 'auto';
          }
          if (anchorModeId === message.id) {
            anchorModeId = null;
            setCursor(picking);
          }
          scheduleDraw();
          pushState();
          sendResponse(getState());
          break;
        }
        case 'xp:delete': {
          items = items.filter((item) => item.id !== message.id);
          if (anchorModeId === message.id) {
            anchorModeId = null;
            setCursor(picking);
          }
          scheduleDraw();
          pushState();
          sendResponse(getState());
          break;
        }
        case 'xp:clear':
          items = [];
          anchorModeId = null;
          setCursor(picking);
          scheduleDraw();
          pushState();
          sendResponse(getState());
          break;
        case 'xp:applyAI':
          sendResponse(applyAI(message.id, message.xpath, message.name));
          break;
        case 'xp:rename':
          sendResponse(renameItem(message.id, message.name));
          break;
        case 'xp:setXPath':
          sendResponse(setItemXPath(message.id, message.xpath));
          break;
        case 'xp:toggleFreeze':
          setFrozen(!frozen);
          sendResponse(getState());
          break;
        case 'xp:setFreeze':
          setFrozen(!!message.on);
          sendResponse(getState());
          break;
        case 'xp:validate': {
          const result = evaluateXPath(message.xpath);
          const item = message.id ? findItem(message.id) : null;
          const containsTarget =
            item && item.target && item.target.isConnected && !result.error
              ? xpathHits(message.xpath, item.target)
              : null;
          sendResponse({ count: result.count, error: result.error, containsTarget });
          break;
        }
        case 'xp:previewXPath':
          sendResponse(setPreview(message.xpath));
          break;
        case 'xp:setItemHighlight':
          suppressItemBoxes = !message.on;
          scheduleDraw();
          sendResponse(getState());
          break;
        case 'xp:setNumbers': {
          const nextNumbers =
            message.numbers && typeof message.numbers === 'object' ? message.numbers : {};
          if (JSON.stringify(nextNumbers) !== JSON.stringify(itemNumbers)) {
            itemNumbers = nextNumbers;
            scheduleDraw();
          }
          sendResponse({ ok: true });
          break;
        }
        case 'xp:focusPreview':
          sendResponse(focusPreview(message.index));
          break;
        case 'xp:previewText':
          sendResponse(previewText(message.index));
          break;
        case 'xp:clearPreview':
          clearPreview();
          sendResponse({ ok: true });
          break;
        case 'xp:getContext':
          sendResponse(getContext(message.id, !!message.fullHtml));
          break;
        default:
          break;
      }
    } catch (err) {
      sendResponse({ error: String((err && err.message) || err) });
    }
  });
})();
