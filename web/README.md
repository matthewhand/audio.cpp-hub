# web/ — 前端贡献指南与开发期工具链

本目录是 audio.cpp-hub 的 Web UI：**纯原生 HTML / CSS / JS，无框架、无构建步骤，运行时不需要 Node.js**。
Go 服务把 `web/` 当普通静态目录直接从磁盘提供（见 `api.go:165` 的 `staticHandler`），
浏览器直接执行这里的源文件——没有打包、压缩或转译环节。发布包里就是这些源文件本身。

脚本分两类加载（**都没有构建步骤**）：

- **经典脚本**（普通 `<script src>`）：按 `index.html` 底部顺序在解析期同步执行，彼此通过 `window.*` 通信。
- **ES 模块**（`<script type="module">`）：`web/app.js`（引导入口）+ `web/modules/*.js`（业务逻辑），
  依赖关系写在各模块顶部的 `import` 里，浏览器直接按 URL 解析。

两类可以共存：模块脚本**隐式 defer**，必然晚于所有普通脚本，因此经典组件脚本
（`audio-picker.js` / `voice-select.js` 等）不受影响；反向的经典脚本 → 模块调用由
`web/legacy-globals.js` 显式桥接（见下文「经典脚本与模块如何共存」）。

**模块图要预载**：没有打包器时，浏览器只能顺着 `app.js` 的 import 图一个个取模块。
因此 `index.html` 的 `<head>` 里对**每一个**首屏 `web/modules/*.js` 都写了一条
`<link rel="modulepreload">`（`web/index.html:24` 起），让浏览器在解析 head 时就并行
取完并预解析整张图，而不是等 `app.js` 执行后再一层层串行往返。`web/sw.js` 的
`PRECACHE_URLS` 必须覆盖同一组文件（离线冷启动同样要求一次拿全）。
**`npm run perf:budget` 会校验「模块图 ⊆ modulepreload ⊆ 预缓存」三方一致**——
漏一条不会让页面报错，只会让首屏悄悄退回串行取模块，因此用检查挡住这种漂移。

上面这条只覆盖 **ES module 图**。`index.html` 里那批**经典脚本**（`i18n.zh.js` /
`i18n.en.js` / `api-client.js` / `audio-picker.js` / `pwa.js` …）
同样必须进 `PRECACHE_URLS`，而它们不在 module 图里——`perf:budget` 看不见。
`npm run check:sw` 补这一段：遍历 `index.html` 的 `<script src>` / `<link rel=stylesheet>`
本地引用（连同模块图传递闭包）核对 `PRECACHE_URLS` 与固定外壳项。缺任意一个经典脚本都会
让离线冷启动直接崩（`i18n.js` 读不到 `window.I18N_ZH`、模块图拿不到 `Api`），所以这两道
闸门都要过。

Node / npm 等工具链**只用于开发与 CI**，不参与运行，也不需要随发行版分发。请勿在源码里依赖任何构建期产物。

---

## 第一部分 · 硬约束与架构

### 1. 硬约束

- **无构建、无框架**：一个 `index.html`（538 行）+ 11 个经典 `<script>`（共享全局作用域）
  + 1 个 `<script type="module">` 入口及其 18 个首屏 `web/modules/*.js`（外加 6 块按需加载的 chunk）。**模块不做任何转译**——
  浏览器原生支持 ES 模块，所以「拆模块」不需要打包器。
  模块数量是**首屏请求数**（浏览器一个文件一个请求，见首屏的 `modulepreload` 约定）：
  别把它拆成一堆十几行的「微模块」——`npm run perf:budget` 的请求数预算就是拿它挡着的。
- **运行时零 Node**：改完 JS/CSS 刷新浏览器即可，不存在 watch/build 流程。
- **严格 CSP**：`default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'`（`web/index.html:7`）。
  因此：不允许内联脚本、内联事件属性（`onclick=`）、内联 `style` 属性或外部 CDN。主题 / 语言在页面绘制前由 `boot.js` 从 `localStorage` 恢复。
  模块与经典脚本一样受 `script-src 'self'` 约束（`import` 的 URL 必须同源）。
  `worker-src` 未单独声明，回落到 `script-src 'self'`，因此同源 `/sw.js` 的 Service Worker 注册是允许的。
- **中英双语**：所有用户可见文案同时提供中文与英文，词典集中在 `i18n.zh.js` / `i18n.en.js`，不得硬编码在业务脚本里。
- **离线/PWA 是增强而非依赖**：Service Worker 注册失败、非安全上下文、浏览器不支持，都必须静默降级、主应用照常工作（`web/pwa.js` 已如此实现）。

### 2. 架构总览

- **服务侧**：`api.go:165` 的 `staticHandler` 用 `http.Dir("web")` 提供服务，目录请求只回 `index.html`（禁用目录列表），`index.html` 不缓存、其余资源缓存 1 小时（`api.go:203`、`api.go:205`）。
  工作目录由 `main.go:68` 的 `ensureWorkDir` 自动定位（当前目录没有 `web/` 时尝试上级与 exe 目录）。
- **前端侧**：没有路由库、没有状态管理库。`web/app.js` 是 117 行的**引导层**（导入模块、跨模块重画、
  最上层弹窗的 Esc / Tab 焦点锁定、启动顺序），业务逻辑按职责拆进 `web/modules/*.js`（18 个首屏模块 + 6 块懒加载 chunk）；
  其余经典脚本是自包含组件（IIFE 或挂到 `window` 的 class），只暴露构造器 / 方法。
- **数据流是手写的单向流**：DOM 事件 → `Api.*`（`web/api-client.js`）→ 更新模块级 `let` 状态 → 重新渲染相关 DOM。没有响应式绑定，改了 state 必须手动调用对应 render 函数。
- **HTTP 只有唯一出口**：`web/modules/dom.js:27` 绑定 `window.AudioCppHub.api`，各模块一律
  `import { Api } from "./dom.js"`；经典组件脚本（`audio-picker.js` /
  `voice-select.js`）在自己的 IIFE 顶部取同一个
  `const Api = window.AudioCppHub.api`。`api-client.js` 集中了 `fetch`、错误信封（`ApiError` 带
  `code`/`params`）、`AbortController` 超时与中断、可见性感知轮询（`Api.poll`）。
  **全站服务器流量都走 `Api.*`（#62 已收口）**：`web/` 下唯一的裸 `fetch` 在 `web/sw.js` 的
  Service Worker 事件处理器里——那是独立全局作用域（无 `window` / DOM / I18N），不加载也不加载得了
  页面脚本，且它做的是缓存路由而非业务请求。新增请求一律走 `Api.*`，不要再直接写 `fetch`。

### 3. 模块地图

#### 3.1 经典脚本与静态资源

| 文件（行数） | 职责 | 入口 / 主要 API | 关键位置 |
| --- | --- | --- | --- |
| `index.html`（542） | 全部静态 DOM（面板、弹窗、表单）、CSP、manifest、`modulepreload` 清单、脚本加载顺序 | 页面骨架 | CSP `web/index.html:7`，预载清单 `web/index.html:24`–`40`，脚本区 `web/index.html:510`–`541` |
| `boot.js`（58） | 绘制前恢复主题与语言，避免首屏闪烁（CSP 要求独立文件） | 顶层立即执行，暴露 `window.HubTheme`（三态 system/light/dark） | `web/boot.js:53` |
| `i18n.zh.js`（638） | 中文词典（`window.I18N_ZH`），605 个键 | 纯数据 | `web/i18n.zh.js:5` |
| `i18n.en.js`（639） | 英文词典（`window.I18N_EN`），与中文逐键对齐 | 纯数据 | `web/i18n.en.js:5` |
| `i18n.js`（155） | 运行时 `I18N` API（不含任何文案） | `I18N.t` / `plural` / `num` / `date` / `bytes` / `percent` / `setLang` / `applyI18n` / `onChange` / `errText` / `pick` | `window.I18N` `web/i18n.js:10`，`plural` `:59`，`date` `:78`，`bytes` `:86`，`percent` `:101`，`applyI18n` `:106` |
| `api-client.js`（459） | **唯一的 HTTP 出口**：错误信封、超时/中断、数组形状守卫、可见性感知轮询。`web/` 内唯一的 `fetch` 调用在此（`web/api-client.js:318`） | `window.AudioCppHub.api`（`Api.request/get/post/put/del/list/poll/stopAllPollers`） | `web/api-client.js:443`，`Api.poll` `:372` |
| `legacy-globals.js`（49） | 经典脚本 ↔ ES 模块的桥（见 3.4） | 顶层立即执行，定义 `window.$` / `el` + 六个转发器 | `web/legacy-globals.js:20`、`:28`、`:39` |
| `wav.js`（95） | 音频工具：解码、PCM16 单声道 WAV 编码、时长/体积格式化、输出设备预热 | `window.WavUtil` | `web/wav.js:2` |
| `audio-picker.js`（659） | 音频选择组件：上传 / 录制 / 裁剪，含波形、播放，含本地路径页签 | `window.AudioPicker` | class `web/audio-picker.js:11`，`Api` `:9` |
| `voice-select.js`（181） | 音色下拉：从音色库直选，选中即生效，返回服务器路径 | `window.VoiceSelect` / `window.refreshVoiceSelects` | class `web/voice-select.js:12`，`Api` `:10`，`refreshVoiceSelects` `:176` |
| `motion.js`（111） | 纯 UI 动效触发器：复制确认、主题切换、实例状态翻转 | `window.hubMotion` | `web/motion.js:74` |
| `pwa.js`（104） | 注册 `/sw.js`、新版本提示条、`theme-color` 跟随主题 | 顶层立即执行 | `web/pwa.js:85` |
| `sw.js`（220） | Service Worker：`/api/*` 与 `/v1/*` 绝不缓存；导航 network-first；静态资源 cache-first + 后台再验证 | Service Worker 全局 | 预缓存清单 `web/sw.js:35`，API 豁免 `web/sw.js:150` |
| `style.css`（2187） | 设计系统 L1–L6：令牌 / 基础 / 布局 / 组件 / 工具 / 可访问性 + 动效与 PWA 补充 | — | 令牌 `web/style.css:16` |
| `styleguide.html`（320） | 组件样式指南页（浏览器直接打开） | — | 骨架屏示例 `web/styleguide.html:219` |
| `offline.html`（19） | Service Worker 断网兜底页 | — | — |
| `manifest.webmanifest`（40） | PWA 清单：图标、standalone、主题色 | — | — |
| `icons/*.png` | 192/512 普通图标 + 192/512 maskable + 180 apple-touch | — | 由 `scripts/gen-icons.cjs` 生成 |

#### 3.2 ES 模块（`web/app.js` + `web/modules/*.js`）

`app.js` 是**引导层**：导入各模块、承担跨模块的重画（`rerenderAll`）与最上层弹窗的 Esc / Tab
焦点锁定，然后按原顺序建立轮询、首屏加载并应用初始 hash。业务逻辑按职责拆成 18 个模块
（下表即**首屏静态模块图**，浏览器一定会取的那批；六个 `*-lazy.js` 是懒加载外观层，
见 3.2 的 chunk 表）：

| 模块（行数） | 负责 | 关键位置 |
| --- | --- | --- |
| `app.js`（119） | 引导层：回填 `window.AudioCppHubApp`、`rerenderAll`、`closeTopmostOverlay`、Esc / Tab 全局键盘绑定、启动顺序 | 回填 `web/app.js:40`，`rerenderAll` `:47`，`closeTopmostOverlay` `:63`，Tab 锁定 `:81`，Esc `:93`，启动 `:110`–`119` |
| `modules/dom.js`（48） | **基元层，零 import**：`$` / `el`（绑定自 `legacy-globals.js`）、`esc`、`safeHttpUrl`、行进入动画、`t`（绑定 `I18N.t`）、`Api`（绑定 `window.AudioCppHub.api`） | `$` `web/modules/dom.js:19`，`t` `:24`，`Api` `:27`，`esc` `:30`，`safeHttpUrl` `:36` |
| `modules/async-ui.js`（332） | **跨功能复用的 UI 原语**：toast（`notify` / `showToast`）、列表三态（`showSkeleton` / `renderEmptyState` / `renderStateError` / `renderListError`）、`setButtonBusy`、`parseApiError`、`/api/events` → toast 轮询；弹窗栈（`OVERLAY_IDS` / `topmostOverlay`）、`focusDialog` / `restoreDialogFocus`（焦点栈 + 背景 `inert`）、`bindMenuKeys`、`dismissToast`、`showBusy` / `hideBusy` | `showToast` `web/modules/async-ui.js:57`，`parseApiError` `:62`，`showSkeleton` `:90`，`renderListError` `:136`，`setButtonBusy` `:142`，`startEventsPolling` `:188`，`OVERLAY_IDS` `:196`，`focusDialog` `:225`，`dismissToast` `:242`，`bindMenuKeys` `:251`，`showBusy` `:271` |
| `modules/state.js`（30） | 跨模块共享的可变状态：模型清单 / 可执行文件 / 启动配置 / 当前选中模型 / 当前实例 + 各自的 `setXxx()` | `models` `web/modules/state.js:11`，`setModels` `:21` |
| `modules/routing.js`（122） | #88 hash 路由：`parseRoute` / `go` / `goPanel` / `applyRoute` + 路由意图 `pendingModelId` / `pendingInstanceId` / `pendingSettingsSection` + `window.hub*` 钩子 | `ROUTE_VIEWS` `web/modules/routing.js:25`，`parseRoute` `:41`，`go` `:58`，`applyRoute` `:80` |
| `modules/command-palette-lazy.js`（64） | **全局 Ctrl/Cmd-K 和弦的唯一所有者**（首屏必需：命令面板没有入口按钮）+ 命令面板的懒加载外观。`ensure` `web/modules/command-palette-lazy.js:25`，`openCommandPalette` `:40`，`closeCommandPalette` `:52`，和弦注册 `:58` |
| `modules/shell.js`（45） | 主题三态循环（`window.HubTheme`）、语言切换、移动端抽屉 | — |
| `modules/models.js`（164） | 模型列表（按 category 分组）、已配置黯淡态、空态、HF 仓库/镜像菜单（含 `role=menu` 键盘导航）、`selectModelById` | `loadModels` `web/modules/models.js:24`，`hfMirrorOf` `:55`，`renderModelList` `:109`，`selectModelById` `:147` |
| `modules/settings-lazy.js`（201） | **可执行文件登记**（首屏必需：启动弹窗下拉 + 模型卡片已配置态 + 设备探测缓存 + 增删改表单字段）+ 设置弹窗的懒加载外观 | `deviceCache` `web/modules/settings-lazy.js:29`，`loadExecutables` `:39`，`updateLaunchExec` `:57`，`parseEnvText` `:80`，`parseSessionOptionsText` `:100`，`openSettingsModal` `:156`，`relocalizeSettings` `:182`，`wireSettingsButtons` `:189` |
| `modules/launch.js`（438） | 启动模型弹窗：可执行文件选择、设备探测、权重路径、启动配置（Profile）、高级参数、启动请求 | `openLaunchModal` `web/modules/launch.js:17`，`probeDevices` `:90`，`loadProfiles` `:214`，`restoreWeightsPath` `:200`，`saveProfile` `:317` |
| `modules/instances.js`（232） | 实例列表、实例状态条、实例详情（`I18N.date`）、2s 轮询句柄 + 首屏骨架 | `startInstancePolling` `web/modules/instances.js:55`，`renderInstanceList` `:61`，`openInstanceDetail` `:165` |
| `modules/downloads-lazy.js`（160） | **下载数据 + 页头 ⬇️ 角标与其 2s 轮询**（首屏可见，不能懒加载）+ 两个下载弹窗的懒加载外观 | `getDownloads` `web/modules/downloads-lazy.js:33`，`refreshDownloads` `:58`，`startDownloadsPolling` `:64`，`updateDlBadge` `:70`，`openDownloadsModal` `:100`，`relocalizeDownloads` `:142`，`wireDownloadsButton` `:148` |
| `modules/tasks.js`（331） | 任务队列**与结果落版**：提交、跟踪、取消、完成、`reattachTasks` 重挂、侧栏任务行；`renderTaskResult` 按类别分派 + ASR / 分离 / 音乐 / 其它结果 + `clearResult` / `makeTrackRow` | `activePolls` `web/modules/tasks.js:21`，`submitTask` `:26`，`trackTask` `:48`，`reattachTasks` `:101`，`renderTaskResult` `:194`，`clearResult` `:242` |
| `modules/sidebar.js`（671） | 操作历史侧栏：历史加载与渲染（含骨架屏 / 三态）、分组、分组菜单（键盘导航）、四要素详情、隐私模式、任务行与历史行的列表组装、「清空」批量删除（走全局等待遮罩） | `openHistoryPanel` `web/modules/sidebar.js:19`，`loadHistory` `:79`，`renderSidebarList` `:125`，`deleteFinishedTasks` `:578`，清空处理 `:593` |
| `modules/panels.js`（866） | 工作区分发 + TTS / ASR / SEP / Music / Other 五类面板：`paramSchema` 渲染与收集、情感滑块、各面板提交；面板表单的 `VoiceSelect` / `AudioPicker` 实例在模块求值时一次性创建 | `voicePicker` `web/modules/panels.js:24`，`renderWorkspace` `:51`，`renderTtsPanel` `:294`，`buildEmotionSliders` `:536`，`renderAsrPanel` `:646` |

##### 懒加载 chunk（点击才打开的视图）

没有打包器，模块图里每个文件都是一次首屏请求。因此「点一下才用得上」的视图不进静态图，
改为**外观层 + 动态 import**：`npm run perf:budget` 认得这两种形状——懒加载 chunk 必须
进 `web/sw.js` 的 `PRECACHE_URLS`（离线冷启动点开仍要能用），但**不进**首屏体积 / 请求数，
也**不进** `index.html` 的 `modulepreload`（预载会把收益全部抵消）。

| 外观层（首屏） | 懒加载 chunk | 打开方式 |
| --- | --- | --- |
| `modules/stats-lazy.js`（79） | `modules/stats.js`（198）：用量与性能看板（`#/stats`，页头 📊）——`GET /api/stats`，总量卡片 + 每模型卡片（任务数 / 成功率 / 音频时长 / 输出体积 / 排队与执行 P50-P95 / 实时率 RTF）。`openStatsPanel` `web/modules/stats.js:26` | `routing.js` 静态 import 外观层，点 📊 路由到 `#/stats` 时 `import("./stats.js")` |
| `modules/file-browser-lazy.js`（48） | `modules/file-browser.js`（470）：服务器端文件 / 目录选择弹窗，overlay 在首次 `open()` 时动态创建。`open` `web/modules/file-browser.js:100`，`cancel` `:387`，`relocalize` `:421` | `launch.js`（权重目录 / GGUF / 可执行文件三个「浏览…」按钮）与经典脚本 `audio-picker.js`（本地路径页签）都经外观层的 `browseServerFile` 打开 |
| `modules/voices-panel-lazy.js`（68） | `modules/voices-panel.js`（257）：音色库管理面板（页头 🎙）——列表 / 试听 / 行内编辑 / 删除 / 「用于 TTS」/ 添加。`openVoicesPanel` `web/modules/voices-panel.js:25`，`closeVoicesPanel` `:37` | `routing.js` 静态 import 外观层（页头 🎙 由 `wireVoicesButton` 接线、`#/voices` 路由与 Esc 走 `openVoicesPanel` / `closeVoicesPanel`）；经典脚本 `voice-select.js` 的「管理音色库」按钮经外观层挂上的 `window.openVoicesPanel` |
| `modules/downloads-lazy.js`（160） | `modules/downloads.js`（211）：下载管理弹窗（进度 / 暂停 / 续传 / 删除 / 填入权重）+ 按模型下载弹窗（包 / token / 下载源）。`openDownloadsModal` `web/modules/downloads.js:31`，`renderDownloadList` `:44`，`loadMdlPackages` `:136`，`relocalize` `:208` | `routing.js`（页头 ⬇️ 与 `#/downloads`）与 `models.js`（模型卡片的 ⬇ 按钮）都 import 外观层；数据与角标留在外观层，chunk 经 `getDownloads()` 读 |
| `modules/settings-lazy.js`（201） | `modules/settings.js`（208）：设置弹窗的三个分节——通用（界面语言 / 主题）、HTTPS 证书（全站唯一的 blob 下载路径）、可执行文件列表渲染。`openSettingsModal` `web/modules/settings.js:20`，`activateSettingsSection` `:32`，`loadCertStatus` `:60`，`renderExecList` `:145`，`relocalize` `:202` | `routing.js`（页头 ⚙ 与启动弹窗的「去添加程序」）import 外观层；可执行文件**数据**（启动弹窗也要用）留在外观层，chunk 经 `state.js` 的活绑定读 |
| `modules/command-palette-lazy.js`（64） | `modules/command-palette.js`（136）：#88 命令面板——候选项拼装、过滤、渲染、↑↓/Enter/Esc。`paletteSources` `web/modules/command-palette.js:25`，`renderPalette` `:42`，`openCommandPalette` `:94` | `app.js`（Esc 关最上层弹窗）import 外观层；**全局 Ctrl/Cmd-K 和弦由外观层独家注册**，因此首按就有效——chunk 里刻意不再注册同一个 `document` keydown，两层监听会各处理一次同一次按键（打开又立刻关掉） |

**切分线不总是「整个模块 vs 首屏」**。音色库与命令面板是纯点击视图（整块搬进 chunk）；
下载与设置是**按「首屏可不可见」切**：页头 ⬇️ 角标要在首屏跳动、`loadExecutables` 决定模型
卡片的已配置黯淡态与启动弹窗的可执行文件下拉，因此这两块的数据与状态机必须留在外观层，
搬走的只是弹窗 DOM 渲染。判断口径一句话：**首屏能看见 / 被首屏其它模块依赖的东西留在
外观层，只有点开面板才需要的渲染进 chunk。**

**为什么每块都要一层外观**，而不是在调用点直接 `import()`：`app.js` 有两条**同步**路径要碰
它们——Esc 关最上层弹窗（`closeX`）与语言切换重画（`relocalizeX`）——而这两条在对应 chunk
从未加载时同样会被触发（弹窗都没建，哪来的 Esc）。外观把「已加载的模块命名空间」记在模块级
变量里，让同步路径保持 no-op（三个弹窗是静态 DOM，外壳已显示而 chunk 还在路上时则只收
外壳），只有异步的打开路径才 `await` chunk。另外**页头 / 入口按钮的 onclick 也在外观层**
（`wireStatsButton` / `wireVoicesButton` / `wireDownloadsButton` / `wireSettingsButtons`，
由 `routing.js` 传入导航函数以避开模块环）——否则按钮要等 chunk 到位才有点击行为。
命令面板的入口不是按钮而是**全局和弦**，因此同样归外观层（`command-palette-lazy.js:58`）。
`test/unit/stats-lazy.test.mjs` 与 `test/unit/lazy-panels.test.mjs` 钉住了这层
「未加载即空转」「首屏数据不懒加载」「外壳先出」「和弦只注册一次」的守卫，
`e2e/stats.spec.mjs`、
`e2e/file-browser.spec.mjs`、`e2e/voices.spec.mjs`、`e2e/downloads.spec.mjs`、
`e2e/executable.spec.mjs` 钉住「首屏不取 chunk、点开才取、再开不重复取」。

> `web/modules/` 下**新增文件前先问一句**：它首屏真的需要吗？不需要就走上面这套外观层。
> 需要但很小（< 1 KiB 的纯转发），并进职责最近的已有模块——模块数 = 首屏请求数。

#### 3.3 共享可变状态与 setter

ES 模块的 `import` 是**活绑定**（读永远看到最新值），但**不能给导入的绑定赋值**。
因此 `modules/state.js` 里每个可写绑定都额外导出一个 `setXxx()`，写方一律走 setter
（`models.js` / `settings.js` / `launch.js` / `instances.js`）。单一写方的状态**不进**
`state.js`：下载任务、实例列表、路由意图（`pending*`）等仍与各自功能模块放在一起。

`const` 的可变容器（`Map` / `Set` / 数组，如 `taskViews`、`groupCollapsed`、`enteredRows`）
直接导出即可——对象身份共享，读写都走活绑定。

#### 3.4 经典脚本与模块如何共存

模块脚本**隐式 defer**：整份文档解析完成后才执行，晚于所有普通脚本。这带来两个后果，
都由 `web/legacy-globals.js`（普通脚本，必须早于其它经典脚本）解决：

| 名字 | 定义处 | 经典脚本用途 |
| --- | --- | --- |
| `window.$` / `window.el` | `legacy-globals.js`（唯一真实实现）；`modules/dom.js:19` 绑定并再导出 | `audio-picker.js` 拼 DOM 与取节点 |
| `window.showToast` | `legacy-globals.js` 的转发器 → `modules/async-ui.js:57` | `audio-picker.js`（`web/audio-picker.js:514`） |
| `window.focusDialog` / `window.restoreDialogFocus` | 同上 → `web/modules/async-ui.js:258` 与 `web/modules/async-ui.js:269` | 当前无经典脚本使用（音色库面板已改成懒加载模块），为后续经典组件保留 |
| `window.renderStateError` / `window.renderEmptyState` | 同上 → `web/modules/async-ui.js:102` 及同段 | 同上（音色库面板改成模块后直接 import `async-ui.js`） |

转发器在目标尚未就位时静默返回（等价于原来 `typeof window.showToast === "function"` 的保护）；
真实实现由 `web/app.js:40` 在模块求值时回填到 `window.AudioCppHubApp`。

反向的「经典脚本 → 模块」还有两处不走这层桥：`audio-picker.js` 用
`import("./modules/file-browser-lazy.js")` 动态 import 文件浏览器；`voice-select.js` 经
`window.openVoicesPanel`（由 `modules/voices-panel-lazy.js` 挂上）打开音色库面板。

`window.parseApiError`（转发到 `modules/async-ui.js:62`）保留在桥上，但**经典组件已不再需要它**：
`Api.*` 失败时抛的 `ApiError` 自带 `code` / `params` / 已本地化的 `message`，`renderStateError`
与 `I18N.errText` 都能直接消费。该转发器只留给仍要解析原始响应文本的调用点。

主题与界面语言的首屏恢复由 `<head>` 里的 `web/boot.js` 在样式表之前完成，与模块化无关。
模块改为 defer 之后，所有 `$(...)` DOM 取值都发生在解析完成之后，比原来的经典脚本更安全。

#### 3.5 刻意的循环依赖

`dom.js` 是**零 import 的叶子**（见 3.2），因此它不参与任何环；`async-ui.js` 只依赖
`dom.js`，也不参与。剩下的环全部发生在「功能模块之间」，共 5 组：

| 依赖 | 为什么无法单向 |
| --- | --- |
| `tasks.js` ⇄ `sidebar.js` | 任务完成要刷新侧栏；侧栏的任务行又需要取消 / 耗时等队列接口 |
| `sidebar.js` ⇄ `panels.js` | 工作区重画要刷新侧栏历史；侧栏的「载入」要回填 TTS 表单 |
| `models.js` ⇄ `launch.js` | 切模型要恢复启动表单的权重路径；配置变化要刷新模型卡片的已配置态 |
| `models.js` ⇄ `instances.js` | 选模型要刷新实例列表；实例就绪态影响模型「已配置」判定 |
| `models.js` ⇄ `panels.js` | 选模型要重画工作区；工作区分发读模型清单 |
| `routing.js` ⇄ `sidebar.js` / `downloads-lazy.js` / `settings-lazy.js` / `stats-lazy.js` / `voices-panel-lazy.js` / `instances.js` / `models.js` | `applyRoute` 要开关各面板；各 `closeX()` 又要通过 `window.hubPanelClosed` 回写 hash。按钮接线走**反向注入**（`wireXxxButton(go, goPanel, …)`，由 routing 把导航函数传进外观层）以避开这一层环 |

这些都**只在运行期回调里互相调用**，模块求值期互不读取对方的绑定（已逐条核对：
循环双方顶层语句的跨模块读取全部是 `$`，而 `dom.js` 是无 import 的叶子模块）。
ES 模块的函数声明提升 + 活绑定让这种形状安全，`no-use-before-define` / `import/no-cycle`
这类规则在本仓库刻意不启用。

> **为什么不去掉它们**：把 `models.js → launch.js` 变成单向的机械做法只有一种——把
> `restoreWeightsPath` 挪进 `state.js` 再各自 import。但那会把「恢复权重路径」这种带 DOM
> 副作用的业务语义塞进状态层，换来的是一次行为不变、结构变差的改动。**已评估、刻意保留。**
> 唯一被真正消掉的是 `dom.js` ⇄ `async-ui.js`（原 `dom.js` 的 `renderListError` 薄封装
> 需要回调 `renderStateError`）：把那个薄封装移进 `async-ui.js` 就断了，基元层从此无环。

### 4. 脚本加载顺序与初始化

`index.html` 里的加载顺序（**顺序有语义**）：

1. `<head>` 中先加载 `boot.js`（`web/index.html:14`），再挂 `style.css`（`web/index.html:15`）——主题 / 语言要在首次绘制前生效。
2. 紧接着是 17 条 `<link rel="modulepreload">`（`web/index.html:24`–`40`）——模块图的并行预取与预解析，
   放这里是为了在解析 body 之前就把它们发出去（见首屏「模块图要预载」一节）。**懒加载 chunk 刻意不在其中**。
3. `</body>` 前先是一串**经典脚本**（`web/index.html:519`–`536`）：
   `i18n.zh.js` → `i18n.en.js` → `i18n.js` → `api-client.js` → `wav.js`
   → `legacy-globals.js` → `audio-picker.js` → `voice-select.js`
   → `motion.js` → `pwa.js`。
4. 最后是**唯一的模块入口** `<script type="module" src="/app.js">`（`web/index.html:541`），
   它按 `import` 图拉取 `web/modules/*.js`（此时已被 modulepreload 预取到，直接命中）。

为什么是这个顺序：

- **词典先于运行时**：`i18n.js` 在初始化时读 `window.I18N_ZH` / `window.I18N_EN`（`web/i18n.js:13`–`14`），词典没到位就会得到空字典、`t()` 全部回落成 key 本身。**改动 i18n 时永远先加词典文件。**
- **`api-client.js` 先于所有发起请求的脚本**（#62 收口后的硬约束）：普通 `<script>` 在解析期同步执行、按 `<script>` 顺序求值，`api-client.js` 在 `web/index.html:523`，因此在它之后的 `audio-picker.js`（`:530`，`Api` 在 `:9`）、`voice-select.js`（`:531`，`Api` 在 `:10`）求值时，`window.AudioCppHub.api` **已经存在**，各 IIFE 顶部可以直接 `const Api = window.AudioCppHub.api`；模块入口隐式 defer，必然更晚。**新经典组件脚本若要发请求，必须放在 `api-client.js` 之后**（或自行防御性取值）。
- `legacy-globals.js` 必须早于所有引用 `$` / `el` / `showToast` 的经典脚本
  （`audio-picker.js` / `voice-select.js`）——模块是 defer 的，
  真实实现在模块里才存在，桥必须先把 `window.$` 装好。
- `panels.js` 在模块求值时实例化 `VoiceSelect` / `AudioPicker`（`web/modules/panels.js:24`），因此这两个组件脚本必须先于模块入口。
- `motion.js` 早于模块入口：它监听捕获阶段的点击与 `themechange`，先注册才能覆盖首屏交互。
- `pwa.js` 早于模块入口：Service Worker 越早注册，越早接管后续静态资源；它自身不依赖 app 逻辑。
- 模块入口天然最后：`<script type="module">` 隐式 defer，一定在所有普通脚本之后执行。
- **新经典脚本要用 IIFE 包裹**，避免顶层 `const` 重名冲突（参考 `web/audio-picker.js:6`、`web/voice-select.js:7`、`web/motion.js:17`）；**新业务逻辑进 `web/modules/`**，不要往 `app.js` 里堆。
- 脚本位于 `<body>` 末尾，DOM 已解析完毕，模块顶层可直接 `document.getElementById`。

> **新增或删除前端脚本 / 模块时，三处清单必须同步**：`web/index.html`（`<script>` 与
> `rel="modulepreload"`）、`web/sw.js` 的 `PRECACHE_URLS`、`web/README.md` 的模块地图。
> 漏掉 SW 预缓存不会让安装失败（`install` 用 `allSettled`），但离线冷启动会在该脚本处断掉；
> 漏掉 `modulepreload` 不会报错，只会让那个模块退回串行取。`npm run perf:budget` 会对
> 「模块图 / modulepreload / 预缓存」做三方一致性校验。

`rerenderAll`（`web/app.js:47`）是语言切换后的统一重渲染入口：它会重渲模型列表、实例、设置面板，刷新所有已注册的 `AudioPicker` / `VoiceSelect` 文案，并把三个单例（文件浏览器 / 设置 / 下载）交给各自外观层的 `relocalizeXxx()`（见 6. 编码约定的 i18n 条目）。

### 5. 状态与事件流

- **可变状态**按模块就近存放：跨模块共享的 5 个绑定在 `web/modules/state.js`（配 `setXxx()`），
  单一写方的状态留在自己的模块里（`downloads-lazy.js` 的 `downloads`、`instances.js` 的 `instances`、
  `settings-lazy.js` 的 `editingExecId`、`routing.js` 的 `pending*`）。任务相关另有三张 Map：
  `activePolls` / `taskViews` / `taskDetails`（`web/modules/tasks.js:21`–`23`）。
- **localStorage 键**：`hub-theme`、`hub-lang`（`web/boot.js:14`、`web/boot.js:56`）、`hub-model`、`hub-privacy`、`hub-threads`，以及按模型持久化的权重路径 / 启动配置键。语言初值优先级（`localStorage` → `navigator.language`）见 `web/i18n.js:23`。
- **轮询模型**：**不要再写 `setInterval`**。全部交给 `Api.poll`，它保证「上一轮结束才排下一轮（不叠加请求）、标签页隐藏时不发请求、重新可见立即补一次」，句柄 `stop()` 即可无残留收尾。
  - 全局 2s 轮询：实例 + 事件 + 下载（`web/app.js:110`–`112`，各自的 `start*Polling` 在 `instances.js` / `async-ui.js` / `downloads-lazy.js`——下载的轮询句柄与角标留在首屏，弹窗才是懒加载的）。
  - 任务单独 2s 轮询：每个进行中的任务一个 `Api.poll` 句柄（`web/modules/tasks.js` 的 `trackTask`），到终态即 `stop()`。
  - 轮询句柄由建它的模块持有（`instances.js` / `downloads-lazy.js` 的 `*Poller`、`tasks.js` 的 `activePolls`），组件不再重建时调用 `.stop()`；测试或整体卸载可用 `Api.stopAllPollers()`。
  - `web/` 里还剩两处 `setInterval`，都**不是**服务器轮询，只是本地 UI 时钟，不要误改：录音计时（`web/audio-picker.js` 的 `recTimer`）与全局等待遮罩的耗时显示（`web/modules/async-ui.js` 的 `busyTimer`）。
- **任务生命周期**：`submitTask`（`web/modules/tasks.js:26`）→ `trackTask`（`:48`，入侧栏并轮询）→ `finishTask` → 结果渲染（`web/modules/tasks.js:194`）。
  TTS 结果直接用历史 wav URL（不处理 base64），其余类别再取 `/result` JSON。页面加载 / 切换模型时 `reattachTasks`（`web/modules/tasks.js:101`）经 `GET /api/tasks?modelId=` 重挂。
- **hash 路由（#88）**：`#/model/<id>` / `#/instance/<id>` / `#/history` / `#/voices` / `#/downloads` / `#/stats` / `#/settings`。
  打开 / 关闭面板与选择模型统一经 `modules/routing.js` 的 `go()` 改 hash，`applyRoute()` 是唯一应用视图的地方，
  因此前进 / 后退可自然还原，深链接刷新后也能恢复面板与选中项。`pendingModelId` / `pendingInstanceId` /
  `pendingSettingsSection` 记录「目标数据还没到」的意图，等对应模块拿到数据再兑现。
  `applyRoute()` 在首屏末尾由 `web/app.js:119` 调一次。
- **跨组件事件**：主题切换广播 `themechange`（`web/boot.js` 与 `web/modules/shell.js` 各自 dispatch），`motion.js` / `pwa.js` / 音频组件各自监听（重绘波形、切换过渡、刷新 `theme-color`）。
- **关键 DOM 锚点**（`index.html`）：页头按钮 `#voices-btn` / `#history-btn` / `#downloads-btn` / `#lang-toggle` / `#settings-btn` / `#theme-toggle`；左栏 `#left` 内 `#instance-list`、`#model-list`；右栏 `#right > #workspace`；五类面板 `#panel-tts`、`#panel-asr`、`#panel-sep`、`#panel-music`、`#panel-other`；历史 `#history-panel > #history-list`；音色库 `#voices-panel > #voices-list`；命令面板 `#command-palette`；若干弹窗 `#launch-modal`、`#settings-modal`、`#model-dl-modal`、`#downloads-modal`、`#instance-detail-modal`、`#busy-overlay`；以及 `#toast-root`、`#drawer-overlay`。

### 6. 编码约定

- **无框架、无构建**。新增交互优先复用现有模式（DOM 辅助 + 手写渲染），不要引入打包器或框架。
- **不要为了「分层」再拆出新模块**。没有打包器，模块数 = 首屏请求数；十几行的微模块会直接
  顶高 `npm run perf:budget` 的请求数预算。新增代码优先并进职责最近、已存在的模块。
- **所有请求走 `Api.*`**（`web/modules/dom.js:27`）。需要新的错误码语义时，扩展 `web/api-client.js` 的 `CODE`，不要在调用点自己 `try/catch fetch`。按意图选助手：
  - 一次性 GET / POST / PUT / DELETE → `Api.get` / `Api.post` / `Api.put` / `Api.del`；方法由调用点决定时才用 `Api.request(path, { method, body })`。
  - 路径里的动态段用 `{name}` 占位 + `params: { name }`（内部 `encodeURIComponent`），查询串用 `query: { k: v }`——**不要手拼 URL**。
  - 响应必须是数组（列表、下拉、面板数据）→ `Api.list`，非数组会按 `CLIENT_BAD_SHAPE` 走错误分支，而不是被静默当成空数组。
  - 真正需要原始 `Response`（blob 下载、音频字节流）→ `Api.get(url, { raw: true })`；它对非 2xx 仍然抛 `ApiError`。
  - 定时刷新 → `Api.poll`（不要把一次性请求改成轮询，也不要把轮询改成 `setInterval`）。
  - 失败按原意处理：需要提示的走 `catch` / `onError`；**原本就「忽略错误、以下一轮状态为准」的地方写显式的 `.catch(() => {})`**，不要再靠裸 `fetch` 的偶然行为。
- **安全渲染**（防存储型 XSS）：任何服务端 / 用户可控字符串插入 HTML 前必须 `esc()`（`web/modules/dom.js:30`）；能 `textContent` 就别 `innerHTML`；拼 HTML 用 `el()`（`web/modules/dom.js:19`）；URL 属性用 `safeHttpUrl()`（`web/modules/dom.js:36`）或 `esc()`。**绝不把未转义数据塞进 `innerHTML`。**
- **i18n**：
  - 新文案同时写入 `web/i18n.zh.js` 与 `web/i18n.en.js`（当前 605 键），并跑 `node scripts/check-i18n-parity.js` 校验对等。该脚本除中英互相齐全外，还独立扫 `web/*.html` 的 `data-i18n*` 引用键——**两侧同时漏配**的键（页面上表现为裸 key）只有这条检查能看见。
  - 动态文案用 `t()`（`web/modules/dom.js:24`，即 `I18N.t` 的模块侧入口）；静态 DOM 用 `data-i18n` / `data-i18n-placeholder` / `data-i18n-title` / `data-i18n-aria-label` 标注，由 `applyI18n()`（`web/i18n.js:106`）批量替换。
  - 自定义组件实现 `refreshLabels()` 并注册到 `window.__audioPickers` / `window.__voiceSelects`，这样 `rerenderAll`（`web/app.js:47`）能统一刷新。
  - **单例外**：服务器端文件选择器是模块级单例（overlay 只在首次 `open()` 时创建），没有实例登记表，
    因此它由 `rerenderAll` 直接调外观层的 `relocalizeFileBrowser()`（`web/app.js:60` → `web/modules/file-browser-lazy.js:46`）。
    新增**单例式**组件（内部自建 overlay / 持有自己的 DOM）就照这个形状接，不要为了统一去造一张登记表。
    外观层在 chunk 尚未加载时是 no-op（那里根本没有 overlay 可刷新），所以 `rerenderAll` 可以无条件调。
    现状是防御性路径而非活 bug：fb-overlay 打开时 `syncInert` 会把 `<header>` 设成 inert，
    页头语言按钮点不到，也没有别的语言切换入口。`test/unit/file-browser.test.mjs` 钉住了「rerenderAll
    调它」与「外观层未加载即空转」这两条。
  - **懒加载面板同理走外观层**：设置与下载两块的面板文案也由 `t()` 生成，因此
    `rerenderAll` 调 `relocalizeSettings()`（`web/app.js:55`）与 `relocalizeDownloads()`（`web/app.js:56`），
    由外观层在 chunk 已加载时转发。这三条 `relocalizeXxx()` 都是无参同步调用，chunk 未加载即空转。
  - 多语言字段用 `I18N.pick`（`web/i18n.js:146`）；后端错误用 `I18N.errText`（`web/i18n.js:131`）解析 `{"code","params"}`，
    或在模块里用 `parseApiError`（`web/modules/async-ui.js:62`）拿到带 `code` / `params` 的 Error。
  - 列表 / 按钮的三态统一用 `web/modules/async-ui.js`：`showSkeleton` / `renderEmptyState` / `renderStateError` /
    `setButtonBusy`，不要在调用点各拼一套。**等待时间不可知的批量操作**才用全局遮罩 `showBusy` / `hideBusy`
    （`web/modules/async-ui.js:271`），局部可知的操作一律用 `setButtonBusy`。
  - **数字 / 字节 / 日期 / 百分比一律走 `I18N.num` / `bytes` / `date` / `percent`**（`web/i18n.js:71`、`86`、`78`、`101`），它们基于 `Intl`，随语言变化。不要自己拼 `KB` / `MB` 或千分位。
- **CSS**：设计系统分 L1–L6（`web/style.css:16`–`1918`）。主题变量 `--bg` / `--text` / `--accent` / `--card` 等分深色 `:root[data-theme="dark"]`（`web/style.css:85`）与浅色 `:root[data-theme="light"]`（`web/style.css:109`）；默认跟随系统（`web/boot.js:4` 的 `prefers-color-scheme`）。新颜色 / 阴影一律加变量，不硬编码。**同类选择器只允许存在一处定义**——骨架屏曾因 #87 / #88 两版各写一份 `.skeleton` 而互相覆盖（现已合并为 `web/style.css:1670` 一份）。
- **动效令牌**：时长 `--dur-1/2/3` + 缓动 `--ease-out` / `--ease-in-out`（`web/style.css:20`–`24`）；只动 `transform` / `opacity` 避免重排；**必须尊重 `prefers-reduced-motion`**（`web/style.css:1921` 与 `web/style.css:2076`）：装饰动画可停，加载 / 工作中等必要反馈保留。模式说明见 [`../docs/motion.md`](../docs/motion.md)。
- **中文注释**：代码注释用中文（与 Go 侧一致），标识符、API 字段、CSS 变量用英文。
- **CSP**：不写内联脚本、`on*` 事件属性、内联 `style` 属性，不引外部源；`index.html:7` 的 CSP 必须保持 `script-src 'self'`。
- **Service Worker**：`/api/*` 与 `/v1/*` **绝不缓存**（`web/sw.js:142` 直接 `return`，不调 `respondWith`）；导航走 network-first，避免 `index.html` 读到旧版本；任何被服务端标记 `Cache-Control: no-store/no-cache` 的响应也不落缓存（`web/sw.js:80` 的 `noStore`）。详见 [`../docs/pwa.md`](../docs/pwa.md)。

### 7. 无构建地运行与调试

完整功能（推荐）：

```bash
# 仓库根目录
go run .            # 默认 http://127.0.0.1:8080（见 hub.config.example.json）
# 或
go build -o audio.cpp-hub . && ./audio.cpp-hub
```

`ensureWorkDir`（`main.go:68`）会自动定位含 `web/` 的工作目录，因此从子目录启动一般也能找到前端。改完 `web/` 下的 JS/CSS 直接刷新浏览器即可：`index.html` 不缓存，其余资源 1 小时缓存（必要时硬刷新）。

只调 UI（不启后端，适合调样式 / 布局）：在 `web/` 目录起任意静态服务器，例如 `python3 -m http.server 8000`。此时 `/api/*` 全部 404，列表与任务为空字段，仅用于查看静态外观。注意 Service Worker 只在 `http:` / `https:` 下注册，`file://` 下不会生效——调试 PWA 请用静态服务器而不是直接双击 `index.html`。

服务端如何提供文件：`api.go:165` 的 `staticHandler`——目录请求只回 `index.html`、禁用目录列表，`index.html` 设 `Cache-Control: no-cache`（`api.go:203`），其余 `max-age=3600`（`api.go:205`）。

---

## 第二部分 · 开发期工具链（仅本地 / CI）

`npm install` 后可用以下脚本（见根目录 `package.json`）：

| 脚本 | 作用 |
| --- | --- |
| `npm run check:types` | `tsc -p tsconfig.json`：`checkJs` + `noEmit`，对 `web/*.js` + `web/modules/*.js` 做类型检查 |
| `npm run lint` | ESLint 10 扁平配置：同一套规则集，按 `sourceType` 分「经典脚本」与「ES 模块」两块 |
| `npm run format:check` | Prettier 校验（**范围见 `.prettierignore`，有意排除 `web/`**，见下） |
| `npm run format` | Prettier 重写（同样遵循 `.prettierignore`） |
| `npm run check` | 依次跑上面三项，CI 用的就是这个 |
| `npm run test:unit` | `node:test` 单元测试（纯函数，无需浏览器） |
| `npm run test:e2e` | Playwright e2e（headless Chromium + mock 后端） |
| `npm run ui:inventory` | 生成 `ui_inventory.json` 与 `docs/ui.md` |
| `npm run ui:inventory:check` | 校验两者与源码一致（CI 防漂移） |
| `npm run perf:budget` | 首屏 JS/CSS raw+gzip 体积与请求数预算检查，并校验「模块图 / modulepreload / SW 预缓存」三方一致 |
| `npm run check:i18n` | 中英词典键一一对应 + 占位符一致 + `web/*.html` 的 `data-i18n*` 引用键都存在 |
| `npm run check:sw` | `web/sw.js` 的 `PRECACHE_URLS` 覆盖 `index.html` 本地引用、模块图传递闭包与固定外壳 |

`check:types` 用 `noEmit` 保证**不产出任何 JS**：`tsc` 在这里只是检查器，输出目录为空，
不可能被误当成构建产物进入发行包。

### 工具能查出什么

- **tsc**：未定义的标识符、参数个数不符、拼错的跨文件公开接口、死代码（未使用的局部变量）、
  `switch` 贯穿、`async` 误用。跨模块的 import 由 tsc 按真实模块解析——**导入不存在的导出成员
  会直接报 `has no exported member`**，这是拆模块后最强的兜底。
- **ESLint**：`==`/`!=`（`== null` 除外）、`var`、可改的 `let`、未使用变量（含未使用的 import）、
  不可达代码、重复键/参数、重复 import、正则误用、恒真条件。
  模块块额外开 `no-implicit-globals`（模块不产生隐式全局），规则集由 `SHARED_RULES` 在两块里各展开一次。
  另外因为 `web/` 不走 Prettier，`web/` 的**排版约束由 ESLint 承担**：
  引号（双引号）、分号、无尾逗号、对象花括号空格、键/运算符/关键字空格、
  文件末尾换行、行尾无空格、空行上限、具名函数不留空格而匿名函数留空格。
- **Prettier**：只覆盖 `.prettierignore` 范围外的文件——根目录 JSON 清单、
  CI workflow、`e2e/` / `test/` / `scripts/` 下的 `.mjs`、工具链自身的配置。

### 已知降级（显式声明，非静默关闭）

`web/globals.d.ts` 与 `.prettierignore` 里逐条写明了原因，这里汇总：

1. **`tsconfig.json` 未开启 `strict` / `strictNullChecks` / `noImplicitAny`。**
   `web/` 是无类型经典脚本，全局约 6100 行 DOM 操作代码。开启严格空值检查会产生上千条
   「`getElementById` 可能为 null」「`querySelector` 返回 `Element` 没有 `.value`」——这些既
   不可在不重写的前提下消除，也不指示任何缺陷。已保留的检查包括 `noUnusedLocals`、
   `noFallthroughCasesInSwitch`、`noImplicitOverride` 等有实际价值的项。

2. **`modules/dom.js` 的 `$()` / `el()` 返回 `any`。**
   它们是全站最底层的 DOM 取值入口（实现定义在 `legacy-globals.js`，模块侧只绑定再导出），
   上千个调用点会立刻访问 `.value` / `.checked` / `.dataset` / `.onclick` 等「只有具体标签才声明」的成员。
   逐点加断言等于重写，因此显式放宽。
3. **`Element` / `EventTarget` 增补了 4 个成员**（`dataset`、`title`、`onclick`、`value`、
   `closest`）。`document.querySelectorAll(".tab")` 这类通用选择器无法推断标签，TypeScript 只能
   给回 `Element`，而 `Element` 按规范不声明这些成员——运行时它们确实都在。代价是
   `document.querySelector("div").value` 这类误用不再报错，属于有意接受的上限。

4. **`web/` 不在 Prettier 的检查范围内。**
   手写脚本的排版包含 Prettier 无法复现的两点：IIFE 函数体不缩进（`indent` 规则开启会产生
   **837 条**违规）、行尾注释按列对齐（`no-multi-spaces` 开启会产生 **18 条**违规）。
   统一排版需要重排约 2500 行 / 6100 行的纯空白改动（实测 `printWidth=120` +
   `arrowParens=avoid` 已是最小），无法人工审阅，收益仅为风格统一、无缺陷发现能力。
   改由 ESLint 的排版类规则承担约束（见上）。`docs/diagrams/**` 同样排除：那是绝对定位
   坐标 + 内联样式的手写 HTML，重排会破坏 `scripts/check-diagrams.py` 校验的可访问性契约。

5. **`web/sw.js` 的 Service Worker realm 类型手写最小声明。**
   Service Worker 跑在 `ServiceWorkerGlobalScope`，既不是 `window` 也不是 `Worker`。
   `tsconfig.json` 的 `lib` 只含 `ES2022/DOM`；加 `lib.webworker` 会与 `lib.dom` 在同一
   program 内重复声明 `self` / `fetch` / `caches` 等符号，因此按 `globals.d.ts` 开头的原则
   「只声明各模块被实际用到的公开成员」手写 `HubServiceWorkerScope` 等，由 `sw.js` 就地 cast。
   文件内的业务逻辑仍受 tsc 正常检查。

降级**不会静默漂移**：新增的经典脚本公开接口若在 `globals.d.ts` 里没声明，tsc 会立刻报
`Cannot find name`（模块之间不依赖这里，靠 import/export 校验）；新增的数组型字典键若没在 `I18NApi.t` 补重载，调用侧会报
`.forEach is not a function`。两者都是硬失败。

### 已知副作用：`go list ./...` 会走进 `node_modules`

Go 的 `./...` 包匹配会跳过 `.`/`_` 前缀与 `testdata` 目录，但**不跳过 `node_modules`**。
执行过 `npm install` 后，`go list ./...` / `go test ./...` 会多列出一个
`…/node_modules/flatted/golang/pkg/flatted`（某个依赖恰好附带 Go 源码）。

这是无害的：该包能正常编译，`go vet` / `go test` / `gofmt -l .` 结果均不受影响。
CI 也不受影响——`quality` job 从不执行 `npm ci`，`web-toolchain` / `frontend` job 不执行任何
Go 命令，两者不会同时存在 `node_modules`。仅提示本地看到该多余条目时不必意外。

### 改动本目录后

```bash
npm install
npm run check          # 三项全过再提交
npm run format         # 仅当 format:check 失败时（注意范围不含 web/*.js）
```

`web/*.js` 的排版问题由 `npm run lint` 报告（`eslint web --fix` 可自动修大部分），
不在 `npm run format` 的范围内。

改动 `window.*` 的公开接口时，**同时**更新 `web/globals.d.ts`（供 tsc）与
`eslint.config.js` 的 `languageOptions.globals`（供 `no-undef`），并保证 `index.html`
底部的 `<script>` 顺序满足依赖关系。新增经典脚本要走 `web/legacy-globals.js` 桥接，
新增业务逻辑进 `web/modules/*.js`（`tsconfig.json` 的 `include` 已含该目录）。改动 `index.html`
的脚本清单或模块图时，记得同步 `index.html` 的 `modulepreload` 清单与 `web/sw.js` 的
`PRECACHE_URLS`，并重跑 `npm run ui:inventory` 提交产物（`scripts/ui-inventory.mjs` /
`scripts/perf-budget.mjs` 都从 `index.html` 反推资源清单，无需手改）。

---

## 相关文档与设计资产

| 文档 | 内容 |
| --- | --- |
| [`../TESTING.md`](../TESTING.md) | 前端 e2e / 单元测试 / 性能预算与本地运行方式 |
| [`styleguide.html`](styleguide.html) | 组件样式指南页（在浏览器中打开） |
| [`../docs/ui.md`](../docs/ui.md) | UI 清单：界面 / 控件逐项登记（由 `npm run ui:inventory` 生成） |
| [`../docs/motion.md`](../docs/motion.md) | 动效系统：令牌、模式、reduced-motion 降级 |
| [`../docs/pwa.md`](../docs/pwa.md) | PWA：Service Worker 缓存策略、更新流程、图标生成 |
| [`../docs/media/README.md`](../docs/media/README.md) | 演示 GIF 录制流程（`scripts/record-demos.cjs`） |
| [`../docs/diagrams/`](../docs/diagrams/) | 视觉文档：19 张架构 / 时序 / 状态图 + `previews/`，入口见 `README.md`、`INVENTORY.md` |
| [`../docs/API.md`](../docs/API.md) | 前端调用的 `/api/*` 接口契约 |
| [`../docs/assets/`](../docs/assets/) | README 演示 GIF |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | 通用贡献流程与代码约定 |
| [`../SECURITY.md`](../SECURITY.md) | 威胁模型与漏洞上报渠道 |

## 贡献检查清单

- [ ] 新文案同时加入 `web/i18n.zh.js` 与 `web/i18n.en.js`；`node scripts/check-i18n-parity.js` 通过。动态用 `t()`，静态用 `data-i18n*`。
- [ ] 所有请求走 `Api.*` 而不是裸 `fetch`（`web/` 内唯一的 `fetch` 在 `web/sw.js` 的 Service Worker 处理器里，不在业务代码范围）；所有服务端 / 用户数据进 HTML 前 `esc()`；URL 用 `safeHttpUrl()`。
- [ ] 新增/删除前端脚本时同步 `web/index.html`、17 条 `modulepreload`、`web/sw.js` 的 `PRECACHE_URLS` 与本 README 的模块地图；新经典脚本若要发请求，必须排在 `api-client.js` 之后。
- [ ] 新增「点开才用得上」的视图时走 3.2 的**外观层 + 动态 import** 形状：chunk 进 `PRECACHE_URLS`，**不进** `modulepreload`，同步路径（Esc / 语言切换）经外观层 no-op 转发，页头与入口按钮的 `onclick` 也绑在外观层。切分线是「首屏可不可见 / 被首屏其它模块依赖」，别整块搬走首屏就要用的数据。
- [ ] 数字 / 字节 / 日期 / 百分比走 `I18N.num` / `bytes` / `date` / `percent`，不手拼单位。
- [ ] 为新增交互补自动化测试（`npm run test:unit` / `test:e2e`），并重跑 `npm run ui:inventory` 提交产物。
- [ ] 保持 CSP `script-src 'self'`：无内联脚本、无 `on*` 属性、无内联样式、无外部 CDN；模块 `import` 只用同源相对路径。
- [ ] 新颜色 / 阴影 / 时长走 CSS 变量与动效令牌，并确认 `prefers-reduced-motion` 下仍可用。
- [ ] 新业务逻辑并进职责最近的**已有**模块（没有打包器，模块数 = 首屏请求数；新模块要有实打实的分量）；
      跨文件用 `import` / `export`，不要新增隐式全局。新经典脚本用 IIFE 包裹防全局名冲突、
      位置在模块入口之前，需要 `$` / `showToast` 等先过 `legacy-globals.js`。
- [ ] 同步三处清单：`index.html` 的 `<script>` 与 `<link rel="modulepreload">`、`web/sw.js` 的
      `PRECACHE_URLS`、本文件的模块地图；`npm run perf:budget` 通过即证明前三者一致。
- [ ] 改动 Service Worker 时确认 `/api/*` 与 `/v1/*` 仍未被缓存。
- [ ] 运行 `npm run check` 与 `npm run test:unit`，`go vet ./...` / `go build ./...`，并手动过一遍受影响页面（含中英切换与深浅主题）。
