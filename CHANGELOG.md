# Changelog

本文件记录 audio.cpp-hub 的重要变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Fixed

- 修复 1280x720 矮笔记本一档的三处首屏塌陷（Phase R2，`.app` 布局未动，只加 CSS + 一段视口判定，无新依赖、无内联样式）：① 右栏 TTS 面板里「上一条录音 + 合成按钮」被挤出首屏，只能滚面板才点得到——把 ≤900px 已有形态的 `.tts-action-bar` 吸底扩到**横向矮视口**（`(min-width: 901px) and (max-height: 800px)`：`position: sticky; bottom: 0`、实底 `--bg-elevated`、细顶线、`env(safe-area-inset-bottom)`），同时收紧面板垂直节奏（`main` padding/gap、`#now-queue`、`.panel-card`、label、picker、dropzone、`#tts-result` 边距各收一档，指令框从 4 行收到 ~3 行，「高级参数」仍是收起的 `<details>`），实测「合成文本框 + 合成按钮」都留在首屏 720px 内（文本框 283→361px，合成按钮 608→645px，右栏滚动位移仍为 0）；② 左栏「最近活动」与模型行整块落在折叠线下、侧栏自己滚却没有提示——左栏在该断点改为**独立滚动容器**（`flex: 0 0 340px` + 自身 `overflow` 由 L4 既有规则接管，`max-height` 顶住视口），实例卡片压缩（padding/gap/字号/操作行距各收一档，卡片内重复的内存图例 `.card .mem-legend` 收起——列表上方的 `#mem-markers` 全局图例还在），「最近活动」**默认收起**（标题与计数仍在，`web/modules/activity.js` 新增 `shortSidebarViewport` / `defaultActivityOpen` / `applyActivityPanelDefault`：用户手动开合记 `localStorage` 时优先，未记录时按视口高度套默认，跨过 800px 断点重套，纯函数有单测），模型行以收起态紧随其后，侧栏末条 `#left::after` sticky 渐隐提示下面还有内容；③ 1920x1080 两栏被拉满整幅宽、左右各剩一大片空白——`@media (min-width: 1600px)` 给 `header` / `main` / `footer.hint` 定 `width: 100% + max-width: 1680px + margin-inline: auto`（`width` 必须是定值，只写 `max-width` 会让弹性子项退化成 fit-content，限幅就变成收缩；`footer.hint` 比元素选择器更具体才压得住那两条 0 边距），左栏宽度不变、不横向溢出
- 修复 `scripts/ui-shots.mjs` 的首屏折叠误判：左栏与右栏工作区是**两个独立滚动容器**，控件停在自身容器折叠线下时需要滚动才够得到，却仍被算成「首屏可见」。`measureControl` 现在沿祖先链检查可滚动祖先的裁切（`scrollHeight > clientHeight` 且 `overflow-y` 为 `auto|scroll|overlay` 时比对可见交集，可见高/宽不足 4px 即判 clipped），`aboveFold` 因此要求「既在视口内、又没有被自己的滚动容器挡住」；`reachable` 的快照回滚逻辑不变。折叠结果仍与通过判定分离（独立字段、不 gate）
- 修复 `e2e/responsive.spec.mjs` 在 Node 侧 lint 下的 `no-undef`：1920x1080 用例的 `page.evaluate` 回调里用了 `window.innerWidth`。`eslint.config.js` 给这个文件的 block 显式补 `window: "readonly"`（与 `scripts/ui-shots.mjs` / `axe-audit.js` 同一手法：只声明注入页面回调用得到的几个名字，不打开整个 browser globals，Node 侧拼写错误仍会被 `no-undef` 抓住）
- 删除两个遗留的开发期探针脚本 `probe-dev.mjs` / `debug-cap-dev.mjs`（上一轮 R2 超时前留在树里，已被 `pre-R2b` 提交进来）
- 补齐 Phase R2 的 e2e 闸门：`e2e/responsive.spec.mjs` 新增两条用例（仍走 mock 后端，无 Go / GPU / 模型）——`1280x720` 钉住「无横向溢出 + 右栏滚动位移为 0 + 合成按钮与合成文本框都在首屏内 + `.tts-action-bar` 是 sticky 且背景为不透实底 + 最近活动与模型行默认收起、两者的标题/计数都在视口内且没被左栏滚动容器裁掉 + 左栏自身可滚、高度被页头页脚挤到 720 以下」，`1920x1080` 钉住「内容限幅 ≤1700px、header / main / footer 三者左右边距差 ≤2px、左栏仍是 360px、1080 高视口不吸底且最近活动默认展开」。原有六条（mobile 三档页头按钮、抽屉、360x800 吸底、1280/1920 回归）不变
- 修复 TTS 头部「声音设计 / 克隆 / 音色库」分段控件在真实浏览器里整块不渲染：`web/modules/panels.js` 把 `querySelectorAll` 返回的 **NodeList** 当数组 `.map`（Chromium 控制台 `sel.querySelectorAll(...).map is not a function`，`renderTtsSegments` 每次调用都抛，控件永远画不出来——NodeList 只有 `length` / `item()` / 下标 / `forEach` / 迭代，没有 Array 方法）。改为 `Array.from(...)` 后再 `map`。同类问题在单测里抓不到，因为 DOM 桩的 `querySelectorAll` 返回的是 Array；现在桩改成 **NodeList 形状**（显式不给 `map` / `filter` / `reduce` 等），`test/unit/tts-segments.test.mjs` 的渲染路径用例先炸（生产调用栈：`panels.js:318` → `ttsModeOptions` → `renderTtsSegments` → `updateTtsBlocks`），修复后转绿；另修掉该形状暴露出的 3 处测试自身误用（`elapsed-timer` / `last-take` / `model-panel`）
- 修复 mobile / tablet 窄屏下的横向溢出与不可达控件（≤900px 一档）：根因是 `.header-actions` 这条**不换行的 flex 行**——农场 chip + 7 个图标按钮的固有宽度（360px 视口实测 353px、768px 实测 548px，农场 chip 带 GPU 名时更宽）超出页头可用宽度，语言切换被裁、设置与主题按钮整体冲出右边缘，`documentElement.scrollWidth` 在 360/390 下被顶到 520px、768 下 827px（农场 chip 填充时 891px）。修法不是加溢出菜单，而是让页头自己分行（`header { flex-wrap: wrap }`，`.header-actions` 整组 `flex: 1 1 100%` 并允许自身换行），整排图标按钮仍然直接可见、直接可达，键盘焦点顺序与视觉顺序一致。同时：`.theme-btn` / `#lang-toggle` 触摸目标收到 ≥40px（≤720px 一档 44px）；农场 chip 收缩（收起 GPU 名，只留状态点 + 失败次数）；`.subtitle` 在 900px 起隐藏；实例工具栏的 select 独占一行、按钮行自换行且每颗 ≥40px；Now / Queue 状态条加 `overflow-x: auto` 兜底；TTS 面板底部新增 `.tts-action-bar` 容器，「上一条录音」与合成按钮在窄屏 `position: sticky` 吸在面板底部（实底 + `env(safe-area-inset-bottom)`），合成文本框从 4 行压到 3 行，首屏同时看见文本框与按钮；左栏抽屉补 `max-height: 100dvh` + `overscroll-behavior: contain` 自己滚、不把底层页面带走，并新增吸附在抽屉顶部的 `#drawer-close` 关闭键（桌面端 `display:none`，与遮罩点击、Esc 走同一条 `closeDrawer`）；`#menu-toggle` 补 `aria-expanded` / `aria-controls`
- 修复左栏 1280x800 的收纳：实例卡片第三行身份信息（`#<id> · <后端>`）确认已从卡片 markup 去掉（完整 id / 后端 / 设备 / 可执行文件只在卡片 `title` 提示与「详情」弹窗），并把卡片、内存条、卡片列表、小节标题、活动 / 模型面板的垂直 padding 与 gap 收紧一轮（实例卡 266px → 241px，卡片列表 gap 10 → 8，内存条内外距、进度条边距、图例与操作行距各收 2–4px，小节标题与两个 `<details>` 面板的 margin 各收 2–4px，模型卡 padding 8px → 6px）。实测首屏（1280×800、两号就绪实例带内存条）可见：实例列表两张卡 + 「最近活动」面板头（模型行在面板收起时同样落在首屏内；面板展开时其「最近一小时」时间条是内容，不属间距调整范围）

### Added

- 新增 UI 验收工具链（仅开发期，不进发行包）：`scripts/ui-shots.mjs` 按固定视口矩阵（mobile 360x800 / 390x844、tablet 768x1024、laptop 1280x720、desktop 1920x1080）对 hub Web UI 做**只读**检查（不点击、不提交表单，非 GET/HEAD 请求由 runner 自行 abort），逐视口记录控制台错误（`console.error` + `pageerror`）、横向溢出（`documentElement.scrollWidth <= clientWidth`）与关键控件状态（合成按钮 / 实例卡片 / 活动面板 / 六个页头按钮的 present·visible·reachable·aboveFold），暗色截图全量 + 笔记本视口恰好一张浅色截图，向 stdout 打印 `{baseUrl, generatedAt, viewports:[…], overall}` JSON（副本落 `OUT_DIR/ui-shots.json`），任一视口不通过退出码 1；首屏折叠是独立结果，不参与通过判定但必须出现在报告里。`test/unit/ui-shots.test.mjs`（node:test）钉住纯导出（视口矩阵、唯一浅色视口、溢出判定、报告汇总）。运行：`BASE_URL=... OUT_DIR=... node scripts/ui-shots.mjs`（可选 `ONLY=视口名,视口名` 跑子集、`ACTION=generating` 仅作备注）。`AGENTS.md` 新增「UI verification standard」一节，约定视口矩阵、深浅色截图数量、每视口必查项、PR 图片标注（production / mock-backend / concept，mock 不得伪装成线上结果）、引擎署名与隐私红线（截图里不得出现住所、密钥、token 与内网主机名/IP）
- WebUI 工作区顶部（实例工具栏与合成面板之间）新增「Now / Queue」状态条（`web/modules/nowqueue.js`）：左边标题图标 + 「Now / Queue」，一枚「In flight n / cap」容量 chip，每个运行中的任务一枚强调色 chip（脉冲点 · 实例名 · 文本前 14 字摘要 · 耗时 · 取消键），剩余容量用虚线「free」chip 占位，竖线之后是「Queued n」与每条排队任务的 chip（队列位次 · 实例名 · 已等待 · 取消键）。没有就绪实例也没有在途任务时整条收起；空闲时收成一行「In flight 0 / N」+ free chips。窄屏折行。数据与左栏「最近活动」同源（同一份 `GET /api/tasks` 缓存 + 同一路任务 SSE），**不新增轮询器**：SSE 通着时只靠 `task.*` 事件重画，SSE 断开时另有一个 15s 保险拉取复用同一条请求路径。运行中 chip 的耗时刻度走全站唯一的 `elapsed.js` 表与 `instances.js` 那个定时器（`.badge-elapsed[data-elapsed-id]`），本模块不开第二个耗时 interval；排队 chip 的「已等待」不是任务耗时，自带一个每秒一跳、且**只在真的有排队 chip 时**存在的轻量 interval。取消单击即生效（不弹确认框），同一任务在途期间按钮 disabled 并挡住重复点击，请求失败沿用既有的 toast。chip 的 tooltip 给出实例名、8 位短任务 id 与完整文本
- `GET /api/farm/health` 的摘要新增可选透传字段 `inFlightCap`（数字，取自 fan-out 的 `MaxInFlightPerTarget`）：**fan-out 没报就不写这个键**（旧 hub 与单机部署都没有），客户端因此回落到自己的默认值 `2`，而不是把「没有这个字段」读成「并发额度为 0」。上报值存在但格式非法（负数、非整数、超范围）时整份摘要判为不可用，与 `hubs[].failures` 同一规则。该字段只用于上面的并发上限显示，浏览器不打跨源请求，值仍由 hub 去拉配置好的 fan-out URL（`farm_health.go` + `farm_health_test.go` 表驱动）
  - 已知限制：hub 的 `GET /api/tasks` **没有分片（chunk）进度字段**，因此「Now / Queue」状态条里画不出「第 n / m 片」的分片进度条。概念稿在这条状态条上还有一处分片进度；要在不编造数据的前提下补上，后端需先在任务快照里加一个分片进度字段（例如 `result.chunkDone` / `result.chunkTotal`，或任务对象上的同名字段），前端再照读。**本次没有加这个字段，也没有用任何近似值去填**

- Web UI 页头按钮改用内嵌 Lucide 图标雪碧图（`menu`、`mic-vocal`、`history`、`download`、`chart-column`、`languages`、`settings`，主题为 `sun` / `moon` / `monitor`，面板关闭为 `x`）。路径数据来自 lucide-static，许可证全文在 `third_party/lucide/LICENSE`（ISC，部分图标源自 Feather / MIT）
- WebUI 合成面板（TTS）头部行新增「声音设计 / 克隆 / 音色库」分段控件（概念稿 `.seg`）：右侧与模型小胶囊并排，`role="tablist"` / `role="tab"`、`aria-selected`、roving tabindex 与 Left / Right / Home / End 键盘操作，aria-label 走词典（`tts.seg.*`，中英各四条）。它是**纯视图**：映射逻辑在零依赖的纯模块 `web/modules/tts-modes.js`（`segmentsFor` / `activeSegment` / `targetFor`），分段只从面板上**真实的**「合成模式」下拉选项 value/label 推导（大小写不敏感的子串，中英文同规则；design → clone → library 依次认领，一个选项只归一颗分段），少于两颗分段解析出来就整块隐藏。点一颗分段 = 给真实 `<select>` 赋值并派发冒泡 `change`（与用户手动切换完全同一条路径，请求体拼法一点没动）；真实下拉被直接改动（含模型切换后 panels.js 重建那一行）时高亮跟随。没有 library 模式而当前模型带着音色选择器时，「音色库」那颗解析为快捷键：只聚焦 / 滚动到 `#voice-picker`，**不改模式**。标题行同时改造：`#tts-title` 只留本地化标题，选中的模型名进旁边的小胶囊（原来拼在标题里的「— 型号」挪到胶囊）
- WebUI「上一条录音」条现在会在**页面开着的时候**刷新：任何 tts 任务结束（包括别的标签页 / Python 客户端 / fan-out 提交的）都换条、重新解码波形、更新实例名与「多久之前」。SSE 的 `task.finished` 是主路径（`task-events.js` 补拉一次 `GET /api/tasks/{id}`——载荷没有 `finishedAt` / `instanceName`，非 tts 事件直接跳过、同一 taskId 单飞、失败静默），模型切换 / 首屏重挂的任务清单是兜底（`refreshLastTake`：清单里有更新的才换，SSE 已经刷新过时不重复解码）。非 tts / 未完成的任务一律忽略；换条时 `#tts-player` 指向新地址，播放键才不至于还播上一条。挑选逻辑抽成纯函数 `pickLatestTake`（新的 DONE tts 胜出），两侧都有单测
- 实例卡片压缩：去掉每张卡第三行身份信息（`#<id> · <可执行文件>`），副标题也不再带后端 / 设备（只留型号 · GPU 名 · 端口）。完整 id / 后端 / 设备 / 可执行文件 / 端口搬进卡片自身的 `title` 提示，「详情」弹窗里本来就有——1280x800 下左栏实例列表、最近活动与模型三块不用再滚过两张卡才看全
- 首屏性能预算按实测上调：TTS 头部分段控件新增首屏模块 `web/modules/tts-modes.js` 与 `.panel-head` / `.panel-chip` / `.seg` 规则（控件就在首屏 TTS 面板头部，点开才加载的形状不适用）。实测 JS raw 492.1（471.9 → +20.2）、JS gzip 179.4（175.1 → +4.3）、CSS raw 96.2（94.3 → +1.9）、JS+CSS gzip 合计 204.9（200.4 → +4.5）、子资源请求数 40（39 → +1 个模块）；上限按同一口径重新钉到 jsRawKiB 493 / jsGzipKiB 180 / cssRawKiB 97 / totalGzipKiB 205 / subresourceRequests 40（`scripts/perf-budget.mjs`，注释里记了 before → after 表）
- 每个运行中的实例采样 RSS，并尽力读取 VRAM（Linux DRM fdinfo，否则 `nvidia-smi`，失败则退避）。`GET /api/instances` 在第一次采样后带上可选的 `memory`（当前 / 峰值 / 时间加权平均）；任务结束时把 RUNNING 期间的峰值写成 `peakRamBytes` / `peakVramBytes`。非 Linux 省略 `memory`
- `GET /api/events/stream`：任务生命周期的 Server-Sent Events（连接时 `hello`，约 15 秒一条 `: ping`，以及 `task.queued` / `task.started` / `task.finished` / `task.failed` / `task.cancelled`）。Web UI 在对应实例上显示「生成中…」，推送不可用时仍靠原来的 2 秒轮询。fan-out 不代理这条流
- `memory` 对象新增三个可选字段：`ramIdleBytes` / `vramIdleBytes`（实例没有 RUNNING 任务期间观察到的**空闲基线**，即「这个模型闲着时占多少」，采到第一个空闲样本之前省略）与 `vramTotalBytes`（该进程所在 GPU 的显存总量，前端显存条的比例尺）。总量是尽力而为且绝不猜：nvidia 用 `nvidia-smi --query-gpu=index,name,memory.total`（每个 hub 生命周期只查一次，与既有进程查询共用超时与失败退避，不增加每轮采样开销；卡名允许逗号：首字段是序号、末字段是 MiB、中间拼回名字），AMD 用 `/sys/class/drm/card*/device/mem_info_vram_total`（同样只读一次）；统计不出「只有一张卡」就省略该字段。单卡且名字非空时另给 `gpuName`（多卡或 DRM 省略）。`idleSinceMs` 是最近一次忙→闲的时刻（epoch ms）；从未忙过则取第一次空闲采样，还没出现过空闲样本时省略
- 实例卡片与实例状态条原来并排的两个忙碌徽标（轮询的「工作中」与 SSE 的「生成中…」）合并成一个「生成中…」：脉冲圆点 + 200ms 一跳的耗时计时（卡片、工具栏、合成状态行共用一个定时器，没有任务时停掉）。忙碌判定由 SSE（`task.started` … 终态）与轮询（`taskCount` / 采样器 `busy` / 任务轮询的 `startedAt`）合并成一个纯函数，推送断开时自动回退到轮询
- 实例卡片与实例详情弹窗把 RAM / VRAM 的两行文字换成进度条：填充为当前值，细刻度线标峰值与均值，下方一行「Peak · Avg · Idle」（单位在行尾出现一次，≥ 1024 MiB 统一换算成 GiB）。显存条在有 GPU 总量时按总量取比例尺，占用 ≥ 85% 时用渐变提示「快满」；进度条带 `role="meter"` 与 aria 值 / 名称（中英双语），刻度线为纯装饰。总量未知或为 0 时比例尺是 max(峰值, 当前) × 1.25（显存把均值也算进这个 max），不再画成近满；总量已知时分母就是总量。RAM 在提供了正的总量时同样用总量
- `memory` 对象再增加可选的 `ramSeries` / `vramSeries`：最近最多 60 个采样（字节，旧→新）给 WebUI 迷你折线。不足 2 个点省略；VRAM 从未读到时不写 `vramSeries`。采样器里是定长环形缓冲，不随实例寿命增长。旧 hub 没有这两个字段时，WebUI 用 2 秒实例轮询自己攒
- WebUI：实例卡片标签行右端的 RAM / VRAM 折线；合成按钮下方的实时状态行（生成中写「Streaming from <实例> · <耗时>」，等宽数字跳动；完成后写墙上耗时，音频时长已知时再加 RTF = (durationMs/1000) / result.durationSec，SSE 的 `task.finished` 不带 `durationSec`，完成时补拉一次 `GET /api/tasks/{id}`，仍未知就省略 RTF；失败用错误样式；约 20 秒后清空）；页头 chip 优先显示农场「Farm 在线/总数 · 失败次数」（浏览器只打同域 `GET /api/farm/health`；URL 来自 `AUDIOCPP_HUB_FANOUT_URL`，默认 `http://127.0.0.1:18082/farm/health`，空字符串关闭；超时 1.5s、缓存约 5s、单飞；不可达时 `200 {"available":false}` 并退回本机「Hub 就绪数/总数」，失败次数仍是 `GET /api/stats` 的全量累计）；实例标题行保留「实时事件 / 轮询中」指示灯，并在旁边加合计显存（各实例 `vramBytes` 相加；总量按 GPU 名去重，同一张卡只计一次；没有任何总量时省略「/ 总量」，完全没有显存读数时整段省略）
- 实例正在生成时只保留「生成中…」胶囊（脉冲圆点 + 耗时），藏起绿色 Ready；空闲时反过来。实例卡片和合成区上方的实例条用同一条规则。卡片副标题在原有型号 / 后端 / 端口上补 GPU 名（有 `gpuName` 时），右侧「idle 4m」来自 `idleSinceMs`，没有则退回最近一条任务的 `finishedAt`，生成中隐藏
- 合成按钮下方的实时状态行在生成中带 RTF 预估：「Streaming from <实例> · RTF ~1.1× · 3.2s」。中位数取**同实例**最近 ≤10 条 DONE 任务的 (finishedAt − startedAt) ÷ `result.durationSec`（缺一段时间、非 DONE、别台实例的样本一律跳过，不做离群剔除），一次 `GET /api/tasks` 算完，按实例 id 缓存、约 30s 才重算一次（单飞；拉取失败也记时间，接口一直失败时不会跟着 2s 轮询每拍重试）；这台实例还没有可用历史时整段省略，完成后仍写精确 RTF
- 合成文本框右下角字数（hub 没有最大文本长度常量，只显示「N 字 / N chars」）
- 合成文本框的字数旁边同时显示词数（「142 字 · 24 词」/「142 chars · 24 words」）。词数优先用 `Intl.Segmenter`（`granularity: "word"`，只数 `isWordLike` 的段——拉丁文本按词切、连续汉字按段切），运行环境没有 `Segmenter` 或构造失败时退回按空白切分（中文退化成「整段一个词」，不报错）；纯函数 `countWords` / `formatCharCount` 两侧都有单测
- 实例卡片与详情弹窗的内存条把「这个模型闲着时占多少」画成条上的**空心圆**（`ramIdleBytes` / `vramIdleBytes`；采到第一个空闲样本之前省略，超过比例尺时钳到末端，位置与填充 / 刻度线同走 `data-*` + `applyMemBars` 的 CSSOM 写入）。每张卡片的图例补上 Idle 项，实例列表上方另有一行「内存标记：| 峰值 | 均值 o 空闲」——只在真的画出内存条时出现；条下方统计行仍是「Peak 2,662 · Avg 717 · Idle 598 MiB」
- 就绪实例卡片右端的「idle 6h」变成带时钟图标（Lucide `clock`，已进 `index.html` 雪碧图）的小胶囊，弱化配色，生成中仍整块让位给耗时；内存条填充在值极小但非零时保留 2px 最小可见宽度（11 MiB / 8 GiB 这种 0.1% 不再渲染成 0 像素），真的是 0 时不假装有一小道
- 左栏「模型」区改成可折叠的 `<details>`（与「最近活动」同形状）：summary 上是标题 + 计数徽标 + 箭头，默认**有实例时收起**（清单很长，原来会把「最近活动」面板挤出屏幕）、没有实例时展开，用户手动开合后记在 `localStorage`（`hub-models-open`）；「最近活动」面板移到模型区上方。展开 / 收起只改显隐，下载 / HF 菜单、选中、骨架屏等行为不变
- 首屏性能预算按实测上调：字数词数、内存条空心圆与图例、idle 小胶囊、模型区折叠都在首屏。首屏 JS raw +5.6 KiB（428.5 → 434.1）、CSS raw +3.3 KiB（84.5 → 87.8）、JS+CSS gzip 合计 183.2（实测），子资源请求数不变（37）
- WebUI 合成按钮上方新增「上一条录音」条（概念稿 `.take`）：圆形播放键、「Last take / <实例> · 多久之前」、80 根圆角条的波形、等宽时间「0:03 / 0:07」、下载与「再生成」。tts 任务结束时复用 `renderTaskResult` 里已经在填 `#tts-player.src` 的那个历史 wav URL——播放仍由那个 `<audio>` 元素负责，本模块只为画波形额外 `fetch()` 一次并用 WebAudio 解码（用完就关 AudioContext）；解码失败或浏览器没有 WebAudio 时退化成等高矮条，播放照旧。波形是一棵内联 `<svg viewBox="0 0 80 28" preserveAspectRatio="none">`，80 个 `<rect>` 的几何全是 SVG 属性、填色只靠 `.played` / `.rest` 两个类（CSP `style-src 'self'` 不允许 `style=""`），没有动画，「减少动态效果」偏好下同样只剩一次换色。波形区是 `role="slider"`：点击定位、方向键按总时长的 5% 步进、Home / End 到两端，配 aria 值与等宽时间。相对时间由本模块自己的 30 秒 interval 重画（**不是**生成耗时——那一类文本全站只有 `elapsed.js` 那一个计时器在写），没有录音时不开。刷新页面时从 `GET /api/tasks` 清单里回填最新的那条已完成 tts（不额外发请求，挑不出就保持收起）。「再生成」把文本框改回这条录音的文字后触发合成按钮自己的 handler，不另建请求体
- 首屏性能预算再次按实测上调：「上一条录音」条（`web/modules/last-take.js`）落在首屏、不能改成懒加载 chunk。实测 JS raw 452.2（434.1 → +18.1）、JS gzip 167.0、CSS raw 90.9、CSS gzip 24.4、JS+CSS gzip 合计 191.4、子资源请求数 38（37 → +1 个模块）；上限按同一口径重新钉到 jsRawKiB 453 / jsGzipKiB 168 / cssRawKiB 91 / cssGzipKiB 25 / totalGzipKiB 192（`scripts/perf-budget.mjs`，注释里记了 before → after 表）
- 左栏实例与模型之间的「最近活动」：`<details>` 默认展开，开合记在 `localStorage`（`hub-activity-open`）。按完整时间戳跨天倒序，过滤测试任务之后最多 20 条；今天只显示钟点，昨天和更早带日期。直播走任务 SSE。首屏用 `GET /api/tasks` 播种；SSE 没连上且面板打开时约 5 秒再拉一次。顶部一条最近 1 小时的横条（每 10 分钟一刻度，每个真实实例一条泳道）；这一小时没有真实任务时均匀铺最近 10 条

- `docs/farm.md` / `docs/agent-api.md` / `docs/deployment-10.0.0.36.md`：多机语音农场的拓扑、客户端契约与部署注意事项，入口统一指向 fan-out `http://10.0.0.36:18082`
- Web UI：操作历史支持「复刻」上一条生成参数重新提交、音色库下拉支持按名搜索、用量看板增加近 14 天趋势
- `cmd/fanout-proxy`：多机语音农场的统一 LAN 入口（独立二进制，stdlib only，默认 `:18082`）——轮询各 hub `GET /api/instances`，按模型别名（`breeze`/`expressive`、`qwen3-vd`/`voice-design-fast`、`sanotts`/`instant`、`citrinet`/`stt`）路由 `POST /v1/audio/speech` 并故障转移，暴露 `GET /farm/health`、聚合 `GET /api/instances`、只列可用别名的 `GET /v1/models`；配置 `farm.routes.json`、systemd user unit 模板与表驱动单测。对 hub 零改动（不动预热策略），历史与音色库留在源 hub
- `cmd/fanout-proxy`：每个源实例（hub + 服务名）的**在途请求上限**（`farm.routes.json` 的 `maxInFlightPerTarget`，默认 `2`，`<= 0` 关闭）——hub 每个实例只有一个引擎且任务队列串行，没有上限时一个话痨 agent 会占满队列而其它请求只能 invisible 排队，农场在 `/farm/health` 里看着依然健康；到达上限的目标按「不可用」跳过、请求溢到备用实例，只有整条路由所有可用目标都忙时才返回 `429` + `Retry-After: 5` + `type: rate_limit_error`（与宕机的 `503` 区分开，附 attempts 与 `inFlightCap`）；`GET /farm/health` 增加 `inFlightCap` 与逐目标 `inFlight`
- `cmd/fanout-proxy`：**STT 走 fan-out**（`docs/fanout-design.md` 待办 #1）——`POST /api/tasks` 按与 TTS 同一张别名表路由（`stt` / `citrinet`），并把别名改写成源 hub 的本地 `instanceId`（从既有的 `GET /api/instances` 轮询快照解析，无需新增探针），复用同一套健康缓存、在途上限与故障转移；`request` 原样透传。任务读回（`GET /api/tasks`、`GET /api/tasks/{id}`、`GET /api/tasks/{id}/result`、`DELETE /api/tasks/{id}`）是**按 `?hub=<baseUrl>` 钉住单台 hub** 的透传——任务 id 是 hub 本地的，猜 hub 可能读到别的主机的任务；hub 的状态码与 body 原样回写（它的 `404` 仍是 `404`），只有传输失败才是 `502`，读操作 30 s 上限。故障转移只覆盖**提交**：hub 入队后立即 `202`，任务在接收它的那台引擎上跑完，读操作不再转移（重投是重复劳动而非恢复）。已知边界：`request.audio` 是服务端路径，只存在于源 hub 上（`stt` 目前单主机，暂不会触发）；在途上限对任务只约束提交节奏，执行由 hub 自身串行队列兜底
- `clients/audiocpp_client.py`：`farm_health()` / `models()` 与对应的 `health`、`models` 子命令（读 `GET /farm/health`，即各 hub 存活、延迟与别名落点）；`speech_with_origin()` 额外返回响应头，便于取 `X-Fanout-Hub` 定位该 take 所在的源 hub
- `docs/fanout-design.md`：状态改为已实现，补齐草案遗留的三个待定项；新增 "Fairness — per-origin in-flight cap" 一节，待办 #2 标记为已交付
- `docs/API.md`：指向 fan-out 入口的说明（本文档只覆盖 hub 本体路由）
- 文档：新增 Open WebUI 的 TTS 接线条目（`docs/farm.md` → "Open WebUI TTS wiring"，`docs/agent-api.md` STT 小节互相指路）——TTS Engine = OpenAI、Base URL = `http://10.0.0.36:18082/v1`（**不是** `:18080`，后者只对应 `.36` 单台 hub）、模型填 fan-out 别名、`voice` 字段被 audiocpp 忽略；并明确 OWUI 内置 STT 打不到 `citrinet`（缺 adapter），STT 仍走 `:18080` 的 hub 任务 API

- `docs/API.md`：按 `api.go` 实际注册的路由逐条记录方法 / 路径 / 请求体 / 响应 / 错误码
- `SECURITY.md`：威胁模型、未鉴权可变接口清单与漏洞上报渠道
- `CONTRIBUTING.md`、`CHANGELOG.md`、`CODE_OF_CONDUCT.md` 及 `.github` issue / PR 模板
- `README.md` / `README_EN.md` 增加前置条件、全部配置键、故障排查与截图占位
- 新增移动端 / 平板响应式 e2e（`e2e/responsive.spec.mjs`，headless Chromium + MockBackend，无 Go / GPU / 模型）：360x800 与 390x844、768x1024 三档各钉「无横向溢出 + 页头 7 个操作按钮可见且触摸目标 ≥40px 且在视口内」；抽屉用例钉「汉堡打开后实例 / 最近活动 / 模型三块都在、`overflow-y` 可用且 `max-height` 非 `none`、压矮到 420px 后内容确实在抽屉内滚动、`#drawer-close` 可点且 Esc 能收起、打开抽屉不把页面撑宽」；360x800 另钉合成按钮 sticky 在首屏内、高度 ≥44px、合成文本框高度落在 40–90px；1280x720 与 1920x1080 两档钉「不回归」：无横向溢出、汉堡键与抽屉关闭键不渲染、左栏是常驻列、页头仍是单行 `nowrap`

### Changed

- 首屏性能预算按实测上调（Now / Queue 状态条落在首屏，不是点开才用的视图）：JS raw 452.2 → 471.9 KiB、gzip 167.0 → 175.1、CSS raw 90.9 → 94.3、gzip 24.4 → 25.4、合计 gzip 191.4 → 200.4、子资源 38 → 39。预算相应改为 JS raw 472、gzip 176、CSS raw 95、gzip 26、合计 gzip 201、子资源 39（`scripts/perf-budget.mjs` 的注释里记了完整的 before → after 表）
- `web/modules/activity.js` 的任务行新增 `text` 与 `position` 两个字段（GET /api/tasks 已有的数据，此前本模块没带过来），供 Now/Queue 状态条画摘要与队列位次；活动区本身不读这两个字段，行为不变
- 首屏性能预算再按实测上调：`elapsed.js` 与 `junk.js` 进入首屏模块图（子资源 37，预算 38），共用计时与最近 1 小时横条使 JS raw 412.2 KiB、gzip 151.2、合计 gzip 172.4。预算改为 JS raw 415、gzip 154、合计 gzip 175。CSS 预算不变
- 首屏性能预算按实测上调（JS raw 387.4 KiB、gzip 142.9、CSS raw 79.9、gzip 21.0、合计 gzip 163.9、子资源 35）。最近活动、字数、内存条、状态行和农场 chip 都在首屏，不能拆成懒加载
- 首屏体积优化：「点开才用得上」的六个视图（服务器端文件浏览器、音色库、下载管理、设置、用量看板、Ctrl/Cmd-K 命令面板）改为动态 `import()` 的懒加载 chunk，首屏外观层（角标、按钮、启动弹窗下拉、命令面板和弦）留在首屏模块图内；实测首屏 JS raw 313.5 → 310.2 KiB、gzip 114.4 → 113.6 KiB，预算按同一口径同步收紧
- 客户端与文档入口统一指向农场 fan-out：`clients/audiocpp_client.py` 的 `DEFAULT_HUB` 改为 `http://10.0.0.36:18082`（TTS 与发现走 fan-out），新增 `DEFAULT_DIRECT_HUB`（`http://10.0.0.36:18080`）供 fan-out 不代理的 hub 内接口使用（`/api/tasks` STT、`/api/audio/upload`、`/api/voices`、`/api/history/*`），对应 `--direct-hub` / `AUDIOCPP_DIRECT_HUB_URL`；本地开发仍可两个 URL 同指 `http://127.0.0.1:18080`
- 文档全面改写为 Go 实现：原生单二进制构建、扁平源码布局、`hub.config.json` 不自动生成、根目录 `models.json` 内嵌
- README 修正 `/v1/*` 代理的 `model` 提取为 **JSON-only**：`multipart/form-data`（如 `/v1/audio/transcriptions`）会返回 `400`，并给出变通方案
- 移除文档中不存在于 Go 实现的 HTTPS / 证书相关功能描述

### Fixed

- `web/motion.js` 的自激动画环路：`flash(pill, "state-flip")` 给 `#instance-pill` 加 / 删动画类，而 `watchPill` 的 `MutationObserver` 观察的正是这个 class 属性，于是每次 flash 都被认成又一次状态变化，再触发下一次 flash——CDP profile 实测空闲页面每 8s 约 3.2s CPU 耗在 `flash` 上，主线程被 0.5–1.6 秒地堵住，「生成中… N.Ns」计时徽标因此看起来卡住 / 跳变。改为只比较剥掉动画类并规整空白后的「稳定 class 串」（`last` 也取自剥过的值），只有真正状态翻转才闪一次；同时 flash 不再叠加定时器（同一节点同一类未完成时只重置已有定时器），且仅在类已在节点上时才做「删 → 强制回流 → 加」的重启动画。行为契约由 `test/unit/motion.test.mjs` 钉住（旧实现的突变计数会一直顶到 settle 上限）
- 生成耗时（卡片「生成中…」、工具栏徽标、合成按钮下的状态行）会间歇性停在 0.0s、冻住几秒再跳、或比墙上时钟少一截。根因是两套 `setInterval` 同时写 `.badge-elapsed`：`instances.js` 的 busyTimer 读 DOM 上的 `data-start`，`live-ticker.js` 另有 tickerTimer，用 `watch.startedAt` / SSE `ts` / 收到时间另一套锚。每 2 秒轮询和 SSE 重画会把 `data-start` 换成更晚的锚：SSE 的 `busyStarts` 只记第一次的 ts（空 ts 会挡住轮询的 `startedAt`）；任务一离开 RUNNING（排队阶段，或同实例上的排队兄弟）就删掉 `runningStarts`；状态行每次轮询用 `startedAt || createdAt || Date.now()` 覆盖。更晚的锚再经 `Math.max(0, now-start)` 就显示 0.0s，或少掉中途被拨后的那一段（徽标出现约 2.6s 时读数停在 1.2s）。重画瞬间若匹配不到徽标节点，`syncBusyTimer` 会 `clearInterval`，数字冻住，下一帧再跳。不重画的探针只有一个锚，所以是准的。现改为 `elapsed.js` 一张表：服务端 `startedAt`，否则 SSE ts，否则第一次客户端时间；同一任务只保留更早的锚；服务端时间超前、或 live SSE 与本地钟差超过 2 秒，则改用收到时间；展示时把未来锚钳到 now，不写回。三处显示由同一个 200ms interval 重画，重画后立刻补一帧。任务结束清表。`live-ticker.js` 不再自己 `setInterval`
- 最近活动默认隐藏测试任务（空身份、`nonexistent` / `test model` / `race` / `probe` / `bench` / `dummy` / `tmp`，以及不在当前实例列表且不在模型目录里的任务；目录还没到就跳过这一条）。页脚可「显示测试任务（已隐藏 N 条）」，展开后变淡，记在 `localStorage`（`hub-activity-show-junk`）。判定与用量看板共用 `web/modules/junk.js`
- `GET /api/instances` 的顺序不再随 Go map 迭代抖动：按 `createdAt` 再按 `id`。前端卡片排序是全序（状态、createdAt、名称、id），不看选中态或忙碌态，2 秒轮询不会把选中的卡片在列表头尾之间跳
- 文档：`docs/farm.md` 里 `.36` 主机一行指向不存在的 `HOST-DEPLOYMENT.md`，改为真实路径 `docs/deployment-10.0.0.36.md`
- `clients/audiocpp_client.py`：`voices` / `history` 之前按 `id` 取值，与 hub 实际返回的 `vid`（音色库）和 `taskId`（历史列表）不符，`voices` / `history` 子命令会抛 `KeyError` 或打印 `None`；`history` 默认模型改为真实 modelId `breeze-tts`（此前是服务名 `breeze`，该路径 404）

### Removed

- 历史记录的容量淘汰（改为仅手动删除，历史视为用户资产）
- 发布流程改为 Windows / Linux 原生 zip，不再提供需额外运行环境的通用包

## [0.1.0] - Go 重写

### Changed

- Go 重写版取代旧实现成为主工程；发布改为 Windows / Linux 原生单二进制 zip（`CGO_ENABLED=0`，无需任何运行环境）
- 新增 ModelScope 下载源（`"source":"modelscope"`）
- 新增 `/v1/*` OpenAI 兼容代理（流式落盘转发，大 base64 不进内存）
- 引入异步推理任务队列，任务状态落盘、hub 重启后回放
- 新增内置权重下载器（多线程 Range 分段、断点续传、暂停 / 恢复）

### Fixed

- 历史分组接口空数据序列化为 `null` 导致前端异常
- Windows 下 `audiocpp_server` 子进程弹出黑色控制台窗口
