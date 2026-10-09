# Changelog

本文件记录 audio.cpp-hub 的重要变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- Web UI 页头按钮改用内嵌 Lucide 图标雪碧图（`menu`、`mic-vocal`、`history`、`download`、`chart-column`、`languages`、`settings`，主题为 `sun` / `moon` / `monitor`，面板关闭为 `x`）。路径数据来自 lucide-static，许可证全文在 `third_party/lucide/LICENSE`（ISC，部分图标源自 Feather / MIT）
- 每个运行中的实例采样 RSS，并尽力读取 VRAM（Linux DRM fdinfo，否则 `nvidia-smi`，失败则退避）。`GET /api/instances` 在第一次采样后带上可选的 `memory`（当前 / 峰值 / 时间加权平均）；任务结束时把 RUNNING 期间的峰值写成 `peakRamBytes` / `peakVramBytes`。非 Linux 省略 `memory`
- `GET /api/events/stream`：任务生命周期的 Server-Sent Events（连接时 `hello`，约 15 秒一条 `: ping`，以及 `task.queued` / `task.started` / `task.finished` / `task.failed` / `task.cancelled`）。Web UI 在对应实例上显示「生成中…」，推送不可用时仍靠原来的 2 秒轮询。fan-out 不代理这条流
- `memory` 对象新增三个可选字段：`ramIdleBytes` / `vramIdleBytes`（实例没有 RUNNING 任务期间观察到的**空闲基线**，即「这个模型闲着时占多少」，采到第一个空闲样本之前省略）与 `vramTotalBytes`（该进程所在 GPU 的显存总量，前端显存条的比例尺）。总量是尽力而为且绝不猜：nvidia 用 `nvidia-smi --query-gpu=index,memory.total`（每个 hub 生命周期只查一次，与既有进程查询共用超时与失败退避，不增加每轮采样开销），AMD 用 `/sys/class/drm/card*/device/mem_info_vram_total`（同样只读一次）；统计不出「只有一张卡」就省略该字段
- 实例卡片与实例状态条原来并排的两个忙碌徽标（轮询的「工作中」与 SSE 的「生成中…」）合并成一个「生成中…」：脉冲圆点 + 300ms 一跳的耗时计时（全部卡片共用一个定时器，没有忙碌任务时停掉）。忙碌判定由 SSE（`task.started` … 终态）与轮询（`taskCount` / 采样器 `busy` / 任务轮询的 `startedAt`）合并成一个纯函数，推送断开时自动回退到轮询
- 实例卡片与实例详情弹窗把 RAM / VRAM 的两行文字换成进度条：填充为当前值，细刻度线标峰值与均值，下方一行「Peak · Avg · Idle」（单位在行尾出现一次，≥ 1024 MiB 统一换算成 GiB）。显存条在有 GPU 总量时按总量取比例尺，占用 ≥ 85% 时用渐变提示「快满」；进度条带 `role="meter"` 与 aria 值 / 名称（中英双语），刻度线为纯装饰

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

### Changed

- 首屏体积优化：「点开才用得上」的六个视图（服务器端文件浏览器、音色库、下载管理、设置、用量看板、Ctrl/Cmd-K 命令面板）改为动态 `import()` 的懒加载 chunk，首屏外观层（角标、按钮、启动弹窗下拉、命令面板和弦）留在首屏模块图内；实测首屏 JS raw 313.5 → 310.2 KiB、gzip 114.4 → 113.6 KiB，预算按同一口径同步收紧
- 客户端与文档入口统一指向农场 fan-out：`clients/audiocpp_client.py` 的 `DEFAULT_HUB` 改为 `http://10.0.0.36:18082`（TTS 与发现走 fan-out），新增 `DEFAULT_DIRECT_HUB`（`http://10.0.0.36:18080`）供 fan-out 不代理的 hub 内接口使用（`/api/tasks` STT、`/api/audio/upload`、`/api/voices`、`/api/history/*`），对应 `--direct-hub` / `AUDIOCPP_DIRECT_HUB_URL`；本地开发仍可两个 URL 同指 `http://127.0.0.1:18080`
- 文档全面改写为 Go 实现：原生单二进制构建、扁平源码布局、`hub.config.json` 不自动生成、根目录 `models.json` 内嵌
- README 修正 `/v1/*` 代理的 `model` 提取为 **JSON-only**：`multipart/form-data`（如 `/v1/audio/transcriptions`）会返回 `400`，并给出变通方案
- 移除文档中不存在于 Go 实现的 HTTPS / 证书相关功能描述

### Fixed

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
