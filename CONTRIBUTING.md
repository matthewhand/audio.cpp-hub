# 贡献指南

感谢你愿意为 audio.cpp-hub 做贡献！本文说明本地构建、代码约定与提交 PR 的流程。

## 开发环境

- **Go 1.27+**（与 `go.mod`、CI 一致）
- 可选：一个可运行的 `audiocpp_server`（用于端到端手动验证），从 [audio.cpp Releases](https://github.com/0xShug0/audio.cpp/releases/latest) 获取
- 仓库没有第三方构建工具：依赖仅 `github.com/getlantern/systray` 与 `golang.org/x/sys`

## 构建与运行

```bash
go build -o audio.cpp-hub .
./audio.cpp-hub
```

工作目录需包含 `web/`；`models.json` / `model-packages.json` 已通过 `go:embed` 嵌入，无需手动复制。默认监听 `http://localhost:8080`（可通过工作目录下的 `hub.config.json` 覆盖，见 [`docs/API.md`](docs/API.md) 与 README 配置章节）。

交叉编译：

```bash
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags "-H windowsgui -s -w -X main.version=dev" -o audio.cpp-hub.exe .
CGO_ENABLED=0 GOOS=linux   GOARCH=amd64 go build -ldflags "-s -w -X main.version=dev" -o audio.cpp-hub .
```

## 提交前检查

本项目**目前没有自动化测试**。提交前请至少执行：

```bash
gofmt -l <你改动的文件>   # 应无输出（仓库存在少量历史文件未 gofmt，请勿顺手大改无关文件）
go vet ./...             # 应无告警
go build ./...           # 应通过
```

并做手动验证：启动 hub，打开 Web UI，确认改动涉及的页面 / 接口行为正常（例如新增接口用 `curl` 打一次，含成功与错误路径）。

若你新增了自动化测试，请在 PR 中说明运行方式。

## 代码约定

- **语言**：代码注释、日志消息、用户可见错误消息使用中文；标识符、API 字段、配置键使用英文
- **前端文案**：所有用户可见字符串必须同时提供中文与英文，写入 `web/i18n.js`，不要在 `web/*.js` 中硬编码文案
- 遵循 `gofmt` 的格式（tab 缩进）
- 新增接收路径 / 文件名的接口，必须沿用现有的安全校验（正则白名单 + 逐段拒绝 `..` / 绝对路径 / 盘符），防止路径穿越
- ID 统一用 `newID()`（8 位随机十六进制）
- 用户可预期错误使用 `UserError{Code, Params, Msg}`，API 层经 `errJSON` / `errFromErr` 输出
- 持久化直接读写 JSON 文件（原子写用 `writeFileAtomic`），不引入数据库

## 提交 PR

1. 从 `feat/go-magpie-tts`（或维护者指定的当前开发分支）拉出分支
2. 保持改动聚焦；文档改动与代码改动尽量分开
3. 按 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md) 填写说明：**摘要、变更、验证方式、风险**
4. 推送分支并创建 PR 到主仓库 <https://github.com/matthewhand/audio.cpp-hub>
5. 不要提交运行时目录 / 本地配置（`data/`、`run/`、`models/`、`logs/`、`ssl/` 等已被 `.gitignore` 排除）；不要提交真实 token 或密钥

## 文档贡献

文档同样是代码：命令、端点、配置键必须与当前 Go 实现一致。修改行为时请同步更新 `README.md`、`README_EN.md` 与 `docs/API.md`（中英保持对等）。`model_download_urls.md` 仅为上游权重来源参考，如与内置 `model-packages.json` 冲突，以代码为准。

## 许可

提交即表示你同意按本仓库的许可条款发布你的贡献。
