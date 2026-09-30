# Changelog

本文件记录 audio.cpp-hub 的重要变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- `cmd/fanout-proxy`：多机语音农场的统一 LAN 入口（独立二进制，stdlib only，默认 `:18082`）——轮询各 hub `GET /api/instances`，按模型别名（`breeze`/`expressive`、`qwen3-vd`/`voice-design-fast`、`sanotts`/`instant`、`citrinet`/`stt`）路由 `POST /v1/audio/speech` 并故障转移，暴露 `GET /farm/health`、聚合 `GET /api/instances`、只列可用别名的 `GET /v1/models`；配置 `farm.routes.json`、systemd user unit 模板与表驱动单测。对 hub 零改动（不动预热策略），历史与音色库留在源 hub
- `clients/audiocpp_client.py`：`farm_health()` / `models()` 与对应的 `health`、`models` 子命令（读 `GET /farm/health`，即各 hub 存活、延迟与别名落点）；`speech_with_origin()` 额外返回响应头，便于取 `X-Fanout-Hub` 定位该 take 所在的源 hub
- `docs/fanout-design.md`：状态改为已实现，补齐草案遗留的三个待定项
- `docs/API.md`：指向 fan-out 入口的说明（本文档只覆盖 hub 本体路由）

- `docs/API.md`：按 `api.go` 实际注册的路由逐条记录方法 / 路径 / 请求体 / 响应 / 错误码
- `SECURITY.md`：威胁模型、未鉴权可变接口清单与漏洞上报渠道
- `CONTRIBUTING.md`、`CHANGELOG.md`、`CODE_OF_CONDUCT.md` 及 `.github` issue / PR 模板
- `README.md` / `README_EN.md` 增加前置条件、全部配置键、故障排查与截图占位

### Changed

- 客户端与文档入口统一指向农场 fan-out：`clients/audiocpp_client.py` 的 `DEFAULT_HUB` 改为 `http://10.0.0.36:18082`（TTS 与发现走 fan-out），新增 `DEFAULT_DIRECT_HUB`（`http://10.0.0.36:18080`）供 fan-out 不代理的 hub 内接口使用（`/api/tasks` STT、`/api/audio/upload`、`/api/voices`、`/api/history/*`），对应 `--direct-hub` / `AUDIOCPP_DIRECT_HUB_URL`；本地开发仍可两个 URL 同指 `http://127.0.0.1:18080`
- 文档全面改写为 Go 实现：原生单二进制构建、扁平源码布局、`hub.config.json` 不自动生成、根目录 `models.json` 内嵌
- README 修正 `/v1/*` 代理的 `model` 提取为 **JSON-only**：`multipart/form-data`（如 `/v1/audio/transcriptions`）会返回 `400`，并给出变通方案
- 移除文档中不存在于 Go 实现的 HTTPS / 证书相关功能描述

### Fixed

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
