# web/ — 前端贡献指南

本目录是 audio.cpp-hub 的 Web UI：**纯原生 HTML / CSS / JS，无框架、无构建步骤，运行时不需要 Node.js**。
Go 服务把 `web/` 当普通静态目录直接从磁盘提供（见 `api.go:152` 的 `staticHandler`），
浏览器直接执行这里的源文件——没有打包、压缩或转译环节。发布包里就是这些源文件本身。

Node / npm 等工具链（若引入）**只用于开发与 CI**，不参与运行，也不需要随发行版分发。请勿在源码里依赖任何构建期产物。

## 1. 硬约束

- **无构建、无框架**：一个 `index.html`（456 行）+ 若干经典 `<script>`（非 ES module），共享全局作用域。
- **运行时零 Node**：改完 JS/CSS 刷新浏览器即可，不存在 watch/build 流程。
- **严格 CSP**：`default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'`（`web/index.html:7`）。
  因此：不允许内联脚本、内联事件属性（`onclick=`）、内联 `style` 属性或外部 CDN。主题 / 语言在页面绘制前由 `boot.js` 从 `localStorage` 恢复。
- **中英双语**：所有用户可见文案同时提供中文与英文，集中在 `i18n.js`，不得硬编码在业务脚本里。

## 2. 架构总览

- **服务侧**：`api.go:152` 的 `staticHandler` 用 `http.Dir("web")` 提供服务，目录请求只回 `index.html`（禁用目录列表），`index.html` 不缓存、其余资源缓存 1 小时（`api.go:150`–`api.go:194`）。
  工作目录由 `main.go:66` 的 `ensureWorkDir` 自动定位（当前目录没有 `web/` 时尝试上级与 exe 目录）。
- **前端侧**：没有路由库、没有状态管理库。`app.js` 持有全部可变状态与渲染逻辑；其余文件是自包含组件（IIFE 或挂到 `window` 的 class），只暴露构造器 / 方法。
- **数据流是手写的单向流**：DOM 事件 → `fetch("/api/*")` → 更新模块级 `let` 状态 → 重新渲染相关 DOM。没有响应式绑定，改了 state 必须手动调用对应 render 函数。

## 3. 模块地图

| 文件（行数） | 职责 | 入口 / 主要 API | 关键位置 |
| --- | --- | --- | --- |
| `index.html`（456） | 全部静态 DOM（面板、弹窗、表单）、CSP、脚本加载顺序 | 页面骨架 | 脚本标签 `web/index.html:448`–`454` |
| `boot.js`（6） | 绘制前恢复主题与语言，避免首屏闪烁（CSP 要求独立文件） | 顶层立即执行 | `web/boot.js:3` |
| `i18n.js`（1203） | 中英双语字典 + 运行时 `I18N` API | `I18N.t` / `applyI18n` / `setLang` / `onChange` / `errText` / `pick` | `t` `web/i18n.js:1144`，字典 zh `web/i18n.js:9`、en `web/i18n.js:568` |
| `app.js`（3359） | 应用主逻辑：状态、渲染、事件接线、轮询、任务队列 | 见下方「app.js 内部分区」 | `web/app.js:1` |
| `wav.js`（95） | 音频工具：解码、PCM16 单声道 WAV 编码、时长/体积格式化、输出设备预热 | `window.WavUtil` | `web/wav.js:2` |
| `audio-picker.js`（620） | 音频选择组件：上传 / 录制 / 音色库 / 本地路径，含波形、播放、裁剪 | `window.AudioPicker` | class `web/audio-picker.js:9`，`getValue` `web/audio-picker.js:595` |
| `voice-select.js`（179） | 音色下拉：从音色库直选，选中即生效，返回服务器路径 | `window.VoiceSelect` | class `web/voice-select.js:10`，`refreshVoiceSelects` `web/voice-select.js:176` |
| `voices-panel.js`（211） | 音色库管理面板（页头 🎙）：列表 / 试听 / 行内编辑 / 删除 / 添加 | `window.openVoicesPanel` | `web/voices-panel.js:9` |
| `file-browser.js`（422） | 服务器端文件 / 目录选择弹窗（选权重路径等），动态创建 overlay | `window.FileBrowser.open` | `web/file-browser.js:84` |
| `style.css`（1569） | 设计系统：主题变量、组件样式、动效令牌 | — | 动效令牌 `web/style.css:6` |

### app.js 内部分区

| 区域 | 说明 | 关键位置 |
| --- | --- | --- |
| 常量与工具 | `t()` 快捷取词、状态/分类文案、保留参数键 | `web/app.js:3`–`23` |
| 模块级状态 | 选中模型 / 实例、列表缓存、情绪向量等 | `web/app.js:25`–`40` |
| DOM 辅助 | `$()` / `el()` / `esc()` / `safeHttpUrl()` | `web/app.js:42`–`58` |
| 主题 / 语言 / 全局重渲染 | 切换按钮、`rerenderAll` 统一重渲染 | `web/app.js:82`–`118` |
| 模型列表 | 拉取 `/api/models`、分组卡片、HF 菜单 | `loadModels` `web/app.js:173`，`renderModelList` `web/app.js:256` |
| 设置弹窗 | 通用 / 可执行文件 / HTTPS 三个分栏 | `web/app.js:298`–`456` |
| 启动弹窗 + Profile | 权重 / 设备 / 高级参数、启动配置存取 | `web/app.js:457`–`1117` |
| 实例 | 列表刷新、状态条、详情弹窗 | `refreshInstances` `web/app.js:1118`，`renderInstanceList` `web/app.js:1135` |
| 下载 | 下载管理面板、模型下载弹窗 | `refreshDownloads` `web/app.js:1318`，`renderDownloadList` `web/app.js:1354` |
| 事件 / toast | 后端事件轮询与轻提示 | `refreshEvents` `web/app.js:1521`，`showToast` `web/app.js:1549` |
| 任务队列前端 | 提交、轮询、终态收尾、结果渲染 | `submitTask` `web/app.js:1575`，`trackTask` `web/app.js:1616` |
| 工作区分发 | 按模型类别显示对应面板 | `renderWorkspace` `web/app.js:1757` |
| 五类任务面板 | TTS / ASR / SEP / Music / Other 各自的表单与结果渲染 | `renderTtsPanel` `web/app.js:2003`、`renderAsrPanel` `web/app.js:3009`、`renderSepPanel` `web/app.js:3073`、`renderMusicPanel` `web/app.js:3119`、`renderOtherPanel` `web/app.js:3201` |
| 历史侧栏 | 任务 + 历史合并渲染、分组、行内详情 | `loadHistory` `web/app.js:2269`，`renderSidebarList` `web/app.js:2324` |
| 初始化 + 轮询 | 组件实例化、首屏加载、全局 2s 轮询 | `web/app.js:3318`–`3359` |

## 4. 脚本加载顺序与初始化

`index.html` 里的加载顺序（经典脚本，非 module，**顺序有语义**）：

1. `<head>` 中先加载 `boot.js`（`web/index.html:10`），再挂 `style.css`——主题 / 语言要在首次绘制前生效。
2. `</body>` 前依次加载（`web/index.html:448`–`454`）：
   `i18n.js` → `wav.js` → `file-browser.js` → `audio-picker.js` → `voice-select.js` → `app.js` → `voices-panel.js`。

为什么是这个顺序：

- `app.js` 末尾会直接 `new VoiceSelect(...)` / `new AudioPicker(...)`（`web/app.js:3321`–`3328`），所以这两个组件脚本必须先于 `app.js` 加载。
- 所有脚本都是经典脚本、共享全局作用域，因此**新脚本要用 IIFE 包裹**，避免顶层 `const` 重名冲突（参考 `web/audio-picker.js:5`、`web/voice-select.js:6`）。
- 脚本位于 `<body>` 末尾，DOM 已解析完毕，`app.js` 顶层可直接 `document.getElementById`。
- 初始化序列在 `web/app.js:3330`–`3339`：注册 `I18N.onChange(rerenderAll)`、应用一次 i18n、构建情绪滑块，然后并行拉取模型 / 可执行文件 / Profile / 实例 / 事件 / 下载。

`rerenderAll`（`web/app.js:102`）是语言切换后的统一重渲染入口：它会重渲模型列表、实例、设置面板，并刷新所有已注册的 `AudioPicker` / `VoiceSelect` 文案（`web/app.js:115`–`116`）。

## 5. 状态与事件流

- **可变状态**集中为 `app.js` 顶部的模块级 `let`（`web/app.js:25`–`40`），任务相关另有三张 Map：`activePolls` / `taskViews` / `taskDetails`（`web/app.js:1570`–`1572`）。
- **localStorage 键**：`hub-theme`、`hub-lang`（`web/boot.js:3`、`web/boot.js:5`）、`hub-model`（`web/app.js:186`）、`hub-privacy`、`hub-threads`，以及按模型持久化的权重路径 / 启动配置键。语言初值优先级见 `web/i18n.js:1129`。
- **轮询模型**（标签页隐藏时全部暂停，见 `web/app.js:3355`）：
  - 全局 2s 轮询：实例 + 事件 + 下载，`runPoll` / `startPolling`（`web/app.js:3343`、`web/app.js:3348`）。
  - 任务单独 2s 轮询：每个进行中的任务一个 `setInterval`（`web/app.js:1621`），到终态即清除。
- **任务生命周期**：`submitTask`（`web/app.js:1575`）→ `trackTask`（`web/app.js:1616`，入侧栏并轮询）→ `finishTask`（`web/app.js:1649`）→ `renderTaskResult`（`web/app.js:1669`）。
  TTS 结果直接用历史 wav URL（不处理 base64），其余类别再取 `/result` JSON。页面加载 / 切换模型时 `reattachTasks`（`web/app.js:1695`）经 `GET /api/tasks?modelId=` 重挂。
- **跨组件事件**：主题切换广播 `themechange`（`web/app.js:92`），音频组件监听后重绘波形（`web/audio-picker.js:105`）。
- **关键 DOM 锚点**（`index.html`）：页头按钮 `#voices-btn` / `#history-btn` / `#downloads-btn` / `#lang-toggle` / `#settings-btn` / `#theme-toggle`；左栏 `#left` 内 `#instance-list`、`#model-list`；右栏 `#right > #workspace`；五类面板 `#panel-tts`、`#panel-asr`、`#panel-sep`、`#panel-music`、`#panel-other`；历史 `#history-panel > #history-list`；音色库 `#voices-panel > #voices-list`；若干弹窗 `#launch-modal`、`#settings-modal`、`#model-dl-modal`、`#downloads-modal`、`#instance-detail-modal`、`#busy-overlay`；以及 `#toast-root`、`#drawer-overlay`。

## 6. 编码约定

- **无框架、无构建**。新增交互优先复用现有模式（DOM 辅助 + 手写渲染），不要引入打包器或框架。
- **安全渲染**（防存储型 XSS）：任何服务端 / 用户可控字符串插入 HTML 前必须 `esc()`（`web/app.js:49`）；能 `textContent` 就别 `innerHTML`；拼 HTML 用 `el()`（`web/app.js:43`）；URL 属性用 `safeHttpUrl()`（`web/app.js:55`）或 `esc()`。**绝不把未转义数据塞进 `innerHTML`。**
- **i18n**：
  - 动态文案用 `t()`（`web/app.js:3` 的 `I18N.t` 快捷方式）；字典键必须**同时**写入 `zh`（`web/i18n.js:9`）与 `en`（`web/i18n.js:568`）两套，约 530 条、保持对等。
  - 静态 DOM 用 `data-i18n` / `data-i18n-placeholder` / `data-i18n-title` / `data-i18n-aria-label` 标注，由 `applyI18n()`（`web/i18n.js:1154`）批量替换。
  - 自定义组件实现 `refreshLabels()` 并注册到 `window.__audioPickers` / `window.__voiceSelects`（`web/audio-picker.js:102`、`web/voice-select.js:47`），这样 `rerenderAll` 能统一刷新。
  - 多语言字段用 `I18N.pick`（`web/i18n.js:1194`）；后端错误用 `I18N.errText`（`web/i18n.js:1179`）解析 `{"code","params"}`。
- **CSS**：设计系统从 `web/style.css:6` 起。主题变量 `--bg` / `--text` / `--accent` / `--card` 等分浅色 `:root[data-theme="light"]`（`web/style.css:39`）与深色 `:root[data-theme="dark"]`（`web/style.css:15`）。新颜色 / 阴影一律加变量，不硬编码。
- **动效令牌**：时长 `--dur-1/2/3` + 缓动 `--ease-out` / `--ease-in-out`（`web/style.css:6`–`12`）；必须尊重 `prefers-reduced-motion`（`web/style.css:1549`）：装饰动画可停，加载/工作中等必要反馈保留。
- **中文注释**：代码注释用中文（与 Go 侧一致），标识符、API 字段、CSS 变量用英文。
- **CSP**：不写内联脚本、`on*` 事件属性、内联 `style` 属性，不引外部源；`index.html:7` 的 CSP 必须保持 `script-src 'self'`。

## 7. 无构建地运行与调试

完整功能（推荐）：

```bash
# 仓库根目录
go run .            # 默认 http://127.0.0.1:8080（见 hub.config.example.json）
# 或
go build -o audio.cpp-hub . && ./audio.cpp-hub
```

`ensureWorkDir`（`main.go:66`）会自动定位含 `web/` 的工作目录，因此从子目录启动一般也能找到前端。改完 `web/` 下的 JS/CSS 直接刷新浏览器即可：`index.html` 不缓存，其余资源 1 小时缓存（必要时硬刷新）。

只调 UI（不启后端，适合调样式 / 布局）：在 `web/` 目录起任意静态服务器，例如 `python3 -m http.server 8000`。此时 `/api/*` 全部 404，列表与任务为空字段，仅用于查看静态外观。

服务端如何提供文件：`api.go:152` 的 `staticHandler`——目录请求只回 `index.html`、禁用目录列表，`index.html` 设 `Cache-Control: no-cache`，其余 `max-age=3600`。

## 8. 开发工具链（仅供开发 / CI，运行时不需要）

根目录的 `package.json`、`eslint.config.js`、`tsconfig.json`、Prettier 配置及
`scripts/web-quality/` **仅供开发与 CI** 使用（lint / 格式化 / 类型检查），
不参与运行，也不需要随发行版分发。CI 见 `.github/workflows/ci.yml` 的
`frontend` 任务；Go 的 `quality` 任务与前端工具链互不影响。

```bash
npm install          # 仅安装 devDependencies（typescript / eslint / prettier）
npm run lint         # eslint（当前基线 0 error / 若干 warn）
npm run lint:fix
npm run format       # prettier --write
npm run format:check
npm run typecheck    # tsc 棘轮：不得超过 tsc-ratchet-baseline.txt 的错误数
```

`typecheck` 是**棘轮（ratchet）**而非全绿：`web/` 是允许 `checkJs` 的
JavaScript，当前仍有一批历史类型错误，其数量封顶在 `tsc-ratchet-baseline.txt`。
只允许错误数下降，不允许上升。修正一批错误后可跑
`node scripts/web-quality/tsc-ratchet.mjs --update` 收紧基线。

Prettier 通过根目录 `.prettierignore` 排除既有 `web/` 前端文件，仅检查工具链
新增的文件，以保持 diff 可审阅。

测试与 UI 清单见 [`../TESTING.md`](../TESTING.md)（e2e / 单元测试），
`npm run ui:inventory:check` 会校验 `ui_inventory.json` 与 `docs/ui.md` 是否漂移。

## 9. 相关文档与设计资产

| 文档 | 内容 |
| --- | --- |
| [`../TESTING.md`](../TESTING.md) | 前端 e2e / 单元测试与本地运行方式 |
| [`styleguide.html`](styleguide.html) | 组件样式指南页（在浏览器中打开） |
| [`../docs/ui.md`](../docs/ui.md) | UI 清单：界面 / 控件逐项登记 |
| [`../docs/diagrams/`](../docs/diagrams/) | 视觉文档：14 张架构 / 时序 / 状态图 + `previews/`，入口见 `README.md`、`INVENTORY.md` |
| [`../docs/API.md`](../docs/API.md) | 前端调用的 `/api/*` 接口契约 |
| [`../docs/assets/`](../docs/assets/) | README 演示 GIF（Playwright 实拍） |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | 通用贡献流程与代码约定 |
| [`../SECURITY.md`](../SECURITY.md) | 威胁模型与漏洞上报渠道 |

## 10. 贡献检查清单

- [ ] 新文案同时加入 `zh`（`web/i18n.js:9`）与 `en`（`web/i18n.js:568`）两套字典；动态用 `t()`，静态用 `data-i18n*`。
- [ ] 所有服务端 / 用户数据进 HTML 前 `esc()`；URL 用 `safeHttpUrl()`；能用 `textContent` 就不拼 `innerHTML`。
- [ ] 为新增交互补自动化测试，并在 UI 清单（`docs/ui.md`）与相关图表 / `docs/diagrams/INVENTORY.md` 中登记。
- [ ] 保持 CSP `script-src 'self'`：无内联脚本、无 `on*` 属性、无内联样式、无外部 CDN。
- [ ] 新颜色 / 阴影 / 时长走 CSS 变量与动效令牌，并确认 `prefers-reduced-motion` 下仍可用。
- [ ] 新脚本用 IIFE 包裹防全局名冲突；新组件实现 `refreshLabels()` 并注册登记表。
- [ ] 运行 `go vet ./...` 与 `go build ./...`，并手动过一遍受影响页面（含中英切换与深浅主题）。
