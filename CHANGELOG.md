# Changelog

本文件记录 audio.cpp-hub 的重要变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- `docs/API.md`：按 `api.go` 实际注册的路由逐条记录方法 / 路径 / 请求体 / 响应 / 错误码
- `SECURITY.md`：威胁模型、未鉴权可变接口清单与漏洞上报渠道
- `CONTRIBUTING.md`、`CHANGELOG.md`、`CODE_OF_CONDUCT.md` 及 `.github` issue / PR 模板
- `README.md` / `README_EN.md` 增加前置条件、全部配置键、故障排查与截图占位

### Changed

- 文档全面改写为 Go 实现：原生单二进制构建、扁平源码布局、`hub.config.json` 不自动生成、根目录 `models.json` 内嵌
- README 修正 `/v1/*` 代理的 `model` 提取为 **JSON-only**：`multipart/form-data`（如 `/v1/audio/transcriptions`）会返回 `400`，并给出变通方案
- 移除文档中不存在于 Go 实现的 HTTPS / 证书相关功能描述

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
