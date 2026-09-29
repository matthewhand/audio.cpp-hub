# 安全策略

## 报告漏洞

请**不要**通过公开 issue 报告安全问题。请使用 GitHub 的私密漏洞报告：

- <https://github.com/matthewhand/audio.cpp-hub/security/advisories/new>

报告中请尽量包含：受影响版本、复现步骤、影响范围与（如适用）修复建议。我们会尽快确认并回复，修复发布后会在 advisory / Release Notes 中致谢（除非你希望匿名）。

## 支持范围

本项目为个人 / 社区维护的本地工具，**仅对最新发布版本提供安全修复**，不为历史版本回补。请先升级到 [最新 Release](https://github.com/matthewhand/audio.cpp-hub/releases) 再确认问题是否仍然存在。

## 威胁模型

audio.cpp-hub 的设计目标是**本机 / 局域网单用户**场景：

- **无鉴权**：所有 API 都无需任何凭证
- **无 TLS**：hub 自身不提供 HTTPS；如需加密传输，请在前面加反向代理（并同时配置鉴权）
- **无 CSRF 防护 / 无来源校验**：任何能访问端口的客户端都可以调用任意接口
- **默认绑定所有网卡**（`httpPort`），实例子进程绑定 `127.0.0.1`

因此，**绝对不要将端口直接暴露到公网**。在受信网络之外使用时，必须自行加反向代理 + HTTPS + 鉴权（如 mTLS、Basic Auth、OAuth 网关等）。

多机部署时可选的 `cmd/fanout-proxy`（默认 `:18082`）同样是**无鉴权、无 TLS 的 LAN 工具**：能访问该端口的客户端可以向农场内任意 hub 发起 TTS 请求（消耗其 GPU / CPU），并读取各 hub 的实例拓扑。它不暴露任何管理型接口，但同样不能转发到公网。

### 未鉴权的可变接口（示例，非穷举）

| 方法 | 路径 | 影响 |
| --- | --- | --- |
| `POST` | `/api/instances` | 启动模型子进程（消耗 CPU/GPU/内存） |
| `DELETE` | `/api/instances/{id}` | 停止实例 |
| `POST` / `PUT` / `DELETE` | `/api/executables*` | 登记 / 篡改可执行文件路径（可指向任意程序） |
| `POST` / `PUT` / `DELETE` | `/api/profiles*` | 修改启动配置 |
| `POST` | `/api/run/{id}`、`/api/tasks` | 触发推理任务 |
| `DELETE` | `/api/tasks/{id}`、`/api/history/*` | 取消任务；删除历史记录与音频 |
| `POST` / `DELETE` | `/api/audio/upload`、`/api/voices*` | 上传音频；增删改音色库 |
| `POST` | `/api/fs/mkdir` | **在服务器任意可写路径新建文件夹** |
| `GET` | `/api/fs/roots`、`/api/fs/list`、`/api/fs/stat` | 浏览服务器本地文件系统 |
| `POST` / `DELETE` | `/api/downloads*` | 下载任意清单内权重到 `models/`；删除任务 |
| `POST` / `PUT` | `/v1/*` | 通过 OpenAI 兼容代理向实例发起请求 |

### 有意为之的设计

- `/api/fs/*` 暴露本地文件系统浏览与创建目录，是「选择模型权重路径」功能的必要部分，属于设计而非漏洞；但其写能力（`POST /api/fs/mkdir`）意味着任何能访问 hub 的人都可在服务器可写路径建目录。
- `/api/executables*` 接受任意可执行文件路径，这是为了支持用户自定义 `audiocpp_server` 位置；结合子进程启动意味着**能访问 hub 即等同于可在该机器上执行该用户权限下的任意程序**。

### 数据与密钥

- 下载 gated 模型时传入的 HuggingFace `token` 会以**明文**保存在 `data/downloads/<id>/task.json`（API 输出会剔除该字段）。请确保运行目录的文件权限得当。
- `data/`、`models/`、`run/` 等运行时目录可能包含用户音频、参考音频与模型权重，升级 / 备份时请注意其中可能含有敏感内容。

## 加固建议

- 仅在 `127.0.0.1` 上监听（通过反向代理转发），不要把端口映射到公网
- 使用反向代理时同时启用 HTTPS 和鉴权，并对 `/api/fs/*`、`/api/executables*` 做额外访问控制
- 以最小权限的系统用户运行 hub，限制其可写目录
- 定期备份并按需清理 `data/` 目录
