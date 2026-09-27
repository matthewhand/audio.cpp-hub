# 前端测试与质量工具

本目录的工具链**仅用于开发期**：发布产物仍是「Go 二进制 + `web/` 静态文件」，无构建步骤。

| 命令 | 作用 |
| --- | --- |
| `npm run test:unit` | `node:test` 单元测试（纯工具函数，无需浏览器） |
| `npm run test:e2e` | Playwright e2e（headless Chromium + mock 后端，无需 Go/GPU/模型） |
| `npm run ui:inventory` | 生成 `ui_inventory.json` 与 `docs/ui.md` |
| `npm run ui:inventory:check` | 校验两者与源码一致（CI 防漂移） |
| `npm run perf:budget` | 首屏 JS/CSS raw+gzip 体积与请求数预算检查 |

前置：Node ≥ 22（本仓库使用 v22）、`npm ci` 装 devDependencies（仅 `@playwright/test`）。首次跑 e2e 前如本机无浏览器：`npx playwright install chromium`。

---

## 单元测试（#72）

`node --test "test/unit/**/*.test.mjs"`。前端是 classic script（挂 `window.*`）且 `app.js` 与 DOM 强耦合，测试通过 `node:vm` 在隔离 realm 中加载脚本 / 抽取顶层函数，**不修改前端**：

- `test/unit/helpers/vm.mjs`：`runClassic`（加载 classic script）、`extractFunction`/`makeFunction`（对 `app.js` 等不可导入文件做源码级函数抽取并求值）、`makeBrowserSandbox`（localStorage / navigator / document stub）。
- `wav.test.mjs`：`WavUtil.audioBufferToWav`（头字段、裁剪、双声道降混、幅度钳制、空区间）、`formatDuration`、`formatSize`、`warmAudioOutput` 容错。
- `i18n.test.mjs`：语言探测、`t()` 插值/数组值/缺失 key、`setLang` 持久化与 `onChange`、`applyI18n`、`errText`（后端 code/params → 文案）、`pick`、**中英字典 key 完全对齐（parity）**。
- `app-utils.test.mjs`：`esc`、`safeHttpUrl`、`hfMirrorOf`、`fmtBytes`、`parseEnvText`、`parseSessionOptionsText`。
- `file-browser.test.mjs`：`formatSize`（WavUtil 委托与本地回退）。

### 有意不做的单元测试（DOM 重）

以下属于 DOM/浏览器重逻辑，改由 e2e 覆盖，不做单元测试：面板渲染（`renderWorkspace`/`renderTtsPanel`/…）、任务轮询与结果渲染、历史/分组/侧栏 DOM 复用、AudioPicker 波形绘制与录音、FileBrowser 弹窗、下载行渲染、`I18N.applyI18n` 之外的交互。`app.js` 里内联在渲染函数中的**速度格式化**（`fmtBytes(d.speedBps) + "/s"`）也属此类，未单测。

---

## Playwright e2e（#71）

配置 `e2e/playwright.config.mjs`：headless Chromium，`workers: 1`，失败保留 trace + 截图（`test-results/`）。启动时由 `e2e/static-server.mjs` 把 `web/` 作为静态站点提供（等价 Go `http.FileServer`），浏览器侧用 `page.route` 拦截 `/api/*`、`/v1/*`。

### Mock 契约

`e2e/mock-backend.mjs` 的 `MockBackend` 持有确定性内存状态，每个测试一份。所有响应 `Content-Type: application/json`（音频为 `audio/wav`），错误体为 `{ok:false, code, error}`。已实现端点：

- 模型：`GET /api/models`（直接读真实 `models.json`）、`GET /api/models/:id/packages`（`{packages:[]}`）。
- 可执行文件：`GET/POST /api/executables`、`PUT/DELETE /api/executables/:id`、`GET /api/executables/:id/devices`。
- 启动配置：`GET/POST /api/profiles`、`PUT/DELETE /api/profiles/:id`。
- 实例：`GET/POST /api/instances`、`DELETE /api/instances/:id`；POST 直接返回 `READY`。
- 下载：`GET/POST /api/downloads`、`POST /api/downloads/:id/pause|resume`、`DELETE /api/downloads/:id`。
- 任务：`POST /api/tasks` 返回 `RUNNING` 任务；**首次 `GET /api/tasks/:id` 即翻为 `DONE`**（确定性收尾，前端 2s 轮询最多一次）；`GET /api/tasks/:id/result` 返回按 category 的固定结果（asr → `{text:"mock transcript: ..."}`）；`DELETE` 置 `CANCELLED`。
- 历史：`GET/DELETE /api/history/:modelId`、`GET/DELETE /api/history/:modelId/:taskId`、`GET/DELETE/PUT .../groups`、`PUT .../:taskId/group`、`GET .../audio[/:name]`（返回最小合法 WAV）。
- 音色：`GET/POST /api/voices`、`PUT/DELETE /api/voices/:vid`、`GET /api/voices/:vid/audio`；重名返回 `VOICE_NAME_EXISTS`。
- 音频：`POST /api/audio/info`、`POST /api/audio/upload`。
- 其它：`GET /api/events`（`[]`）、`GET /api/cert/status`、`GET/POST /api/https/config`、`GET /api/fs/roots|list`、`/v1/*` 占位。

`e2e/helpers.mjs`：`openApp`（注入 `localStorage` 偏好如 `hub-model`/`hub-lang`/`hub-theme` 后打开首页并等待模型列表）、`pickAudioByPath`（在 AudioPicker 走「本地路径」页签并探测，避免真实上传）。

### 覆盖范围

| 流程 | spec |
| --- | --- |
| 登记可执行文件 | `executable.spec.mjs` |
| 启动 / 停止实例 | `instance.spec.mjs` |
| 提交 TTS 任务并看到结果音频 | `tts.spec.mjs` |
| 提交 ASR 任务并看到识别文本 | `asr.spec.mjs` |
| 历史加载 / 删除 / 分组 | `history.spec.mjs` |
| 音色库添加 | `voices.spec.mjs` |
| 下载暂停 / 续传 | `downloads.spec.mjs` |
| 模型切换 / 主题 / 语言 | `ui-switch.spec.mjs` |

### 延迟/未覆盖（诚实说明）

- 真实音频上传/录音/裁剪需要麦克风或文件解码，e2e 改走「本地路径」探测分支；上传接口本身有 mock 但未做端到端断言。
- SEP / 音乐生成 / Other 面板未单独写 spec（其提交链路与 ASR 同为 `POST /api/tasks` + `/result`，由 TTS/ASR 覆盖该异步链路；渲染分支不同）。
- `POST /api/tasks` 的**排队中**（`QUEUED`、`position`）与取消 `CANCELLED` 状态未做 e2e（mock 为简化状态机）；轮询/渲染共用同一代码路径。
- OpenAI `/v1/*` 代理仅 mock 占位，未做 e2e（前端不主动调用）。

### Flake 策略

- 单 worker、无共享状态；每个测试独立 `MockBackend`。
- 只用 Playwright 自动等待与 `expect(...).toBeVisible/toHaveText/...`，不写 `waitForTimeout`。
- 任务收尾由 mock 的「首次查询即 DONE」保证，不依赖真实耗时；实例/下载的轮询用 10s 上限的 `expect` 等待。
- CI 上 `retries: 1`、失败保留 trace/截图；本地不重试。若某流程无法在 mock 下确定性复现，则缩小到确定性子集并在上表记录，而非放宽为任意等待。

---

## UI 清单（#73）

`npm run ui:inventory` 解析 `web/index.html` 与 `web/*.js`，产出 **`ui_inventory.json`**（面板、控件 id/i18n/事件、`data-*` 钩子、快捷键、API 端点）与 **`docs/ui.md`**。输出确定性：数组排序、固定缩进。`npm run ui:inventory:check` 会重新生成到临时文件并与已提交版本逐字节比对，漂移即退出 1（CI 执行）。改动 `web/` 后请重跑 `npm run ui:inventory` 并提交两个产物。

已知局限：经中间变量或字符串拼接的 `fetch` 方法/路径做启发式归一化（`{param}` 占位、三元分支配对），个别动态 URL（如 `downloadCert(url)` 的参数）不会出现在端点表——匿名/动态调用点是有意跳过的。

---

## 性能预算（#74）

`npm run perf:budget` 直接读 `web/` 文件与 `index.html` 引用，计算 raw+gzip 与初始子资源请求数：

| 指标 | 预算 | 当前 |
| --- | --- | --- |
| 初始 JS raw | 280 KiB | 251.1 KiB |
| 初始 JS gzip | 80 KiB | 73.7 KiB |
| 初始 CSS raw | 56 KiB | 46.7 KiB |
| 初始 CSS gzip | 14 KiB | 11.4 KiB |
| JS+CSS gzip 合计 | 96 KiB | 85.2 KiB |
| 初始子资源请求数 | 12 | 9 |
| TTI 目标 | ≤ 1500 ms（本地/局域网，中端笔电） | 由真实浏览器测量，不在本脚本校验 |

预算定义在 `scripts/perf-budget.mjs` 的 `BUDGETS`（单一来源）。超标退出 1。

### 懒加载评估

结论：**当前不实现，留有依据的推荐**。原因：

1. 前端全部是 `<script src>` classic script，无构建步骤；`app.js` 在初始化时就 `new AudioPicker(...)` / `new VoiceSelect(...)`，因此 `audio-picker.js`、`voice-select.js` 属首屏必需，无法后置。
2. 动态 `import()` 只对 **ES module** 生效；要懒加载 `voices-panel.js` / `file-browser.js` 需先把它们改为 ESM 并调整 `window.*` 暴露方式、`CSP script-src 'self'` 下的模块加载，以及 `#voices-btn` 的绑定时机——这是一次结构性改造。
3. 另一个并行 workstream 正在把 `app.js` 拆分为 ES module；现在做动态导入会与其大面积冲突，且无法在此环境安全验证运行时行为。

推荐（待模块拆分落地后）：把非关键面板 `voices-panel.js`、`file-browser.js`（以及仅动画需要的 `wav.js` 播放预热）改为 ESM，在首次打开对应面板时 `await import()`，app.js 绑定按钮时先尝试动态导入、失败回退同步加载；届时同步下调本预算的「初始 JS gzip」并把懒加载模块计入新的按需预算。

---

## CI

`.github/workflows/ci.yml` 新增 `frontend` job（与既有 Go `quality` job 并行、互不影响）：`npm ci` → `test:unit` → `ui:inventory:check` → `perf:budget` → `playwright install --with-deps chromium` → `test:e2e`。
