# Changelog

本文件记录 audio.cpp-hub 的重要变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- `docs/farm.md` / `docs/agent-api.md` / `docs/deployment-10.0.0.36.md`：多机语音农场的拓扑、客户端契约与部署注意事项，入口统一指向 fan-out `http://10.0.0.36:18082`
- Web UI：操作历史支持「复刻」上一条生成参数重新提交、音色库下拉支持按名搜索、用量看板增加近 14 天趋势
- `cmd/fanout-proxy`：多机语音农场的统一 LAN 入口（独立二进制，stdlib only，默认 `:18082`）——轮询各 hub `GET /api/instances`，按模型别名（`breeze`/`expressive`、`qwen3-vd`/`voice-design-fast`、`sanotts`/`instant`、`citrinet`/`stt`）路由 `POST /v1/audio/speech` 并故障转移，暴露 `GET /farm/health`、聚合 `GET /api/instances`、只列可用别名的 `GET /v1/models`；配置 `farm.routes.json`、systemd user unit 模板与表驱动单测。对 hub 零改动（不动预热策略），历史与音色库留在源 hub
- `cmd/fanout-proxy`：每个源实例（hub + 服务名）的**在途请求上限**（`farm.routes.json` 的 `maxInFlightPerTarget`，默认 `2`，`<= 0` 关闭）——hub 每个实例只有一个引擎且任务队列串行，没有上限时一个话痨 agent 会占满队列而其它请求只能 invisible 排队，农场在 `/farm/health` 里看着依然健康；到达上限的目标按「不可用」跳过、请求溢到备用实例，只有整条路由所有可用目标都忙时才返回 `429` + `Retry-After: 5` + `type: rate_limit_error`（与宕机的 `503` 区分开，附 attempts 与 `inFlightCap`）；`GET /farm/health` 增加 `inFlightCap` 与逐目标 `inFlight`
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
