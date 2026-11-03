# XPath Picker

一个 Chrome MV3 侧边栏扩展：在页面上可视化地连续拾取元素，生成稳定、可维护的 XPath，并支持命名、变量批量复制、XPath 验证、页面冻结和 AI 辅助生成。生成的 XPath 可直接粘贴到影刀（ShadowBot）等 RPA 工具中使用。

当前版本：**1.26.9** · 最低 Chrome 版本：**119**

---

## 功能

### 拾取与 XPath 生成

- **连续拾取**：点击「开始拾取」后可在页面上连续点击多个元素，每个条目独立配色和编号，Esc 结束拾取。
- **iframe 支持**：跨域 / 同域 iframe 内的元素同样可以拾取；侧边栏统一列出所有框架的条目，并标注来源框架。
- **稳定 XPath 策略**：优先使用 `data-*`、`aria-*`、`name`、`role`、`type`、稳定文本、稳定 class 等语义信息，避免脆弱的绝对路径和动态哈希。
- **层级切换**：对已拾取条目可切换锚点（就近稳定祖先）、父级、子级、兄弟节点，并实时高亮对应元素。
- **匹配方式**：每个条目可切换「自动 / 属性 / 文本 / class / 结构 / 锚点」，手动选择生成策略。
- **唯一 / 列表模式**：列表模式会生成适配多条数据行的 XPath，并检查行结构一致性。
- **命名**：自动从元素语义推导变量名，也可手动编辑；命名会过滤泛化词，并保证批量复制时不重名。

### 复制

| 位置 | 复制内容 |
| --- | --- |
| 列表条目 | 该条目的 XPath |
| 批量复制 | 每行 `变量名_唯一 = "XPath"` 或 `变量名_列表 = "XPath"`，重名自动追加 `_2`、`_3` |
| AI 结果弹窗 | 纯 XPath（不带变量名和说明） |
| 验证结果卡片 | 该元素在页面中的完整文本 |

### XPath 验证

- 粘贴或输入 XPath 后自动高亮页面匹配元素（蚂蚁线），并在侧边栏列出匹配项及其标签、尺寸、文本预览。
- 点击匹配项可滚动定位并闪烁该元素。
- 每张卡片上的「复制」按钮复制元素完整文本，不受 80 字预览截断影响。

### 冻结页面

- **普通冻结**：拦截点击、按键、滚轮、触摸、拖拽、焦点等输入，页面保持当前状态不动。
- **深度冻结**：额外暂停定时器、`setInterval`、`requestAnimationFrame`、CSS/WAAPI 动画、音视频、`MutationObserver`，并同步冻结所有 iframe。
- 冻结与拾取相互独立，可同时开启；面板和页面角标会显示冻结状态。
- 快捷键：`Ctrl+Shift+Y`（macOS 为 `Command+Shift+Y`），Esc 也可解冻。

### AI 生成 XPath

- 使用任意 OpenAI 兼容的 Chat Completions 接口（`/chat/completions`）。
- 支持「唯一元素 / 列表元素」两种目标类型，可附加自然语言补充要求。
- 结果展示稳定性说明、页面实际匹配数量，可编辑后回写覆盖列表条目。
- **批量 AI**：为所有条目并发生成，最多 **5 个并发**；单个请求 **60 秒超时**，覆盖连接、等待结果和读取响应体全过程。
- 关闭侧边栏后任务继续在后台执行，重新打开面板会恢复进度；中断的任务支持重新发起。

### 持久化与失效恢复

- 条目按标签页存放在 `chrome.storage.session`，刷新页面后自动恢复（同一 URL）。
- 元素暂时消失时条目不会丢失：保留原有字段并置灰显示「已失效」，元素重新出现后自动重新绑定。
- 关闭标签页或浏览器后清理对应快照。

---

## 安装

1. 使用 Chrome **119 或更高版本**。
2. 打开 `chrome://extensions`，右上角开启「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择本项目目录（包含 `manifest.json` 的目录）。
4. 建议将扩展固定到工具栏；点击图标即可打开侧边栏。
5. 安装或更新扩展后，请刷新已经打开的目标页面，使内容脚本重新注入。

> 本项目未发布到 Chrome 应用商店，仅支持以「已解压」方式加载。

---

## 使用流程

1. 在目标页面打开侧边栏，点击「开始拾取」。
2. 在页面上依次点击需要定位的元素，每次点击都会生成一个条目。
3. 在列表中调整命名、XPath、匹配方式，或切换到父级 / 子级 / 兄弟 / 锚点。
4. 需要核对时打开「验证」，粘贴 XPath 查看页面匹配情况。
5. 点击「批量复制」得到可直接粘贴到 RPA 代码中的变量定义。
6. 需要更稳定的路径时，对单条或全部条目使用 AI 生成。

---

## AI 设置与隐私

在侧边栏右上角 ⚙ 中配置：

- **API 地址**：Chat Completions 的版本路径，例如 `https://api.openai.com/v1`。
- **API Key**：仅保存在本机 `chrome.storage.local`；本地兼容服务可留空。
- **模型**：例如 `gpt-4o-mini`。
- **发送完整祖先 HTML**：关闭时祖先节点只发送标签与属性、子节点用注释概括，更省 token；目标元素始终发送完整代码。

隐私说明：

- 使用 AI 功能时，目标元素及其祖先的 HTML 摘要、页面 URL、已生成的 XPath 和诊断信息会发送到**你配置的 API 地址**，不会发送到任何其他服务。
- API 地址、Key、模型仅保存在本机浏览器存储中，扩展不会上传或同步它们；但 `chrome.storage.local` 本身不加密，请勿在共享电脑上保存敏感 Key。
- 不使用 AI 功能时，扩展不会发起任何网络请求。

---

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `sidePanel` | 提供侧边栏界面 |
| `storage` | 保存设置、AI 任务和跨刷新条目快照 |
| `scripting` | 扩展更新后对已打开页面补注入内容脚本 |
| `tabs` | 获取当前标签页、向所有框架广播冻结指令 |
| `clipboardWrite` | 复制 XPath / 变量 / 元素文本 |
| `host_permissions: <all_urls>` | 在任意页面拾取元素、验证 XPath、冻结页面 |

`inject-freeze.js` 需要以 `MAIN` world 在 `document_start` 注入，才能拦截页面自身的定时器、动画和观察器；它只在冻结时改变页面行为。

---

## 目录结构

```
.
├── manifest.json          # MV3 清单（版本、权限、内容脚本、快捷键）
├── background.js          # Service Worker：条目快照、冻结广播、快捷键
├── sidepanel.html         # 侧边栏结构（列表 / 设置 / 验证 / AI 弹窗）
├── sidepanel.css          # 侧边栏样式
├── sidepanel.js           # 侧边栏逻辑：状态合并、XPath 编辑、AI、复制、验证
├── content.js             # 页面内容脚本：拾取、高亮、XPath 生成、验证、冻结
├── frame-freeze.js        # 子框架冻结（事件拦截 + 冻结样式）
├── inject-freeze.js       # MAIN world 深度冻结引擎（定时器 / 动画 / 观察器）
├── icons/                 # 扩展图标（含 SVG 源文件）
└── devtest/               # 自包含的 CDP 回归测试与夹具页面
```

---

## 开发与测试

项目没有构建步骤，也没有 `package.json`，修改源码后直接在扩展管理页点击「重新加载」即可。

语法检查：

```bash
node --check content.js
node --check sidepanel.js
node --check background.js
node --check frame-freeze.js
node --check inject-freeze.js
```

回归测试使用 Node + 原始 CDP 控制 Playwright 自带的 Chromium，每个套件自包含夹具页面，运行后输出 `{ report, checks, failed }`：

```bash
node devtest/panel-state.js
node devtest/xpath-probe.js
node devtest/iframe.js
```

全部 19 个套件（约 425 项检查）：

```
ai-context      anchor-broken   anchor-list     anchor-text     anchor-value
freeze-auto     hover-colors    iframe          list-column     naming
panel-state     path-mode       persist         pick-click      semantic-leaf
stale-revive    state-class     ui-path-mode    xpath-probe
```

注意：

- 浏览器路径硬编码在各测试文件顶部：

  ```js
  const CHROME = 'C:/Users/Admin/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
  ```

  如果本机 Playwright 版本不同，请统一修改该常量。
- 修改内容脚本（`content.js`、`frame-freeze.js`、`inject-freeze.js`）后，测试会自动加载新扩展；日常使用则需在扩展管理页重新加载并刷新目标页面。
- 测试会以 headful 方式启动 Chromium，运行期间请勿操作弹出的窗口。

---

## 已知限制

- **冻结不是安全沙箱**：页面若能拿到注入前缓存的原始 API，或在 Web Worker 中运行逻辑，仍可能绕过冻结；冻结只保证当前页面的界面状态不继续变化。
- **定时器追踪上限**：每个框架最多跟踪 5000 个定时器 / 动画帧，超出部分不再冻结，避免内存无限增长。
- **画布动画**：Canvas / WebGL 自行绘制的动画无法通过 CSS 或定时器拦截暂停。
- **Shadow DOM**：开放 Shadow DOM 中的元素可正常处理；封闭 Shadow DOM 内的元素无法拾取。
- **动态页面**：元素在验证后消失会显示为失效，需要等元素重新出现或重新拾取。
- **仅支持单浏览器实例**：条目快照存于 `chrome.storage.session`，关闭浏览器后不保留，刷新页面才会恢复。
- **AI 结果依赖模型**：生成的 XPath 会做语法与匹配校验，但仍建议在验证页确认匹配数量后再用于生产。