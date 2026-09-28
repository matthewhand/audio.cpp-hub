# 前端测试与质量工具

本目录的工具链**仅用于开发期**：发布产物仍是「Go 二进制 + `web/` 静态文件」，无构建步骤。

| 命令 | 作用 |
| --- | --- |
| `npm run test:unit` | `node:test` 单元测试（纯工具函数，无需浏览器） |
| `npm run test:e2e` | Playwright e2e（headless Chromium + mock 后端，无需 Go/GPU/模型） |
| `npm run ui:inventory` | 生成 `ui_inventory.json` 与 `docs/ui.md` |
| `npm run ui:inventory:check` | 校验两者与源码一致（CI 防漂移） |
| `npm run perf:budget` | 首屏 JS/CSS raw+gzip 体积与请求数预算检查，并校验「模块图 / modulepreload / SW 预缓存」三方一致 |
| `npm run check:i18n` | 中英词典键一一对应 + 占位符一致 + `index.html` 里 `data-i18n*` 引用键都存在 |
| `npm run check:sw` | `web/sw.js` 的 `PRECACHE_URLS` 覆盖 index.html 本地引用、模块图传递闭包与固定外壳 |

前置：Node ≥ 22（本仓库使用 v22）、`npm ci` 装 devDependencies（仅 `@playwright/test`）。首次跑 e2e 前如本机无浏览器：`npx playwright install chromium`。

---

## 单元测试（#72）

`node --test "test/unit/**/*.test.mjs"`。前端是 classic script（挂 `window.*`）且 `app.js` 与 DOM 强耦合，测试通过 `node:vm` 在隔离 realm 中加载脚本 / 抽取顶层函数，**不修改前端**：

- `test/unit/helpers/vm.mjs`：`runClassic`（加载 classic script）、`extractFunction`/`makeFunction`（对 `app.js` 等不可导入文件做源码级函数抽取并求值）、`makeBrowserSandbox`（localStorage / navigator / document stub）、`loadI18n`（按 `index.html` 顺序加载 `i18n.zh.js` → `i18n.en.js` → `i18n.js`）、`makeI18nStub`（只实现被测函数真正调用的成员并记录入参）。
- `wav.test.mjs`：`WavUtil.audioBufferToWav`（头字段、裁剪、双声道降混、幅度钳制、空区间）、`formatDuration`、`formatSize`、`warmAudioOutput` 容错。
- `i18n.test.mjs`：语言探测、`t()` 插值/数组值/缺失 key、`setLang` 持久化与 `onChange`、`applyI18n`、`errText`（后端 code/params → 文案）、`pick`、`bytes`（1024 进位与单位后缀）、**中英字典 key 完全对齐（parity）**。parity 直接比对 `window.I18N_ZH` / `window.I18N_EN` 两个真实对象，不再从源码刮 key。
- `app-utils.test.mjs`：`esc`、`safeHttpUrl`、`hfMirrorOf`、`fmtBytes`、`parseEnvText`、`parseSessionOptionsText`。
- `file-browser.test.mjs`：`formatSize`（委托 `I18N.bytes`；空值不打扰 I18N）。

> **数字/单位排版已收口到 `I18N.bytes`（Intl）**：`app.js` 的 `fmtBytes` 与 `file-browser.js` 的 `formatSize` 现在只做「非法值兜底 + 委托」。单测因此断言**契约与兜底**，不硬编码 ICU 版本的空格 / 千分位 / `kB` vs `KB` 差异。

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

`npm run ui:inventory` 解析 `web/index.html` 与 `web/*.js`，产出 **`ui_inventory.json`**（面板、控件 id/i18n/事件、`data-*` 钩子、快捷键、API 端点）与 **`docs/ui.md`**。分析范围从 `index.html` 的实际 `<script src>` 反推（不再维护手写文件名清单，否则 i18n 拆分新增的 `i18n.zh.js`/`i18n.en.js`、`api-client.js`、`motion.js`、`pwa.js` 会被静默漏掉）。输出确定性：数组排序、固定 key 顺序，并经 Prettier（同一份 `.prettierrc`）归一，使生成物本身就能通过 `npm run format:check`。`npm run ui:inventory:check` 会重新生成到临时文件并与已提交版本逐字节比对，漂移即退出 1（CI 执行）。改动 `web/` 后请重跑 `npm run ui:inventory` 并提交两个产物。

已知局限：经中间变量或字符串拼接的 `fetch` 方法/路径做启发式归一化（`{param}` 占位、三元分支配对），个别动态 URL（如 `downloadCert(url)` 的参数）不会出现在端点表——匿名/动态调用点是有意跳过的。

---

## 性能预算（#74）

`npm run perf:budget` 直接读 `web/` 文件与 `index.html` 引用，计算 raw+gzip 与初始子资源请求数。初载资源清单同样从 `index.html` 反推（手写清单会漏项并静默低估基线）：

| 指标 | 预算 | 当前实测 |
| --- | --- | --- |
| 初始 JS raw | 330 KiB | 323.4 KiB |
| 初始 JS gzip | 118 KiB | 113.4 KiB |
| 初始 CSS raw | 68 KiB | 65.0 KiB |
| 初始 CSS gzip | 18 KiB | 16.7 KiB |
| JS+CSS gzip 合计 | 135 KiB | 130.1 KiB |
| 初始子资源请求数 | 30 | 29 |
| TTI 目标 | ≤ 1500 ms（本地/局域网，中端笔电） | 由真实浏览器测量，不在本脚本校验 |

预算定义在 `scripts/perf-budget.mjs` 的 `BUDGETS`（单一来源）。超标退出 1。

### 首屏请求数：ES 模块化之后（2026-09，#100 拆分 → 本次修复）

`app.js` 拆成原生 ES 模块后，浏览器不再只取一个 `app.js`，而是顺着 import 图逐个取
`web/modules/*.js`——没有打包器就没有合并，首屏请求数因此暴涨。上表是**修复后**的数字，
下表是同口径的 before → after（`npm run perf:budget` 两次实测）：

| 指标 | 拆分后（before） | 修复后（after） | 变化 |
| --- | --- | --- | --- |
| 初始子资源请求数 | 35 | **29** | −6（−17%） |
| 初始 JS raw | 324.5 KiB | 323.4 KiB | −1.1 KiB |
| 初始 JS gzip | 115.4 KiB | 113.4 KiB | −2.0 KiB |
| 初始 CSS raw | 64.9 KiB | 65.0 KiB | +0.1 KiB（合并骨架屏时多两行注释） |
| 初始 CSS gzip | 16.6 KiB | 16.7 KiB | +0.1 KiB |
| JS+CSS gzip 合计 | 132.0 KiB | 130.1 KiB | −1.9 KiB |
| 模块文件数 | 20 | **14** | −6 |

两个动作，效果不同，必须分开说：

1. **`<link rel="modulepreload">`（`web/index.html:23`–`36`）——不减少请求数**，模块的字节
   还是要传。改的是**时序**：浏览器在解析 head 时就并行发起整张模块图并预解析，而不是等
   `app.js` 执行后再顺着 import 图走。本脚本按请求条数计量，因此看不到这一项的收益。
   Playwright 实测（本地静态服务器、无节流，各 3 次，取模块图首条请求的 `startTime` 与
   全部下载完的 `responseEnd`）：

   | | 模块图首个请求发起 | 模块图全部下载完 |
   | --- | --- | --- |
   | 有 `modulepreload` | 18–24 ms | 81–110 ms |
   | 无 `modulepreload` | 83–89 ms | 99–101 ms |

   即**提前约 65 ms 发起**，且 14 个模块各只请求一次（无重复回源）。
2. **合并过细的模块（20 → 14）——这才是 35 → 29 的来源**。`npm run perf:budget` 的请求数
   预算从 40 收到 30，**不是**继续沿用上一版为迁就 35 个请求而放宽的 40。

| 原模块 | 并入 | 为什么是一家人 |
| --- | --- | --- |
| `api.js`（8 行）+ `i18n-bridge.js`（7 行） | `dom.js` | 三段都是**纯 window 绑定的再导出**（`Api` / `t` / `$`+`el`）+ 转义出口，同属「基元层」；合并后 `dom.js` 零 import，成为依赖图里唯一的叶子 |
| `ui.js`（112 行，弹窗焦点栈）+ `events.js`（38 行，事件→toast） | `async-ui.js` | 事件流的**唯一产物就是 toast**，而焦点栈 / `dismissToast` 本来就被 toast 那边单向引用；两处合并正好把原来 `dom.js ⇄ async-ui.js` 的环也一起断掉 |
| `results.js`（151 行，结果落版） | `tasks.js` | 任务生命周期的终点就是「把结果画到面板上」，中间没有别的模块参与 |
| `pickers.js`（20 行，选择器实例） | `panels.js` | `VoiceSelect` / `AudioPicker` 就是面板表单的部件，且**只有 `panels.js` import 它** |

### 新增的漂移闸门

`npm run perf:budget` 现在还会校验三方一致（任一处漏项都退出 1）：

```
模块图（app.js 的 import 图，不含 app.js 自身）⊆ index.html 的 <link rel="modulepreload">
模块图 + app.js               ⊆ web/sw.js 的 PRECACHE_URLS
```

漏掉 `modulepreload` 不会让页面报错，只会让那个模块悄悄退回串行取；漏掉 SW 预缓存不会让
安装失败（`install` 用 `allSettled`），但离线冷启动会在该脚本处断掉。两者都必须靠检查挡住。

`perf:budget` 的三方一致只覆盖 **ES module 图**；`index.html` 里那些**经典脚本**
（`i18n.zh.js` / `i18n.en.js` / `api-client.js` / `file-browser.js` / `audio-picker.js` …）
漏出预缓存时它看不见，而这批脚本缺任意一个都会让离线首屏直接崩（`i18n.js` 读不到
`window.I18N_ZH`、模块图拿不到 `Api`）。`npm run check:sw` 补上这一段：静态遍历
`index.html` 的 `<script src>` / `<link rel=stylesheet>` 引用 + 从这些入口出发的 ES module
静态 `import` 传递闭包，核对 `web/sw.js` 的 `PRECACHE_URLS` 与固定外壳项。只读校验，绝不
改 `web/`；有缺失即退出 1（CI `web-toolchain` job 执行）。

### 历次重新标定说明

> **更早的两轮**（数字取自当时的树形，保留以便对照）：原预算（280/80/56/14 KiB、12 个请求）
> 是在更早的树形上按一份**手写 8 文件清单**测出来的，实际首载早已不止 8 个脚本。#87（设计令牌）、
> #88（异步态）、#89（i18n 拆成 `i18n.zh.js` + `i18n.en.js`，多 2 个请求）、#98（`api-client.js`）
> 合入后已越线；#90（PWA 的 `motion.js` + `pwa.js`）再叠加约 5.8 KiB raw / 2.9 KiB gzip / 2 个请求。
> 那次先把测量口径修正为「从 index.html 反推」（原脚本只测 8/13 个脚本，指标本身是失真的），
> 再按实测值 + 余量重新标定预算，并显式记录而非悄悄放宽。
>
> **#100 模块拆分那一轮**把预算按 35 个请求的现状标成了 40，属于**为迁就退化而放宽**。本次
> 修掉退化后，预算按修复后的实测值重新收紧（请求数 40 → 30），并在上文留下 before/after 全量对照。

### 懒加载评估

结论：**当前不实现，留有依据的推荐**。原因：

1. 业务逻辑已是 ES 模块，但 `app.js` 之外仍是 classic script + `window.*`（`web/i18n.zh.js` / `i18n.en.js` / `api-client.js` 等），且 `panels.js` 在模块求值时就 `new VoiceSelect(...)` / `new AudioPicker(...)`，因此 `audio-picker.js`、`voice-select.js` 属首屏必需，无法后置。
2. 动态 `import()` 只对 ES module 生效；要懒加载 `voices-panel.js` / `file-browser.js` 需先把它们改为 ESM 并调整 `window.*` 暴露方式、`CSP script-src 'self'` 下的模块加载，以及 `#voices-btn` 的绑定时机——这是一次结构性改造。
3. `motion.js` / `pwa.js` 都很小（2.3 / 3.5 KiB raw），且 `pwa.js` 需要在 `app.js` 之前注册 Service Worker 才能覆盖首屏资源，收益不足以换取顺序上的脆弱性。

推荐（待懒加载落地时）：把非关键面板 `voices-panel.js`、`file-browser.js`（以及仅动画需要的 `wav.js` 播放预热）改为 ESM，在首次打开对应面板时 `await import()`，`app.js` 绑定按钮时先尝试动态导入、失败回退同步加载；届时同步下调本预算的「初始 JS gzip」并把懒加载模块计入新的按需预算，同时**把动态 `import()` 的目标从 `modulepreload` 清单里移除**（否则预载会把懒加载的收益全部抵消）。

---

## CI

`.github/workflows/ci.yml` 中：

- **`web-toolchain` job**（开发期类型 / Lint / 格式硬闸门）：`npm ci` → `check:types`（tsc `--checkJs`，noEmit）→ `lint`（ESLint flat config）→ `format:check`（Prettier）→ `check:i18n`（中英键 + HTML 引用键）→ `check:sw`（SW 预缓存覆盖）。该 job 不需要浏览器，故 `npm ci` 带 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`（`@playwright/test` 同在 devDependencies 里，其 postinstall 会被跳过；浏览器由下面的 job 安装）。
- **`frontend` job**（本文件描述的测试链）：`npm ci` → `test:unit` → `ui:inventory:check` → `perf:budget` → `playwright install --with-deps chromium` → `test:e2e` → 上传 Playwright 报告（失败也上传）。

两个 job 与 Go 的 `quality` / `diagrams` job 并行、互不影响；所有 action 均按 commit SHA 固定。
