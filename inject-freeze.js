// inject-freeze.js — 深度冻结引擎（MAIN world，document_start 注入）
//
// 为什么必须 MAIN world + document_start：
//   · 隔离世界的 window.setTimeout 是另一套绑定，改不到页面自己的定时器；
//   · 只有抢在页面脚本之前替换 setTimeout/setInterval/rAF/MutationObserver，
//     冻结时才能枚举并暂停「页面加载时就已存在」的轮询/轮播。
// 未冻结时拦截器只登记，不改变定时器行为；冻结时按剩余时间入队，解冻后重放。
(() => {
  'use strict';

  if (window.__XP_FREEZE_ENGINE__) return;

  // 防网页狂建定时器时 Map 无限增长：超限后新定时器直接走原生，不再跟踪（也就无法被冻结）
  const MAX_TRACK = 5000;
  // 冻结期间新定时器返回的模拟 id，避开浏览器真实 id（从 1 开始的小整数）
  const MOCK_TIMEOUT_BASE = 1e9;
  const MOCK_RAF_BASE = 2e9;

  const native = {
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval,
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame
  };
  const nativeObserve = MutationObserver.prototype.observe;
  const nativeDisconnect = MutationObserver.prototype.disconnect;

  const timeouts = new Map(); // native id -> { callback, startedAt, delay, args }
  const intervals = new Map(); // native id -> { callback, delay, args }
  const rafs = new Map(); // native id -> callback
  const observers = new Set();
  const observeRecords = new WeakMap(); // observer -> [{ target, options }]

  let queue = { timeouts: [], intervals: [], rafs: [] };
  let pausedAnimations = [];
  let pausedMedia = [];
  let frozen = false;
  let nextMockId = 1;

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function takeFromQueue(list, id) {
    const index = list.findIndex((item) => item.id === id);
    if (index >= 0) list.splice(index, 1);
    return index >= 0;
  }

  // ---------------- 定时器 / rAF 拦截 ----------------

  function interceptedSetTimeout(callback, delay) {
    const args = Array.prototype.slice.call(arguments, 2);
    const ms = Number(delay) || 0;
    if (frozen) {
      const id = MOCK_TIMEOUT_BASE + nextMockId++;
      queue.timeouts.push({ id, callback, delay: ms, args });
      return id;
    }
    if (typeof callback !== 'function' || timeouts.size >= MAX_TRACK) {
      return native.setTimeout.call(window, callback, ms, ...args);
    }
    let id = 0;
    id = native.setTimeout.call(window, function () {
      timeouts.delete(id);
      return callback.apply(this, arguments);
    }, ms, ...args);
    timeouts.set(id, { callback, startedAt: now(), delay: ms, args });
    return id;
  }

  function interceptedClearTimeout(id) {
    timeouts.delete(id);
    takeFromQueue(queue.timeouts, id);
    return native.clearTimeout.call(window, id);
  }

  function interceptedSetInterval(callback, delay) {
    const args = Array.prototype.slice.call(arguments, 2);
    const ms = Number(delay) || 0;
    if (frozen) {
      const id = MOCK_TIMEOUT_BASE + nextMockId++;
      queue.intervals.push({ id, callback, delay: ms, args });
      return id;
    }
    if (typeof callback !== 'function' || intervals.size >= MAX_TRACK) {
      return native.setInterval.call(window, callback, ms, ...args);
    }
    const id = native.setInterval.call(window, callback, ms, ...args);
    intervals.set(id, { callback, delay: ms, args });
    return id;
  }

  function interceptedClearInterval(id) {
    intervals.delete(id);
    takeFromQueue(queue.intervals, id);
    return native.clearInterval.call(window, id);
  }

  function interceptedRequestAnimationFrame(callback) {
    if (typeof callback !== 'function') return native.requestAnimationFrame.call(window, callback);
    if (frozen) {
      const id = MOCK_RAF_BASE + nextMockId++;
      queue.rafs.push({ id, callback });
      return id;
    }
    if (rafs.size >= MAX_TRACK) return native.requestAnimationFrame.call(window, callback);
    let id = 0;
    id = native.requestAnimationFrame.call(window, function (timestamp) {
      rafs.delete(id);
      return callback.call(this, timestamp);
    });
    rafs.set(id, callback);
    return id;
  }

  function interceptedCancelAnimationFrame(id) {
    rafs.delete(id);
    takeFromQueue(queue.rafs, id);
    return native.cancelAnimationFrame.call(window, id);
  }

  // ---------------- MutationObserver 拦截 ----------------
  // 冻结期间被 disconnect 的观察器会保留 observe 参数，解冻后原样恢复；
  // 冻结期间新建的观察器同样先登记再断开，避免页面继续对 DOM 变化做出反应。
  MutationObserver.prototype.observe = function (target, options) {
    let records = observeRecords.get(this);
    if (!records) {
      records = [];
      observeRecords.set(this, records);
    }
    const existing = records.find((record) => record.target === target);
    if (existing) existing.options = options;
    else records.push({ target, options });
    observers.add(this);
    const result = nativeObserve.call(this, target, options);
    if (frozen) nativeDisconnect.call(this);
    return result;
  };

  MutationObserver.prototype.disconnect = function () {
    observers.delete(this);
    observeRecords.delete(this);
    return nativeDisconnect.call(this);
  };

  // ---------------- 暂停 / 恢复 ----------------

  function pauseAnimations() {
    pausedAnimations = [];
    try {
      if (!document.getAnimations) return;
      for (const animation of document.getAnimations()) {
        try {
          if (animation && animation.playState === 'running') {
            animation.pause();
            pausedAnimations.push(animation);
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  function resumeAnimations() {
    const list = pausedAnimations;
    pausedAnimations = [];
    for (const animation of list) {
      try {
        if (animation.playState === 'paused') animation.play();
      } catch (e) {}
    }
  }

  function pauseMedia() {
    pausedMedia = [];
    let nodes = [];
    try {
      nodes = document.querySelectorAll('video, audio');
    } catch (e) {
      return;
    }
    for (const media of nodes) {
      try {
        if (!media.paused && !media.ended) {
          media.pause();
          pausedMedia.push(media);
        }
      } catch (e) {}
    }
  }

  function resumeMedia() {
    const list = pausedMedia;
    pausedMedia = [];
    for (const media of list) {
      try {
        if (media.isConnected) media.play().catch(() => {});
      } catch (e) {}
    }
  }

  function disconnectObservers() {
    for (const observer of observers) {
      try {
        nativeDisconnect.call(observer);
      } catch (e) {}
    }
  }

  function reconnectObservers() {
    for (const observer of observers) {
      const records = observeRecords.get(observer);
      if (!records) continue;
      for (const record of records) {
        try {
          nativeObserve.call(observer, record.target, record.options);
        } catch (e) {}
      }
    }
  }

  function stats() {
    return {
      frozen,
      timeouts: queue.timeouts.length,
      intervals: queue.intervals.length,
      rafs: queue.rafs.length,
      animations: pausedAnimations.length,
      media: pausedMedia.length,
      observers: frozen ? observers.size : 0
    };
  }

  function freezePage() {
    if (frozen) return stats();
    frozen = true;

    const at = now();
    for (const [id, entry] of timeouts) {
      const remaining = Math.max(0, entry.delay - (at - entry.startedAt));
      queue.timeouts.push({ id, callback: entry.callback, delay: remaining, args: entry.args });
      native.clearTimeout.call(window, id);
    }
    timeouts.clear();

    for (const [id, entry] of intervals) {
      queue.intervals.push({ id, callback: entry.callback, delay: entry.delay, args: entry.args });
      native.clearInterval.call(window, id);
    }
    intervals.clear();

    for (const [id, callback] of rafs) {
      queue.rafs.push({ id, callback });
      native.cancelAnimationFrame.call(window, id);
    }
    rafs.clear();

    pauseAnimations();
    pauseMedia();
    disconnectObservers();
    return stats();
  }

  function unfreezePage() {
    if (!frozen) return stats();
    frozen = false;

    const pending = queue;
    queue = { timeouts: [], intervals: [], rafs: [] };

    // 走拦截器重放（此时 frozen=false），恢复后的定时器会重新登记，可再次冻结
    for (const item of pending.timeouts) {
      try {
        interceptedSetTimeout(item.callback, item.delay, ...item.args);
      } catch (e) {}
    }
    for (const item of pending.intervals) {
      try {
        interceptedSetInterval(item.callback, item.delay, ...item.args);
      } catch (e) {}
    }
    for (const item of pending.rafs) {
      try {
        interceptedRequestAnimationFrame(item.callback);
      } catch (e) {}
    }

    resumeAnimations();
    resumeMedia();
    reconnectObservers();
    return stats();
  }

  // ---------------- 与隔离世界（content.js）的桥 ----------------
  // 只用 postMessage（结构化克隆），不依赖页面 CSP；校验 event.source 防止其他窗口冒充。

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__xpFreeze !== true) return;
    let result = null;
    if (data.type === 'freeze') result = freezePage();
    else if (data.type === 'unfreeze') result = unfreezePage();
    else if (data.type === 'state') result = stats();
    else return;
    try {
      window.postMessage(
        { __xpFreeze: true, type: 'result', requestId: data.requestId, ok: true, stats: result },
        '*'
      );
    } catch (e) {}
  });

  // 安装拦截器（保持函数 length，避免个别站点按参数个数做特性判断）
  window.setTimeout = interceptedSetTimeout;
  window.clearTimeout = interceptedClearTimeout;
  window.setInterval = interceptedSetInterval;
  window.clearInterval = interceptedClearInterval;
  window.requestAnimationFrame = interceptedRequestAnimationFrame;
  window.cancelAnimationFrame = interceptedCancelAnimationFrame;

  window.__XP_FREEZE_ENGINE__ = { freeze: freezePage, unfreeze: unfreezePage, stats };
})();
