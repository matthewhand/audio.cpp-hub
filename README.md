# audio.cpp-hub

**简体中文 | [English](README_EN.md)**

[audio.cpp](https://github.com/0xShug0/audio.cpp) 的 Web 管理面板：一个用 Go 写的轻量 HTTP 服务，负责拉起 / 停止 / 监控多个 `audiocpp_server` 模型实例子进程，并提供中文为主的 Web UI 进行 TTS / ASR / 音乐分离等音频任务。

仓库地址：<https://github.com/matthewhand/audio.cpp-hub>

- **原生单二进制**：编译产物不依赖任何运行环境（Go 静态编译，发布包内含 Windows / Linux 可执行文件）
- **hub 自身很轻量**：不加载模型权重，模型由独立的 `audiocpp_server` 子进程承载

## 功能特性

- **多实例管理**：为每个模型实例生成 `server.json` 并以子进程拉起 `audiocpp_server`，自动分配端口（绑定 127.0.0.1）、轮询健康状态（最多 120s）、查看日志、一键停止
- **Web UI**：纯原生 HTML/JS 界面（无构建步骤），中英双语，支持模型选择、参数表单、任务提交
- **异步任务队列**：`POST /api/tasks` 创建后立即返回，按实例单线程串行执行；任务状态落盘，刷新 / 重启 hub 后自动回放，结果可稍后取回
- **TTS 操作历史**：按模型隔离保存合成记录与结果音频（不自动淘汰，仅手动删除），历史面板可回听、分组、行内展开四要素
- **音色库（参考音频）**：全局资源，`data/voices/` 下集中管理，名称唯一，支持改名 / 改参考文本 / 试听
- **OpenAI 兼容代理**：`GET /v1/models` 聚合全部就绪实例；`POST|PUT /v1/*`（如 `/v1/audio/speech`）按请求体顶层 `model` 路由到同名实例，大 base64 全程流式落盘转发（兼容边界见下文「OpenAI 接口兼容性」）
- **内置权重下载器**：`POST /api/downloads` 多线程 Range 分段下载 HuggingFace（或 modelscope 镜像）权重，支持断点续传、暂停 / 恢复、进度与速率统计
- **设备探测**：启动弹窗可运行 `audiocpp_server --list-devices`，把可用设备渲染成下拉选单
- **Windows 友好**：系统托盘、开机自启、无控制台窗口启动子进程

## 快速开始

### 前置条件

- 从源码构建：**Go 1.27+**（`go.mod` 声明 `go 1.27`；CI 使用 Go 1.27）
- 运行 `audiocpp_server` 二进制：发布包**不包含**它，请从 [audio.cpp Releases](https://github.com/0xShug0/audio.cpp/releases/latest) 下载对应平台 / GPU 版本，放入任意目录（如 `audiocpp/`），启动后在 Web UI 中登记为可执行文件
- 硬件：按所下载的 `audiocpp_server` 构建而定。仓库随附的 `executables.json` 样例是 **Windows + AMD ROCm** 配置（`--list-devices` 可查看实际可用后端）；CPU 亦可运行小模型，但速度取决于模型与线程数
- 磁盘：模型权重体积从数百 MB 到数十 GB 不等，请预留充足空间（下载前 hub 会做磁盘空间预检）

### 使用发布包（推荐）

从 [Releases](https://github.com/matthewhand/audio.cpp-hub/releases) 下载对应平台的原生 zip（`-windows` / `-linux`），解压即用，**无需安装任何运行环境**：

```bash
# Linux
unzip audio.cpp-hub-<version>-linux.zip
cd audio.cpp-hub-<version>-linux
./audio.cpp-hub
```

Windows 双击 `audio.cpp-hub.exe` 即可（无控制台窗口，进入系统托盘）。启动后访问 `http://localhost:8080`（端口见 `hub.config.json` 的 `httpPort`；发布包默认 8080）。

### 从源码构建

```bash
git clone https://github.com/matthewhand/audio.cpp-hub.git
cd audio.cpp-hub
go build -ldflags "-X main.version=<tag>" -o audio.cpp-hub .
./audio.cpp-hub
```

工作目录需包含 `web/`（静态页面）与 `models.json` / `model-packages.json`（已通过 `go:embed` 嵌入二进制，无需单独复制）。启动后访问 `http://localhost:8080`。

交叉编译（本机非 Windows 时）：

```bash
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags "-H windowsgui -s -w -X main.version=<tag>" -o audio.cpp-hub.exe .
CGO_ENABLED=0 GOOS=linux   GOARCH=amd64 go build -ldflags "-s -w -X main.version=<tag>" -o audio.cpp-hub .
```

## 基本用法

1. **登记可执行文件**：在 UI 右上角设置中添加 `audiocpp_server` 的路径（每个条目可配置 `env` 环境变量，值支持 `${VAR}` 占位符）
2. **创建启动配置**：选择模型与参数，权重路径可通过内置文件浏览器选择；底部「高级参数」按每行 `key=value` 填写
3. **启动实例**：hub 写入 `run/<id>/server.json` 并拉起子进程，健康检查通过后状态变为 `READY`
4. **提交任务**：在 Web UI 直接推理，或通过异步任务接口 / OpenAI 兼容接口调用（`model` 填实例服务名 `instanceName`）

## OpenAI 接口兼容性

hub 的 `/v1/*` 接口是对各 `audiocpp_server` 实例的**透明代理**：hub 不修改请求体，兼容边界由上游 `audiocpp_server` 与具体模型决定。

- 支持的请求形状（`GET /v1/models` 列出全部 `READY` 实例的服务名）：
  - `POST /v1/audio/speech`（`model` / `input` / `voice` / `response_format`）
  - 其它 `POST|PUT /v1/<任意路径>`，路径与请求体原样转发到实例同名接口
- **`model` 提取仅支持 JSON**：hub 会流式扫描请求体顶层 `"model"` 字符串。`multipart/form-data`（例如 `POST /v1/audio/transcriptions` 的 multipart 上传）无法提取 `model`，会返回 `400 {"error":{"message":"Missing required parameter: model","type":...}}`。
  - 变通方案：ASR 请走 Web UI 的 ASR 流程，或使用 JSON body 调用实例原生的任务接口 / `POST /api/tasks`。
- 路由结果：`READY` 才转发；实例仍在启动中返回 `409`，服务名不存在返回 `404`；请求体超过 `proxyMaxBodyBytes` 返回 `413`。
- 上游无整体超时（TTS 可能耗时很久），客户端断开即取消转发。
- **不保证完全兼容标准 OpenAI 接口，根因通常在模型侧**：audio.cpp 聚合了多个模型家族，不同模型要求 / 接受的参数并不相同，同一个请求在 A 模型上可用、在 B 模型上可能直接报错。例如：
  - 声音克隆模型（IndexTTS2、Qwen3-TTS Base 等）没有内置音色，纯 `model` + `input` 的请求会失败，必须额外提供 `voice_ref` 参考音频；
  - Qwen3-TTS CustomVoice 用 `voice` 填内置说话人名，VoiceDesign 变体则用 `instructions` 以自然语言描述音色；
  - 部分 OpenAI 标准参数上游并不支持、会被静默忽略，如 speech 的 `speed`、`modalities`；
  - 个别模型会严格校验未知选项，传入其不认识的参数可能导致整个请求被拒绝。
- `models.json` 中的 `inputs` / `paramSchema` 声明（Web UI 参数表单据此渲染）给出了每个模型各自的必需输入。参数不生效或请求报错时，请先对照该模型的参数文档（audio.cpp 仓库的 `docs/models/`），这通常不是 hub 转发的问题。

## 配置

`hub.config.json` **可选，且不会由 hub 自动生成**：文件存在则读取，不存在或解析失败则使用内置默认值。

```json
{
  "httpPort": 8080,
  "instancePortBase": 18090,
  "modelsDir": "models",
  "hfEndpoint": "https://huggingface.co",
  "downloadThreads": 8,
  "downloadSegmentsPerFile": 4,
  "proxyMaxBodyBytes": 1073741824
}
```

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `httpPort` | `8080` | hub 监听端口 |
| `instancePortBase` | `18090` | 模型实例端口分配起点（绑定 127.0.0.1） |
| `modelsDir` | `"models"` | 权重下载落盘根目录（相对工作目录） |
| `hfEndpoint` | `"https://huggingface.co"` | 默认下载源；不可直连时可改镜像，如 `https://hf-mirror.com` |
| `downloadThreads` | `8` | 下载任务全局并发线程数 |
| `downloadSegmentsPerFile` | `4` | 单文件分段数（分段最小粒度 32MB） |
| `proxyMaxBodyBytes` | `1073741824`（1 GiB） | `/v1/*` 代理请求体落盘上限 |

> 本仓库开发副本的 `hub.config.json` 把 `httpPort` 设为 `18080`，因此从源码直接运行时会监听 18080。

## API 概览

完整接口清单（方法 / 路径 / 请求体 / 响应 / 错误码）见 [`docs/API.md`](docs/API.md)。常用入口：

| 接口 | 说明 |
| --- | --- |
| `GET /api/models` | 支持的模型清单（内嵌 `models.json`） |
| `POST /api/instances` | 启动模型实例 |
| `POST /api/tasks` | 创建异步推理任务（202 立即返回） |
| `GET /api/tasks/<id>/result` | 取非 TTS 任务结果 |
| `POST /api/run/<instanceId>` | 兼容旧链路的同步转发（TTS 结果自动入历史） |
| `/api/history/<modelId>...` | TTS 操作历史查询 / 音频回取 / 分组 / 删除 |
| `/api/voices...` | 音色库管理 |
| `/api/downloads...` | 权重下载任务（列表 / 暂停 / 续传 / 删除） |
| `GET /api/executables/<id>/devices` | 运行 `--list-devices` 探测设备 |
| `/api/fs/*` | 服务器本地文件浏览（用于选择权重路径） |
| `GET /v1/models`、`POST|PUT /v1/*` | OpenAI 兼容代理 |

## 目录说明

```text
main.go / api.go        # 入口；/api/* 路由与处理器
proxy.go                # /v1/* OpenAI 兼容代理
instance.go             # 实例子进程生命周期、健康轮询、设备探测
registry.go             # executables.json / data/profiles.json
task.go                 # 异步推理任务队列（串行排队、状态落盘）
history.go              # TTS 操作历史（index.jsonl + 结果音频 + 参考快照）
voices.go / audio.go    # 音色库；WAV 上传与头解析
download.go / packages.go # 权重下载器；model-packages.json 清单
fs.go / models.go / util.go # 文件浏览；模型清单；通用工具
web/                    # 前端静态文件（无构建步骤）
models.json             # 模型清单（go:embed 嵌入二进制）
model-packages.json     # 下载包清单（go:embed 嵌入二进制）
run/                    # 运行时：实例 server.json / server.log / 代理缓存
data/                   # 运行时：uploads、voices、profiles.json、history、downloads、tasks
models/                 # 运行时：下载的模型权重（modelsDir）
logs/                   # 运行时：Windows GUI 模式下的 logs/hub.log
```

## 截图

> 待补充：欢迎通过 PR 添加模型列表、TTS 表单、操作历史、下载管理面板的截图 / 录屏（建议放入 `docs/images/` 后在此嵌入）。

## 安全说明

> **本项目是局域网 / 本机工具，无鉴权，不具备公网防护能力。**
>
> 不要把端口直接暴露到公网。需要远程访问时，请自行在前面加反向代理 + HTTPS + 鉴权。

**所有写操作均无鉴权**，常见可变接口包括：

| 方法 | 路径 | 影响 |
| --- | --- | --- |
| `POST` | `/api/instances`、`DELETE /api/instances/{id}` | 启动 / 停止模型子进程 |
| `POST` / `PUT` / `DELETE` | `/api/executables*`、`/api/profiles*` | 增加 / 修改 / 删除可执行文件与启动配置 |
| `POST` | `/api/run/{id}`、`/api/tasks` | 触发推理任务 |
| `DELETE` | `/api/tasks/{id}`、`/api/history/*` | 取消任务 / 删除历史记录与音频 |
| `POST` | `/api/audio/upload`、`/api/voices*` | 上传音频、增删改音色库 |
| `POST` | `/api/fs/mkdir` | **在服务器任意可写路径新建文件夹** |
| `POST` / `DELETE` | `/api/downloads*` | 下载权重（写 `models/`）、删除任务 |

`/api/fs/*` 接口有意暴露服务器本地文件系统浏览与创建目录，这是设计使然（hub 本就是本机单用户工具）。安全策略与漏洞上报渠道见 [`SECURITY.md`](SECURITY.md)。

## 开发与贡献

构建、代码风格与提交前检查见 [`CONTRIBUTING.md`](CONTRIBUTING.md)；变更记录见 [`CHANGELOG.md`](CHANGELOG.md)。

## 技术栈与来源

- Go 1.27，原生单二进制；依赖仅 `github.com/getlantern/systray`（Windows 托盘）与 `golang.org/x/sys`
- 前端：原生 HTML/CSS/JS，中英双语文案在 `web/i18n.js`
- 本项目是 [audio.cpp](https://github.com/0xShug0/audio.cpp) 的配套管理面板（fork 维护版：<https://github.com/matthewhand/audio.cpp-hub>）；不捆绑上游二进制，模型与推理能力来自上游项目
