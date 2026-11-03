function enableActionToOpenPanel() {
  if (!chrome.sidePanel || !chrome.sidePanel.setPanelBehavior) return;
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
}

chrome.runtime.onInstalled.addListener(enableActionToOpenPanel);
chrome.runtime.onStartup.addListener(enableActionToOpenPanel);
enableActionToOpenPanel();

function flashBadge(text, tabId) {
  if (!chrome.action || !chrome.action.setBadgeText) return;
  chrome.action.setBadgeBackgroundColor({ color: '#f59e0b', tabId });
  chrome.action.setBadgeText({ text, tabId });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '', tabId });
  }, 1800);
}

// 快捷键冻结：commands 回调自带当前活动标签页，拿不到时再查询
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'toggle-freeze') return;
  const target = tab && tab.id != null
    ? Promise.resolve(tab)
    : chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t);
  target
    .then((t) => {
      if (!t || t.id == null) return;
      return chrome.tabs
        .sendMessage(t.id, { type: 'xp:toggleFreeze' })
        .catch(() => flashBadge('!', t.id));
    })
    .catch(() => {});
});

// 条目快照按标签页存放：content.js 无法直接访问 storage.session，由 SW 代管
// 顶层沿用旧键 xpItems:<tabId>，子框架再加 :f<frameId>
const ITEMS_PREFIX = 'xpItems:';

function itemsKey(tabId, frameId) {
  const base = ITEMS_PREFIX + tabId;
  return Number.isInteger(frameId) && frameId > 0 ? base + ':f' + frameId : base;
}

// 整页刷新会重建 iframe，frameId 可能变化；精确键找不到时按 URL 认领兄弟帧的旧快照，
// 认领后迁移到当前键，保证多个同 URL 的 iframe 各拿各的（先恢复先认领）
async function resolveItemsRecord(tabId, frameId, key, url) {
  const data = await chrome.storage.session.get(key);
  const exact = data && data[key];
  if (exact && Array.isArray(exact.items) && exact.items.length) {
    // 同一标签页换了页面就不还原，但保留旧快照，返回原页面时还能恢复
    if (!exact.url || !url || exact.url === url) return exact;
  }
  if (!frameId) return null;

  const all = await chrome.storage.session.get(null);
  const prefix = ITEMS_PREFIX + tabId + ':f';
  const candidates = Object.keys(all || {})
    .filter((k) => k !== key && k.indexOf(prefix) === 0)
    .sort()
    .map((k) => ({ key: k, record: all[k] }))
    .filter((entry) => {
      const record = entry.record;
      return (
        record &&
        Array.isArray(record.items) &&
        record.items.length &&
        record.url &&
        record.url === url
      );
    });
  if (!candidates.length) return null;

  const picked = candidates[0];
  await chrome.storage.session.set({ [key]: picked.record });
  await chrome.storage.session.remove(picked.key);
  return picked.record;
}

// 多个子框架几乎同时恢复时串行处理，避免同一个旧快照被认领两次
let restoreChain = Promise.resolve();

function dropItems(tabId) {
  if (!chrome.storage || !chrome.storage.session) return;
  try {
    const prefix = ITEMS_PREFIX + tabId;
    const promise = chrome.storage.session.get(null).then((all) => {
      const keys = Object.keys(all || {}).filter(
        (key) => key === prefix || key.indexOf(prefix + ':f') === 0
      );
      if (keys.length) return chrome.storage.session.remove(keys);
      return null;
    });
    if (promise && promise.catch) promise.catch(() => {});
  } catch (e) {}
}

chrome.tabs.onRemoved.addListener(dropItems);
// 浏览器启动时没有别的机会清理：session 存储本身在浏览器重启后清空，这里只兜底
chrome.runtime.onStartup.addListener(() => {
  if (!chrome.storage || !chrome.storage.session) return;
  try {
    const promise = chrome.storage.session.clear();
    if (promise && promise.catch) promise.catch(() => {});
  } catch (e) {}
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return;
  const tabId = sender.tab && sender.tab.id;
  const frameId = sender.frameId || 0;

  if (message.type === 'xp:persist') {
    if (tabId == null || !chrome.storage || !chrome.storage.session) return;
    const list = Array.isArray(message.items) ? message.items : [];
    const key = itemsKey(tabId, frameId);
    const write = list.length
      ? chrome.storage.session.set({ [key]: { url: String(message.url || ''), items: list } })
      : chrome.storage.session.remove(key);
    if (write && write.catch) write.catch(() => {});
    return;
  }

  if (message.type === 'xp:restore') {
    if (tabId == null || !chrome.storage || !chrome.storage.session) {
      sendResponse({ items: [] });
      return true;
    }
    const key = itemsKey(tabId, frameId);
    const url = String(message.url || '');
    const job = restoreChain.then(() => resolveItemsRecord(tabId, frameId, key, url));
    restoreChain = job.catch(() => {});
    job
      .then((record) => {
        // 同一标签页换了页面就不还原，避免把上一页的 XPath 带过来
        if (!record || (record.url && record.url !== url)) {
          sendResponse({ items: [] });
          return;
        }
        sendResponse({ items: record.items });
      })
      .catch(() => sendResponse({ items: [] }));
    return true;
  }

  // 顶层 content.js 的通知；tabs.sendMessage 省略 frameId 时会发给标签页内所有框架
  if (message.type === 'xp:freezeFrames') {
    if (tabId == null) return;
    chrome.tabs
      .sendMessage(tabId, { type: 'xp:frameFreeze', on: !!message.on })
      .catch(() => {});
  }
});
