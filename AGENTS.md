# audio.cpp-hub

## 项目概述

audio.cpp-hub 是 [audio.cpp](https://github.com/0xShug0/audio.cpp) 的 Web 管理面板：一个用 Go 写的轻量 HTTP 服务（原生单二进制，无需任何运行环境），负责拉起 / 停止 / 监控多个 `audiocpp_server` 模型实例子进程，并提供中文为主的 Web UI 进行 TTS / ASR / 音乐分离等音频任务。仓库地址：https://github.com/matthewhand/audio.cpp-hub

- 入口：仓库根目录 `main.go`（`func main`），Go module 为 `github.com/matthewhand/audio.cpp-hub`
- hub 本身默认监听 `httpPort`（`hub.config.json`，本仓库开发副本为 18080，代码内默认 8080）；各模型实例从 `instancePortBase`（本副本 18090）起自动分配端口，绑定 127.0.0.1
- 模型实例不在 hub 进程内运行：hub 为每个实例写 `run/<id>/server.json`，再用 `os/exec` 拉起外部 `audiocpp_server --config server.json`，stdout/stderr 重定向到 `run/<id>/server.log`，并后台轮询实例的 `/health`（最多 120s，见 `instance.go`）
- 推理任务走**异步队列**（前端主链路）：`POST /api/tasks`（body `{"instanceId","request":{...}}`）创建任务立即返回，`TaskManager`（`task.go`）为每个实例起一个单线程 executor **同实例串行排队执行**（与引擎 busy 锁语义一致），**无执行时长上限**；`GET /api/tasks[?active=1&modelId=]`（列表，活跃在前）、`GET /api/tasks/<id>`（详情含队列位置 position）、`GET /api/tasks/<id>/result`（非 TTS 结果 `data/tasks/<id>.result.json` 流式回写）、`DELETE /api/tasks/<id>`（QUEUED 直接取消 / RUNNING 中断 hub 侧等待——引擎会跑完，属已知限制 / 已结束则删除记录）。任务状态落盘 `data/tasks/<id>.task.json`（每次状态变迁原子写），hub 重启回放重建（上次中断时进行中的任务标记为 CANCELLED），已完成任务内存保留最近 100 条。TTS 任务复用历史链路：taskId 即历史记录 id，响应落盘后 `history.go` 中的音频提取器流式扫描提取 `"audio"` 写成 `data/history/<modelId>/<taskId>.wav`，前端结果音频直接用 `/api/history/.../audio` URL（不碰 base64）；非 TTS 结果统一 `forwardToFile` 落盘。前端 2s 轮询，**任务并入右侧操作历史侧栏**（任务创建即一条记录：进行中的在前，已结束的其次；TTS 终态与历史按 taskId 去重由历史行代表，非 TTS 完成任务行带「载入」可重新渲染结果、「详情」行内展开完整文本结果；进行中行内可取消，侧栏对所有类别开放），允许连续提交排队；页面加载与模型切换时经 `?modelId=` 重挂全部任务（进行中的恢复轮询），**刷新页面不再丢任务**。旧 `POST /api/run/<instanceId>` 同步接口保留兼容，TTS 流式链路：api.go → 实例 `http://127.0.0.1:<port>/v1/tasks/run`，TTS 响应落盘 → 提取进历史 → 临时文件分块回写
- 操作历史（TTS，`history.go`）：按 modelId 隔离到 `data/history/<modelId>/`（`index.jsonl` 一行一条记录只追加 + `<taskId>.wav` 结果音频 + `<taskId>.ref|emo|spkN.wav` 参考音频快照——记录时把请求里的 voice_ref/audio/voice_samples 源文件复制进历史目录，历史自包含，快照随记录一并删除），内存索引启动时回放重建。**无数量/容量淘汰**：历史是用户资产，只由用户手动删除（原 Java 版有 50 条/500MB 上限，Go 版按用户要求移除）。记录含 `refs`（快照名→原始文件名）、`refBytes`、`groupId` 等可选字段，旧记录向后兼容。API：`GET /api/history/<modelId>`（简要列表，新→旧，text 截断 100 字并带 `textTruncated` 标记）、`GET /api/history/<modelId>/<taskId>`（完整记录）、`GET /api/history/<modelId>/<taskId>/audio`（流式回 wav）、`GET /api/history/<modelId>/<taskId>/audio/<name>`（参考音频快照，name 为 ref|emo|spkN）、`DELETE /api/history/<modelId>[/<taskId>]`（清空 / 单删）。手动分组存 `groups.json`：`GET|POST /api/history/<modelId>/groups`、`PUT|DELETE .../groups/<gid>`、`PUT .../<taskId>/group`（移入/移出组；删组记录回未分组，清空历史保留分组）。前端为页头 🕘 按钮弹出的全屏面板（替换原右侧边栏），音频懒加载（点击播放才拉取 wav），历史行「详情」行内展开四要素（参考音频/参考文本/音色提示词/生成内容）、「移动」弹菜单换组，分组可折叠；界面记住上次选中的模型（localStorage `hub-model`），刷新后历史视图不丢
- 用量与性能统计（`stats.go`）：`GET /api/stats` 返回按模型聚合的派生统计，**不新增采集点、不改任务/历史结构**。用量口径（`total`/`ok`/`successRate`/`audioSeconds`/`outputBytes`/`lastAt`）取自历史索引（无淘汰，长期口径）；性能口径（排队等待 P50、执行耗时 P50/P95、实时率 RTF P50）取自内存任务的时间戳与 `result.durationSec`（内存只留最近 100 条已完成，故为**近期窗口**）。`rtfP50` = 执行秒 ÷ 音频秒，越小越快。**已知口径限制：仅 TTS 写历史，因此 ASR/分离/音乐不计入用量统计**。前端：页头 📊 按钮打开全屏看板（`web/modules/stats.js`，路由 `#/stats`），总量卡片 + 每模型卡片（任务数/成功率/音频时长/输出体积/排队与执行 P50-P95/RTF），`samplesForPerf` 为 0 时不展示性能行
- 参考音频（音色库，`voices.go`）：全局资源，存 `data/voices/`（`<vid>.wav` + `index.json`），条目 = vid + 名称（全局唯一，重名拒绝 `VOICE_NAME_EXISTS`）+ 音频文本内容 `text`（部分模型要求参考音频配套文本）+ 音频文件。API：`GET /api/voices`（列表含 text）、`POST /api/voices`（`{name, text?, uploadId?|path?}`，上传件或服务器路径二选一）、`PUT /api/voices/<vid>`（改名称/文本，排除自身重名）、`GET /api/voices/<vid>/audio`（流式回 wav）、`DELETE /api/voices/<vid>`。前端：页头 🎙 按钮弹出全屏管理面板（voices-panel.js：列表/试听/行内编辑/删除/添加——添加走完整 AudioPicker 上传/录制/裁剪）；TTS 表单里所有参考音频入口（主 voice_ref、VibeVoice 多说话人、其它模型 voice_ref、index_tts2 情感参考）统一用 `VoiceSelect` 下拉组件（voice-select.js），选中即生效并把音色路径填入请求的 voice_ref，自动回填参考文本；ASR/分离等仍用 `AudioPicker`（已移除其「保存到音色库」入口，库管理只在大面板）
- OpenAI 兼容代理（`proxy.go`）：`GET /v1/models` 聚合全部 READY 实例的服务名；`POST|PUT /v1/*`（如 `/v1/audio/speech`）——请求体流式落盘到 `run/proxy-cache/`（上限 `hub.config.json` 的 `proxyMaxBodyBytes`，默认 1GB），逐字节扫描提取顶层 `"model"`（大 base64 字段不落内存）后按服务名路由（READY 才转发，启动中 409，不存在 404），落盘文件作为 body 转发到实例同名接口，响应状态码/Content-Type 透传、逐块 Flush（SSE 兼容）；上游无整体超时，客户端断开即取消。错误体为 OpenAI 风格 `{"error":{"message","type"}}`。已知限制：multipart/form-data 无法提取 model（extractor 只认 JSON），会 400
- 实例服务名（instanceName）：启动时可显式指定（默认 modelId），是 `/v1/*` 的路由键，也写进实例 server.json 的 model id（实例自校验一致）；全局唯一，重名拒绝启动
- 设备探测：`GET /api/executables/<id>/devices` 用该可执行文件运行 `--list-devices`（注入条目 env，60s 超时），解析输出为 `{devices:[{backend,index,name,type}],raw}`；前端启动弹窗打开/切换程序时自动探测，「设备」为下拉选单（选项显示设备名称，选中即联动后端，提交设备号）
- 高级参数（sessionOptions）：启动模型弹窗底部「高级参数」区按每行 key=value 填写，API 为启动/配置 body 的 `sessionOptions` 对象（值统一转字符串），经 `optStringMap` 校验后写入 server.json 模型条目的 `session_options`；随启动配置（Profile）持久化
- 模型权重下载（`download.go` + `packages.go`）：`POST /api/downloads` 创建任务（创建即开始），两种 body：按模型 `{"modelId","packageId"?,"token"?,"overwrite"?,"endpoint"?,"source"?}`（`packageId` 缺省取清单 default 包，URL 默认按 `hfEndpoint` 配置拼接，`endpoint` 可逐次覆盖下载源）或显式 `{"targetDir","files":[{url,path}],...}`。多线程 Range 分段下载到 `models/<targetDir>/`（先写 `<file>.part`，完成校验后改名；`os.File.WriteAt` 写偏移，共享信号量限制全局并发）；`GET /api/downloads`（列表 + percent/speedBps）、`GET /api/downloads/<id>`（详情含分段）、`POST /api/downloads/<id>/pause|resume`（暂停/续传，context cancel 快速中断 + runGeneration 代次）、`DELETE /api/downloads/<id>?purge=`（取消，purge 清理 .part）。任务状态落盘 `data/downloads/<id>/task.json`（原子写，~1s 节流），hub 重启后未完成任务自动从分段断点续传（按 .part 实际大小收敛各分段进度）；gated 仓库传 `token`（HF token，明文存 task.json，API 输出会剔除）；下载前并行 HEAD 探测大小/Range 能力并做磁盘空间预检（Windows 用 `golang.org/x/sys/windows`），不支持 Range 的文件退化为整流下载（中断后该文件重下）。下载包清单在根目录 `model-packages.json`（由 audio.cpp 的 model_specs 转换，覆盖全部 48 个模型），`go:embed` 内置，查询接口 `GET /api/models/<modelId>/packages`。**下载源扩展**：body 带 `source:"modelscope"` 时走 modelscope——repo 映射为 `HereIsMark/<repo名>`、revision 固定 `master`、URL `https://www.modelscope.cn/models/<repo>/resolve/master/<path>`；modelscope HEAD 不带 Content-Length，探测回退 GET `Range: bytes=0-0` 解析 Content-Range（注意它回 200 而非 206，两处都按头解析不挑状态码）；HereIsMark 下仅 audio.cpp-gguf 一个仓库，其它包走 modelscope 会 REMOTE_NOT_FOUND。相关配置：`modelsDir`（默认 `models`）、`downloadThreads`（默认 8）、`downloadSegmentsPerFile`（默认 4，分段最小粒度 32MB）、`hfEndpoint`（默认 `https://huggingface.co`，不可直连时改镜像如 `https://hf-mirror.com`）。前端：模型卡片有 ⬇ 按钮打开「下载权重」弹窗（下载源/包选择/token/覆盖），页头 ⬇️ 按钮（带进行中任务数角标）打开「下载管理」面板（进度条、暂停/续传/删除，2s 轮询），DONE 任务可一键把 `models/<targetDir>` 填入启动表单权重路径
- Windows 系统托盘（`tray_windows.go`，`getlantern/systray`；菜单：打开首页 / 开机自启 / 退出程序；开机自启在 Startup 目录创建 `audio.cpp-hub.lnk` 快捷方式；`-ldflags="-H windowsgui"` 编译无控制台窗口，日志 tee 到 `logs/hub.log`；非 Windows 走 `tray_other.go` 无托盘）；启动时 `ensureWorkDir` 自动定位工作目录（cwd 无 web/ 时尝试上级目录与 exe 目录，双击 exe 也能跑）
- 版本号：`main.go` 的 `var version = "dev"`，CI 用 `-ldflags "-X main.version=<tag>"` 注入，启动日志带版本号
- Web UI 前端（`web/`）：仍是**纯原生 HTML/CSS/JS、运行时零构建**（Go 的 `staticHandler` 直接从磁盘提供），但内部结构已系统化，与旧版单文件脚本集不同：
  - **i18n 拆成「词典 + 运行时」**：`web/i18n.zh.js`（`window.I18N_ZH`，638 行）与 `web/i18n.en.js`（`window.I18N_EN`，639 行）是纯数据词典（各 605 键，`node scripts/check-i18n-parity.js` 校验对等**并校验 `web/*.html` 里 `data-i18n*` 引用键都存在**——两侧同时漏配的键只有这条能看见）；`web/i18n.js`（155 行）不含任何文案，只在初始化时读这两个全局（`web/i18n.js:13`–`14`）并导出 `window.I18N` 契约（`web/i18n.js:154`）：`lang` / `locale` / `t` / `plural` / `num` / `date` / `bytes` / `percent` / `setLang` / `applyI18n` / `onChange` / `errText` / `pick`。词典文件必须先于 `i18n.js` 加载（顺序硬约束，见 `web/index.html:519`–`521`）
  - **HTTP 唯一出口**：`web/api-client.js`（459 行）暴露 `window.AudioCppHub.api`（`web/api-client.js:443`，下称 `Api`），集中 `fetch`、错误信封（`ApiError` 把 hub 风格与 `/v1/*` 的 OpenAI 风格归一）、`AbortController` 超时/中断、数组形状守卫与**可见性感知轮询** `Api.poll`（`web/api-client.js:372`，自调度不叠加请求、单飞、标签页隐藏时暂停并在恢复后补一次，句柄 `stop()` / `refresh()`）。业务侧统一经 `web/modules/dom.js` 绑定（`web/modules/dom.js:27`）后 `import { Api } from "./dom.js"`；**新增请求一律走 `Api.*`，不再直接写 `fetch`**
  - **`web/app.js` 是薄引导层**（119 行：导入模块、跨模块重画 `rerenderAll` `web/app.js:47`、最上层弹窗的 Tab 焦点锁定 `web/app.js:81` 与 Esc 关闭 `web/app.js:93`、按序建立 2s 轮询 `web/app.js:110`–`112`、首屏末尾应用初始 hash `web/app.js:119`）；业务逻辑按职责拆进 `web/modules/` 的 17 个首屏模块（`async-ui` / `command-palette` / `dom` / `downloads-lazy` / `file-browser-lazy` / `instances` / `launch` / `models` / `panels` / `routing` / `settings-lazy` / `shell` / `sidebar` / `state` / `stats-lazy` / `tasks` / `voices-panel-lazy`）**外加 5 块懒加载 chunk**（`stats.js` / `file-browser.js` / `voices-panel.js` / `downloads.js` / `settings.js`，见「懒加载外观层」条）。模块是浏览器原生 ES 模块，**不打包、不转译**；经典组件脚本（`audio-picker.js` / `voice-select.js`）与模块之间的桥是 `web/legacy-globals.js`。完整模块地图、状态与轮询模型、编码约定见 `web/README.md`
  - **绘制前恢复**：`web/boot.js`（58 行）在 `<head>` 中、样式表之前同步解析 `localStorage` 的 `hub-theme` / `hub-lang` 并写 `<html data-theme>`，避免首屏主题闪烁（独立文件是为满足 CSP `script-src 'self'`，不允许内联脚本），同时把解析逻辑挂成 `window.HubTheme`（三态 system/light/dark，`web/boot.js:53`）供 `web/modules/shell.js` 复用
  - **语言切换重画**：`I18N.onChange`（`web/i18n.js:114`）登记的唯一回调是 `web/app.js` 的 `rerenderAll`（`web/app.js:102`），它负责重画全站并刷新动态文案。刷新方式分两种：**多实例组件**（`AudioPicker` / `VoiceSelect`）实现 `refreshLabels()` 并注册到 `window.__audioPickers` / `window.__voiceSelects`；**单例组件**（服务器端文件选择器，overlay 只在首次 `open()` 时创建；设置与下载弹窗）由 `rerenderAll` 直接调外观层的 `relocalizeFileBrowser()`（`web/app.js:60` → `web/modules/file-browser-lazy.js:46`）、`relocalizeSettings()`（`web/app.js:55`）、`relocalizeDownloads()`（`web/app.js:56`，chunk 未加载时 no-op）——不要为了统一去给单例造实例登记表。`test/unit/file-browser.test.mjs` 钉住了前者这条注册关系
  - **懒加载外观层**：「点开才用得上」的视图不进首屏模块图，改为**首屏外观层 + 动态 import()**：`modules/stats-lazy.js` → `modules/stats.js`（`#/stats` 看板），`modules/file-browser-lazy.js` → `modules/file-browser.js`（服务器端文件浏览弹窗，原为经典脚本 `web/file-browser.js` / `window.FileBrowser`），`modules/voices-panel-lazy.js` → `modules/voices-panel.js`（音色库面板，原为经典脚本 `web/voices-panel.js` / `window.openVoicesPanel`），`modules/downloads-lazy.js` → `modules/downloads.js`（下载管理与按模型下载两个弹窗），`modules/settings-lazy.js` → `modules/settings.js`（设置弹窗三个分节）。**切分线是「首屏可不可见 / 被首屏其它模块依赖」而非整块搬走**：下载角标与它的 2s 轮询留在 `downloads-lazy.js`，可执行文件登记（启动弹窗下拉 + 模型卡片已配置态）留在 `settings-lazy.js`，搬进 chunk 的只是弹窗 DOM 渲染。chunk 必须进 `web/sw.js` 的 `PRECACHE_URLS`（离线冷启动仍可用）、**不进** `index.html` 的 `modulepreload`（预载会抵消收益）；页头/入口按钮的 `onclick` 也绑在外观层（`wireXxxButton`，由 `routing.js` 传导航函数以避开模块环）。`scripts/perf-budget.mjs` 校验这条形状并把 chunk 排除出首屏体积/请求数，`test/unit/lazy-panels.test.mjs` 钉住「未加载即空转 / 首屏数据不懒加载 / chunk 只进预缓存」，`web/README.md` 3.2 有完整说明
  - **UX 能力**：hash 路由与深链接（`web/modules/routing.js`，`#/model/<id>` / `#/instance/<id>` / `#/history` / `#/voices` / `#/downloads` / `#/stats` / `#/settings`）、命令面板 `Ctrl/Cmd-K`（`web/modules/command-palette.js`）、统一异步三态骨架/空态/错误态（`web/modules/async-ui.js`）、动效系统（`web/motion.js` + `web/style.css` 末尾，遵循 `prefers-reduced-motion`）、可访问性（跳转链接、焦点管理、背景 `inert`、WCAG AA 对比度）
  - **PWA**：`web/manifest.webmanifest` + `web/sw.js`（Service Worker，导航 network-first、静态资源 cache-first + 后台再验证，`/api/*` 与 `/v1/*` **绝不缓存** `web/sw.js:150`），注册在 `web/pwa.js`（104 行，静默降级）。详见 `docs/pwa.md`
  - **设计系统**：`web/style.css`（2187 行）分 L1–L6（令牌 / 基础 / 布局 / 组件 / 工具 / 可访问性），人工核对外观用 `web/styleguide.html`（320 行，开发用演示页，不链接自主应用）
  - **开发期工具链与测试（DEV-ONLY，不进发行包）**：根目录 `package.json` + `tsconfig.json` + `eslint.config.js`（tsc `checkJs` + `noEmit`、ESLint flat config、Prettier）与 `e2e/`（Playwright，11 个 spec / 18 条用例，headless Chromium + mock 后端）、`test/unit/`（`node:test`，9 个测试文件）。**没有打包器**：发布物仍是「Go 二进制 + `web/` 源文件」，改完刷新浏览器即可；`npm install` 只是为了让静态闸门与测试能跑
- 视觉文档：`docs/diagrams/` 下 19 张架构 / 时序 / 状态 / 部署 / 数据模型图（可编辑 HTML 单文件 + 明暗 PNG 预览，入口 `docs/diagrams/README.md`、清单 `docs/diagrams/INVENTORY.md`），由 `scripts/check-diagrams.py` 校验可访问性契约（`role=img` / `aria-labelledby` 解析到真实 `<title>`+`<desc>` / 无 `<script>` / 仅允许的 Google Fonts 远程引用），CI job「图示 / 可访问性契约」执行 `python3 scripts/check-diagrams.py docs/diagrams`

## 技术栈

- Go 1.27，标准库为主；第三方依赖仅两个：`github.com/getlantern/systray`（Windows 托盘）、`golang.org/x/sys`（Windows 磁盘空间预检）
- 前端：`web/` 下纯原生 HTML/CSS/JS，**无框架、无构建步骤、运行时不需要 Node.js**，由 Go 的 `staticHandler`（`api.go:165`）直接从工作目录的 `web/` 提供；结构为「经典脚本（`window.*`）+ `web/app.js` 引导的 `web/modules/*` ES 模块」两层，文案在 `web/i18n.zh.js` / `web/i18n.en.js`，HTTP 出口在 `web/api-client.js`
- 开发期工具链（仅本地 / CI，不随发行版分发）：TypeScript `checkJs`、ESLint、Prettier、Playwright、node:test；无打包器，`tsc` 以 `noEmit` 运行、不产出任何 JS
- 模型清单 `models.json` / `model-packages.json` 在仓库根目录，`go:embed` 进二进制
- 原 Java 版（Netty）已从 main 分支移除（曾短暂放在 `legacy/`，该目录已删除）；完整备份现位于本 fork 的 `java-main-archive` 分支（含 git 历史）；其行为语义是 Go 版移植的参照

## 目录与模块划分

```
仓库根目录（Go 主工程，package main）：
├── main.go               # 入口：hub.config.json 加载、Hub 聚合各管理器、工作目录自动定位、
│                         # 退出信号处理（停实例 + 暂停下载落盘）、version 变量（CI 注入）
├── api.go                # 全部 /api/* 路由与 handler（模型/实例/executables/profiles/run/tasks/
│                         # history/voices/audio/fs/downloads/stats），OpenAI 错误格式之外的 JSON 响应约定
├── instance.go           # 实例生命周期（server.json 生成、进程拉起、端口分配、健康轮询、
│                         # run/<id> 清理、事件日志）、FindByName/FindAnyByName（/v1 路由）、设备探测
├── task.go               # 推理任务队列（每实例串行 executor、状态落盘回放、TTS 复用历史链路、
│                         # 非 TTS forwardToFile 落盘结果）
├── history.go            # TTS 操作历史（index.jsonl 索引、参考音频快照、groups.json 分组、
│                         # 响应 JSON 流式提取 "audio" 写 wav；无容量淘汰，只手动删）
├── stats.go              # GET /api/stats 用量与性能聚合（纯派生读接口）：用量取自历史索引
│                         # （无淘汰，长期口径），性能取自内存任务时间戳（近期窗口）；
│                         # 分位数用线性插值 percentile，RTF = 执行秒 ÷ 音频秒
├── download.go           # 模型权重下载器（Range 分段 + WriteAt、断点续传、暂停/恢复/取消、
│                         # task.json 原子落盘、重启自动续传、速率采样）
├── download_disk_windows.go / download_disk_other.go  # 磁盘空间预检（Windows 用 x/sys，其它平台跳过）
├── packages.go           # 下载包清单（model-packages.json embed、default 包选择、
│                         # resolve URL 逐段编码、modelscope 源映射）
├── proxy.go              # /v1/* OpenAI 兼容代理（请求体落盘、逐字节提取 "model"、按服务名路由、
│                         # 响应逐块 Flush 透传、OpenAI 风格错误体、启动清扫 proxy-cache）
├── registry.go           # ExecutableRegistry（executables.json 可执行文件登记，条目可带 env，
│                         # ${VAR} 占位符按 hub 进程环境展开）与 ProfileRegistry（data/profiles.json）
├── audio.go              # data/uploads WAV 上传 + RIFF/WAV 头解析（无第三方依赖）
├── voices.go             # data/voices 全局音色库（名称唯一 + 文本内容 + 音频文件）
├── fs.go                 # /api/fs/* 服务器本地文件浏览
├── fsattr_windows.go / fsattr_other.go  # Windows 隐藏属性判断（build tag 分平台）
├── tray_windows.go       # Windows 系统托盘 + 开机自启（Startup 目录 .lnk）+ 日志 tee logs/hub.log
├── tray_other.go         # 非 Windows 平台托盘 stub（直接跑 HTTP 服务）
├── util.go               # JSON 响应约定（errJSON/okJSON/writeJSON）、UserError、readBodyMap、
│                         # optString/optIntPtr/optStringMap、newID（8 位随机 hex）、writeFileAtomic 等
├── constants.go          # 行为常量集中处（taskQueueSize / logTailLines / dlSegmentMin 等）
├── proc_windows.go / proc_other.go  # hideChildWindow（抑制子进程控制台窗口，build tag 分平台）
├── models.go             # models.json embed 与模型查询
├── internal/idvalidate/  # 会被拼进文件路径的 ID / 下载路径校验（集中正则，独立单测）
├── internal/wav/         # 纯 RIFF/WAV 头解析（不依赖 hub 其余代码，独立单测）
├── *_test.go             # 单测：ids（ID 校验）/ instance / proxy / download / history / task（含 -race）
├── models.json           # 支持模型清单（id/category/serverTask/paramSchema 等），GET /api/models 直接返回
├── model-packages.json   # 模型下载包清单（repo/revision/targetDir/files/default/gated）
├── icon.ico              # 托盘图标（go:embed）
├── go.mod / go.sum
├── cmd/fanout-proxy/     # 多机语音农场统一入口（独立 package main，stdlib only，默认 :18082）
│                         #   config.go(farm.routes.json 校验) / health.go(7s 轮询 + 连续 2 次失败判掉)
│                         #   router.go(model 改写 + 目标选择 + 流式转发) / main.go(4 个端点)
│                         #   端点：GET /farm/health、GET /api/instances、GET /v1/models、POST /v1/audio/speech
│                         #   文档 docs/fanout-design.md，本目录 README.md 含构建/冒烟/部署；systemd user unit 模板
clients/                  # 仓库内 Python 客户端（stdlib only，不进 Go 构建）
└── audiocpp_client.py     #   TTS/音色设计、STT、voice sweep、音色库/历史、农场健康；两个 base URL：
                          #   DEFAULT_HUB = fan-out :18082（TTS + 发现，--hub / AUDIOCPP_HUB_URL）；
                          #   DEFAULT_DIRECT_HUB = :18080（fan-out 不代理的 hub 内接口，
                          #   --direct-hub / AUDIOCPP_DIRECT_HUB_URL）；本地开发两者同指 127.0.0.1:18080
web/                      # 前端静态文件（无构建步骤、运行时零 Node）
├── index.html            # 全部静态 DOM + CSP（web/index.html:7）+ 脚本加载顺序（顺序有硬约束）
├── style.css             # 设计系统 L1–L6（令牌 / 基础 / 布局 / 组件 / 工具 / 可访问性）
├── app.js                # ES 模块引导层：导入模块、rerenderAll、Esc/Tab 焦点锁定、启动顺序
├── modules/              # 17 个首屏业务模块（async-ui / command-palette / dom / downloads-lazy /
│                         # file-browser-lazy / instances / launch / models / panels / routing /
│                         # settings-lazy / shell / sidebar / state / stats-lazy / tasks /
│                         # voices-panel-lazy）+ 5 块懒加载 chunk（stats / file-browser /
│                         # voices-panel / downloads / settings），完整地图见 web/README.md
├── i18n.zh.js / i18n.en.js  # 中 / 英词典（window.I18N_ZH / I18N_EN，各 605 键，纯数据）
├── i18n.js               # I18N 运行时（window.I18N，不含文案），见「项目概述」的 Web UI 条目
├── api-client.js         # 唯一 HTTP 出口（window.AudioCppHub.api：ApiError / poll / list）
├── legacy-globals.js     # 经典脚本 ↔ ES 模块的桥（window.$ / el + 转发器）
├── boot.js / motion.js / pwa.js  # 绘制前主题恢复（HubTheme）；动效触发；Service Worker 注册
├── sw.js / manifest.webmanifest / offline.html  # Service Worker、PWA 清单、断网兜底页
├── audio-picker.js / voice-select.js / wav.js
│                         # 自包含经典组件（上传 / 录制 / 裁剪、音色下拉、WAV 工具；
│                         # 音色库面板已改为懒加载模块 modules/voices-panel.js）
├── styleguide.html       # 组件样式指南页（开发用，浏览器直接打开）
├── globals.d.ts          # 开发期类型声明（经典脚本的 window.* 公开接口，供 tsc checkJs）
├── README.md             # 前端贡献指南：硬约束、模块地图、加载顺序、状态与事件流、编码约定
└── icons/                # PWA 图标（由 scripts/gen-icons.cjs 生成）
test/unit/                # node:test 单元测试（wav / i18n / app-utils / api-client /
                          # file-browser / stats-lazy / lazy-panels / routing）
e2e/                      # Playwright e2e（11 个 spec / 18 条用例，headless Chromium + mock 后端，无 Go/GPU/模型）
scripts/                  # 闸门与生成脚本（check-i18n-parity.js、check-sw-precache.mjs、check-diagrams.py、ui-inventory*、
│                         # perf-budget.mjs、gen-icons.cjs、axe-audit.js、record-demos.cjs）
package.json / package-lock.json  # DEV-ONLY 工具链与测试脚本（tsc/ESLint/Prettier/Playwright）
tsconfig.json / eslint.config.js  # DEV-ONLY 静态闸门配置（checkJs+noEmit / ESLint flat config）
docs/                     # 文档：API.md（路由权威参考）、farm.md + agent-api.md + fanout-design.md
│                         # （多机农场拓扑 / 客户端契约 / fan-out 设计；客户端与文档默认入口 :18082）、
│                         # diagrams/（19 张图 + CI 校验）、ui.md、motion.md、pwa.md、assets/、media/
.github/workflows/        # CI（build-and-release.yml 发布流水线 + ci.yml 质量/图示/前端闸门）
```

运行时（相对工作目录）产生的数据，均被 `.gitignore` 排除：`logs/`、`run/<instanceId>/`（server.json + server.log + proxy-cache/，停止后自动清理）、`data/`（uploads/、voices/、profiles.json、history/<modelId>/ 操作历史、downloads/<taskId>/ 下载任务状态、tasks/<id>.task.json 推理任务状态 + <id>.result.json 非 TTS 结果，重启回放）、`models/`（下载的模型权重）、`ssl/`（HTTPS 证书，Go 版尚未实现）、`executables.json`、`hub.config.json`、`audio.cpp-hub(.exe)` 构建产物，以及 DEV-ONLY 工具链的 `node_modules/`、`test-results/`、`playwright-report/`、`blob-report/`。

## 构建与运行

本地开发（Go SDK 装在 `C:\Users\Mark\go-sdk\go1.27.1`，未加 PATH；GOPROXY 已 `go env -w` 设为 `https://goproxy.cn,direct`）：

```bash
export PATH=/c/Users/Mark/go-sdk/go1.27.1/bin:$PATH   # Windows Git Bash

go vet ./... && go build -o audio.cpp-hub.exe .                          # 控制台调试版
go build -ldflags="-H windowsgui" -o audio.cpp-hub.exe .                 # 托盘发布版（无控制台窗口）

./audio.cpp-hub.exe    # 运行无需固定目录（ensureWorkDir 自动定位 web/ 所在目录）
```

交叉编译（CGO_ENABLED=0 即可，systray 有平台 build tag）：

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o audio.cpp-hub .
```

首次运行后自行生成 `hub.config.json` / `data/` / `logs/` 等。代码改动后如需更新模型清单，直接编辑根目录 `models.json` / `model-packages.json`（go:embed 内置，无需复制步骤）。

改 `web/` **不需要任何构建**：编辑源文件后刷新浏览器（`index.html` 不带缓存、其余静态资源 1 小时缓存，必要时硬刷新）。若要跑开发期闸门（Node ≥ 22），它们**只做检查、不产出任何运行期文件**：

```bash
npm ci
npm run check          # check:types(tsc checkJs+noEmit) + lint(ESLint) + format:check(Prettier)
npm run test:unit      # node:test：test/unit/**/*.test.mjs
npm run test:e2e       # Playwright：headless Chromium + mock 后端，首次需 npx playwright install chromium
```

`tsc` 以 `noEmit` 运行，输出目录为空，不可能被误当成构建产物进发行包。发行包始终是「Go 二进制 + `web/` 源文件」。

## 测试

自动化测试已覆盖 Go 侧与前端两侧，**无外部测试框架依赖**（Go 用标准库 `testing`，前端用 `node:test` + Playwright）：

- **Go**：`go test ./...`（CI 另跑 `go test -race ./...`）。`*_test.go` 覆盖 ID/路径校验（`ids_test.go` + `internal/idvalidate`）、实例生命周期与端口分配（`instance_test.go`）、安全响应头（`headers_test.go`）、`/v1/*` 代理与 model 提取（`proxy_test.go`）、下载任务（`download_test.go`）、历史落盘与分组（`history_test.go`）、用量与性能聚合（`stats_test.go`）、任务队列收敛与并发（`task_finalize_test.go` / `task_race_test.go`）、WAV 头解析（`internal/wav`）；`cmd/fanout-proxy/` 另有表驱动单测（别名解析 / 目标选择与故障转移 / 2 次失败判掉 / model 改写 / 已提交路由表）
- **前端**：`npm run test:unit`（`test/unit/`：WAV 工具、i18n 含中英键 parity、app-utils、api-client、file-browser、stats-lazy、lazy-panels 三个懒加载外观、routing、command-palette 焦点锁定）、`npm run test:e2e`（`e2e/`：11 个 spec / 18 条用例，Playwright + `page.route` mock 后端，覆盖实例/任务/历史/音色/下载/可执行文件/ASR/文件浏览器·看板·音色库·下载·设置五个懒加载契约/UI 切换/冒烟，**无需 Go 二进制、GPU 或模型**）
- **其它闸门**：`node scripts/check-i18n-parity.js`（中英 605/605 键对等 + `web/*.html` 的 `data-i18n*` 引用键均存在）、`node scripts/check-sw-precache.mjs`（`web/sw.js` 的 `PRECACHE_URLS` 覆盖 `index.html` 本地引用与模块图传递闭包——`perf:budget` 的三方一致只管 ES module 图，管不到经典脚本）、`python3 scripts/check-diagrams.py docs/diagrams`（19/19 图示可访问性契约）、`npm run ui:inventory:check`（UI 清单防漂移）、`npm run perf:budget`（首屏体积预算）。详见 `TESTING.md` 与 `web/README.md`

改动仍需手动过一遍受影响页面（中英切换 / 深浅主题 / 窄屏），自动化测试覆盖的是契约与纯函数，不替代人工看界面。

## 发布与部署

发布由 `.github/workflows/build-and-release.yml` 完成，推送 `v*.*.*` tag 或手动触发：

- 在 ubuntu-latest 上用 actions/setup-go@v5（Go 1.27）交叉编译，`-ldflags "-X main.version=$VERSION"` 注入版本（无 tag 时 dev-<sha7>）
- 产出**四个原生 zip**（CGO_ENABLED=0，无 JRE/launcher）：`audio.cpp-hub-<VERSION>-windows-amd64.zip`（`-H windowsgui` 托盘版 exe）、`-linux-amd64.zip`、`-linux-arm64.zip`、`-darwin-arm64.zip`，每个包内含对应平台的二进制 + `web/` + `README.md`（**不含** `audiocpp/` 占位目录），另附 `SHA256SUMS`
- softprops/action-gh-release@v1 创建 GitHub Release（中英双语 notes：备份 data/ 提醒、安全警告、变更 commit 列表），zip 同时上传 artifact
- 发布包不含 audio.cpp 二进制，用户需自行下载放入 `audiocpp/` 目录并通过 UI 登记可执行文件
- 发布物**不含** `package.json` / `node_modules` / `e2e/` / `test/`——前端工具链与测试是 DEV-ONLY，运行期只需要 `web/` 源文件

CI 另有 `.github/workflows/ci.yml`（推送 / PR 触发，与发布流水线分离）：`quality` job 跑 `go mod verify` / `gofmt -l .` / `go vet ./...` / `go test -race ./...`（**不执行 `npm ci`**，因此看不到 `node_modules` 对 `go list ./...` 的副作用）；`diagrams` job 跑 `python3 scripts/check-diagrams.py docs/diagrams`；`web-toolchain` / `frontend` job 跑 `npm ci` + `check:types` / `lint` / `format:check` / `test:unit` / `ui:inventory:check` / `perf:budget` / `test:e2e`，**不执行任何 Go 命令**。

## 代码约定

- **语言**：代码注释一律用英文（标识符同样用英文）。**用户可见错误消息与前端文案仍为中文**（前端走 `web/i18n.zh.js` + `web/i18n.en.js` 双词典，`web/i18n.js` 只是运行时不含文案；新增文案必须同时改两份并跑 `npm run check:i18n`）。日志消息沿用各自模块既有语言，不做强制统一。注：2026-09 之前注释为中文，`stats.go` / `web/modules/stats.js` 等新代码已切到英文，老文件暂未批量转换（属独立清扫任务，不要在功能 PR 里顺带改）
- Go 代码风格：gofmt 标准格式；导出的管理器方法与类型多带中文注释简述职责
- ID 生成统一为 8 位随机 hex（`util.go` 的 `newID()`，对应原 Java 版 UUID 前 8 位）；所有会被拼进文件路径的 id / 下载路径走 `internal/idvalidate` 集中校验，不要在 handler 里另写正则
- 前端 HTTP：**一律走 `Api.*`（`web/api-client.js`），不再写裸 `fetch`**；轮询一律 `Api.poll`（不写 `setInterval`）；新错误码语义扩展 `api-client.js` 的 `CODE`。服务端 / 用户可控字符串进 HTML 前必须 `esc()`，URL 属性用 `safeHttpUrl()`，数字 / 字节 / 日期 / 百分比走 `I18N.num` / `bytes` / `date` / `percent`
- 前端模块：业务逻辑进 `web/modules/*.js`（跨文件 `import` / `export`），不要往 `web/app.js` 堆；新经典脚本用 IIFE 包裹并放在模块入口之前，需要 `$` / `showToast` 等先过 `web/legacy-globals.js`；改动 `index.html` 脚本清单或模块图时同步 `web/sw.js` 的 `PRECACHE_URLS`（否则离线冷启动会在该脚本处断掉）
- 前端硬约束：**无构建、无框架、无内联**——CSP（`web/index.html:7`）为 `script-src 'self'`，禁止内联脚本、`on*` 事件属性、内联 `style` 与外部 CDN；模块 `import` 只用同源相对路径
- 文档：路由清单以 `api.go` 的 `registerRoutes` 为唯一权威，`docs/API.md` 与之逐条对齐；`file:line` 引用写进文档前必须核对当前代码（行号会随改动漂移）；图示新增后同步 `docs/diagrams/README.md` / `INVENTORY.md` 并让 `scripts/check-diagrams.py` 通过
- 持久化：各 Registry/管理器直接读写工作目录下的 JSON 文件（`encoding/json`），互斥锁保护，无数据库；文件不存在/为空即视为空列表；状态文件一律原子写（tmp + rename，见 `writeFileAtomic`）
- 错误处理：用户可预期错误返回 `UserError{Code, Params, Msg}`（`util.go`），API 层转成 `{"ok":false,"code","params","error"}` 结构的 JSON；`/v1/*` 代理用 OpenAI 风格 `{"error":{"message","type"}}`
- 外部进程交互统一约定：`audiocpp_server --config <server.json>`，健康检查 `GET /health`，任务接口 `POST /v1/tasks/run`
- Windows 兼容细节：可执行文件路径自动补 `.exe` 探测；删除运行目录带重试（Windows 文件句柄释放延迟）；托盘/自启仅在 Windows 生效（build tag 分平台）

## 安全注意事项

- 这是**局域网/本机工具，无鉴权、无 HTTPS，不具备公网防护能力**。不要把端口直接暴露到公网（发布说明中已明确警告）；远程访问请走反向代理 + HTTPS
- 防路径穿越的现有约定：文件名 id 一律用正则 `^[a-zA-Z0-9-]{1,32}$` 校验后再拼路径（见 `api.go` 的 `safeTaskID`、`audio.go` 上传件 id）；历史的 modelId/taskId 键用 `^[a-zA-Z0-9_-]{1,64}$`（多放行下划线，见 `history.go` 的 `historySafeKey`）；下载的 targetDir 用 `[a-zA-Z0-9._-]{1,64}` 且必须含字母数字、文件相对路径逐段拒绝 `..`/绝对路径/盘符（见 `download.go` 的 `validateDlTargetDir/validateDlFilePath`）。新增任何接收路径/文件名的接口必须沿用同样的校验
- `/api/fs/*` 接口有意暴露服务器本地文件系统浏览（用于选择模型权重路径），这是设计使然，但再次说明不能暴露公网
- 上传限制：WAV 上限 50MB；`/api/*` 请求体上限 64MB（`util.go` 的 `maxBodyBytes`）；`/v1/*` 代理请求体上限 `proxyMaxBodyBytes`（默认 1GB）
