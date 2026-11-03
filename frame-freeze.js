(() => {
  'use strict';

  // 顶层由 content.js 负责；这里只处理子框架（iframe）
  if (window.top === window) return;
  if (!chrome || !chrome.runtime || !chrome.runtime.id) return;

  const FREEZE_CSS = `
    *, *::before, *::after {
      animation-play-state: paused !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      scroll-behavior: auto !important;
    }
  `;
  // 与 content.js 保持一致：进入/移动类悬停事件放行，其余输入全部吞掉
  const FROZEN_EVENTS = [
    'click', 'dblclick', 'contextmenu', 'auxclick',
    'mousedown', 'mouseup', 'pointerdown', 'pointerup',
    'mouseout', 'mouseleave', 'pointerout', 'pointerleave', 'dragleave',
    'focus', 'blur', 'focusin', 'focusout',
    'dragstart', 'dragenter', 'dragover', 'drop', 'selectstart',
    'keydown', 'keyup', 'keypress',
    'wheel', 'touchstart', 'touchmove', 'touchend'
  ];

  let frozen = false;
  let freezeSheet = null;

  function adoptSheet(target) {
    try {
      if (!document.adoptedStyleSheets) return false;
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

  // 深度冻结引擎同样跑在子框架的 MAIN world，靠 postMessage 下发；这里不关心统计
  function requestFreezeEngine(on) {
    const requestId = 'fzf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    let timer = 0;
    const onMessage = (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.__xpFreeze !== true || data.type !== 'result') return;
      if (data.requestId !== requestId) return;
      window.removeEventListener('message', onMessage);
      if (timer) clearTimeout(timer);
    };
    window.addEventListener('message', onMessage);
    timer = setTimeout(() => window.removeEventListener('message', onMessage), 800);
    try {
      window.postMessage({ __xpFreeze: true, type: on ? 'freeze' : 'unfreeze', requestId }, '*');
    } catch (e) {
      window.removeEventListener('message', onMessage);
    }
  }

  function onFrozenEvent(event) {
    if (!frozen) return;
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  }

  for (const type of FROZEN_EVENTS) {
    window.addEventListener(type, onFrozenEvent, { capture: true, passive: false });
  }

  function apply(on) {
    if (on === frozen) return;
    frozen = on;
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
    requestFreezeEngine(on);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'xp:frameFreeze') return;
    apply(!!message.on);
  });
})();
