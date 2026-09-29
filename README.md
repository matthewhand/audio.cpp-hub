# audio.cpp-hub

**简体中文 | [English](README_EN.md)**

[audio.cpp](https://github.com/0xShug0/audio.cpp) 的 Web 管理面板：一个用 Go 写的轻量 HTTP 服务，负责拉起 / 停止 / 监控多个 `audiocpp_server` 模型实例子进程，并提供中文为主的 Web UI 进行 TTS / ASR / 音乐分离等音频任务。

仓库地址：<https://github.com/matthewhand/audio.cpp-hub>

- **原生单二进制**：编译产物不依赖任何运行环境（Go 静态编译，发布包内含 Windows / Linux 可执行文件）
- **hub 自身很轻量**：不加载模型权重，模型由独立的 `audiocpp_server` 子进程承载

## 演示

以下片段均从运行中的 Web UI 实拍（Playwright 录屏 + ffmpeg 转码），非设计稿。
短视频用 `<video>`（WebM + 海报帧，首屏不整段加载），较老的 GIF 直接内联。

**总览：模型列表与就绪实例** — 左侧是可启动的模型清单与实例卡片（此处 BreezeTTS 实例状态为 READY），选中模型后右侧进入对应工作台。

![hub-overview](docs/assets/hub-overview.gif)

**语音合成（TTS）** — 在表单输入文本、一键合成，结果音频直接在页面播放 / 下载（异步队列，可连续排队）。

![hub-tts](docs/assets/hub-tts.gif)

**启动实例** — 填写权重路径与设备、启动模型，等待健康检查通过后变为「就绪」。

<video src="docs/media/instance-start.webm" poster="docs/media/instance-start.poster.png" width="640" controls preload="none" loop muted playsinline></video>

**操作历史** — 页头 🕘 打开操作历史，行内展开记录详情，参考音频与结果音频可回听。

<video src="docs/media/history.webm" poster="docs/media/history.poster.png" width="640" controls preload="none" loop muted playsinline></video>

**下载管理** — 页头 ⬇️ 打开下载管理，查看权重下载进度，可暂停 / 续传 / 一键填入启动表单。

<video src="docs/media/downloads.webm" poster="docs/media/downloads.poster.png" width="640" controls preload="none" loop muted playsinline></video>

**主题切换** — 跟随系统 / 浅色 / 深色三态，首屏无闪烁（见 `web/boot.js`）。

<video src="docs/media/theme-switch.webm" poster="docs/media/theme-switch.poster.png" width="640" controls preload="none" loop muted playsinline></video>

> 素材由 `scripts/record-demos.cjs` 从**真实运行的 hub** 录制，场景清单与重录方式见
> [`docs/media/README.md`](docs/media/README.md)。

## 架构图

架构、部署、时序、数据与运维图示（可编辑 HTML 源 + 明暗 PNG 预览）：[`docs/diagrams/`](docs/diagrams/README.md)。

![整体架构](docs/diagrams/assets/hero-overview.png)

## 功能特性

- **多实例管理**：为每个模型实例生成 `server.json` 并以子进程拉起 `audiocpp_server`，自动分配端口（绑定 127.0.0.1）、轮询健康状态（最多 120s）、查看日志、一键停止
- **Web UI**：纯原生 HTML/JS 界面（无构建步骤），中英双语，支持模型选择、参数表单、任务提交
- **界面能力**：hash 路由与深链接（`#/model/<id>`、`#/history` 等，前进 / 后退可还原）、`Ctrl/Cmd-K` 命令面板、深浅色与跟随系统主题、列表骨架 / 空态 / 错误态统一、键盘可达与 WCAG AA 对比度（动效遵循 `prefers-reduced-motion`）
- **可安装 / 离线**：`manifest.webmanifest` + Service Worker，导航 network-first、静态资源 cache-first；`/api/*` 与 `/v1/*` 绝不缓存，断网有兜底页，注册失败静默降级
- **异步任务队列**：`POST /api/tasks` 创建后立即返回，按实例单线程串行执行；任务状态落盘，刷新 / 重启 hub 后自动回放，结果可稍后取回
- **TTS 操作历史**：按模型隔离保存合成记录与结果音频（不自动淘汰，仅手动删除），历史面板可回听、分组、行内展开四要素
- **音色库（参考音频）**：全局资源，`data/voices/` 下集中管理，名称唯一，支持改名 / 改参考文本 / 试听
- **OpenAI 兼容代理**：`GET /v1/models` 聚合全部就绪实例；`POST|PUT /v1/*`（如 `/v1/audio/speech`）按请求体顶层 `model` 路由到同名实例，大 base64 全程流式落盘转发（兼容边界见下文「OpenAI 接口兼容性」）
- **内置权重下载器**：`POST /api/downloads` 多线程 Range 分段下载 HuggingFace（或 modelscope 镜像）权重，支持断点续传、暂停 / 恢复、进度与速率统计；可下载包以 `model-packages.json` 为准，手动下载来源参考见 [`model_download_urls.md`](model_download_urls.md)
- **设备探测**：启动弹窗可运行 `audiocpp_server --list-devices`，把可用设备渲染成下拉选单
- **Windows 友好**：系统托盘、开机自启、无控制台窗口启动子进程

## 快速开始

### 前置条件

- 从源码构建：**Go 1.27+**（`go.mod` 声明 `go 1.27`；CI 使用 Go 1.27）
- 支持的系统：发布包提供 **Windows（amd64）、Linux（amd64 / arm64）、macOS（arm64）**；hub 是静态单二进制，系统托盘仅在 Windows 生效
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

## 故障排查 / FAQ

**hub 启动即退出，提示端口被占用**
hub 启动时会先 `net.Listen` 绑定端口，失败即打印 `监听 :8080 失败: ...` 并退出（`main.go`）。改 `hub.config.json` 的 `httpPort`，或停掉占用该端口的进程后重启。实例端口从 `instancePortBase` 起自动寻找空闲端口；若在启动表单里显式指定端口，端口被占用会返回 `INSTANCE_PORT_IN_USE`，指定 hub 自身端口会返回 `INSTANCE_PORT_RESERVED`。

**实例一直 `STARTING`，最后超时失败**
hub 每秒轮询实例的 `GET /health`，最长 **120s**（`instance.go` 的 `healthTimeoutSeconds`）。超时或子进程提前退出时，hub 会把日志末尾约 10 行写入事件日志（`GET /api/events`，或 UI 事件面板），然后**删除** `run/<id>/` 运行目录。运行中的实例日志在 `run/<instanceId>/server.log`。常见原因：权重路径不对、显存 / 内存不足、后端或设备选错、`audiocpp_server` 与模型不匹配；可用 `GET /api/executables/<id>/devices`（或启动弹窗的设备下拉）确认设备。

**下载 HuggingFace gated 模型报授权错误**
`PocketTTS`、`Stable Audio 3` 等 gated 仓库需要 HF token：创建下载任务时在 `POST /api/downloads` body 里传 `"token"`，否则返回 `DOWNLOAD_AUTH`（上游 HTTP 401/403）。token 会明文存入 `data/downloads/<id>/task.json`（目录 `0700` / 文件 `0600`），API 输出会自动剔除。

**`/v1/audio/transcriptions`（multipart）返回 400**
hub 的 `/v1/*` 代理只能从 **JSON** body 顶层的 `"model"` 字段做路由；`multipart/form-data` 无法解析出 `model`，会返回 `400 {"error":{"message":"Missing required parameter: model",...}}`。请改用 JSON body，或走 Web UI 的 ASR 流程 / `POST /api/tasks`。详见上文「OpenAI 接口兼容性」。

**从 ModelScope 下载报 `REMOTE_NOT_FOUND`**
`source:"modelscope"` 只会映射到 `HereIsMark/<repo名>`，当前仅 `audio.cpp-gguf` 一个仓库被镜像；其它包会 404（`REMOTE_NOT_FOUND`）。请改用默认 HuggingFace 源，或通过 `hfEndpoint` 指向可用镜像。

**`/v1/*` 请求返回 413**
请求体超过 `proxyMaxBodyBytes`（默认 1 GiB，见 `hub.config.json`）时无法落盘，返回 413。可在配置里调大；该限制只针对 `/v1/*` 代理请求体，不影响 `/api/*`（上限 64MB）。

**日志在哪里找**
- hub 自身：控制台输出；Windows 无控制台（`-H windowsgui`）模式另写 `logs/hub.log`
- 模型实例：运行中为 `run/<instanceId>/server.log`；启动失败后目录被清理，末尾日志保留在事件日志（`/api/events`）
- 下载任务：状态与进度在 `data/downloads/<id>/task.json`；推理任务在 `data/tasks/<id>.task.json`

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
├── app.js + modules/   # ES 模块引导层 + 20 个业务模块
└── i18n.zh.js / i18n.en.js  # 中英词典（i18n.js 只是运行时）；api-client.js 统一 HTTP 出口
docs/                   # 文档：API.md、diagrams/（19 张架构 / 时序 / 状态图）、ui.md、motion.md、pwa.md
test/ / e2e/            # 前端单元测试（node:test）与 e2e（Playwright + mock 后端）
models.json             # 模型清单（go:embed 嵌入二进制）
model-packages.json     # 下载包清单（go:embed 嵌入二进制）
run/                    # 运行时：实例 server.json / server.log / 代理缓存
data/                   # 运行时：uploads、voices、profiles.json、history、downloads、tasks
models/                 # 运行时：下载的模型权重（modelsDir）
logs/                   # 运行时：Windows GUI 模式下的 logs/hub.log
```

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

## 前端（web/）

Web UI 是纯原生 HTML/CSS/JS（`web/`），**无框架、无构建步骤，运行时不需要 Node.js**——Go 服务直接从磁盘提供
静态文件，改完刷新浏览器即可。Node / npm 工具链**只用于开发与 CI**（`tsc` 类型检查、ESLint、Prettier、
Playwright e2e、node:test 单元测试），不随发行版分发；`web/` 里的文件就是发布物本身，没有打包产物。

结构上分两层：经典脚本（挂 `window.*`，按 `index.html` 底部的 `<script>` 顺序加载）+ `web/app.js` 引导的
`web/modules/*` 20 个原生 ES 模块（不打包、不转译，浏览器直接按 URL 解析）。i18n 拆成纯数据词典
`web/i18n.zh.js` / `web/i18n.en.js` 与运行时 `web/i18n.js`；所有 HTTP 请求统一走 `web/api-client.js`
（`window.AudioCppHub.api`，含错误信封、超时中断、可见性感知轮询）；`web/boot.js` 在首次绘制前恢复主题与
界面语言，`web/styleguide.html` 是组件样式指南页。

前端结构、模块地图、状态与轮询模型、编码约定与贡献检查清单见 [`web/README.md`](web/README.md)。
架构 / 时序 / 状态图见 [`docs/diagrams/`](docs/diagrams/)；界面演示 GIF 见 [`docs/assets/`](docs/assets/)；
前端调用的接口契约见 [`docs/API.md`](docs/API.md)；e2e / 单元测试与性能预算见 [`TESTING.md`](TESTING.md)；
离线与安装（PWA）见 [`docs/pwa.md`](docs/pwa.md)，动效系统见 [`docs/motion.md`](docs/motion.md)。

## 技术栈与来源

- Go 1.27，原生单二进制；依赖仅 `github.com/getlantern/systray`（Windows 托盘）与 `golang.org/x/sys`
- 前端：原生 HTML/CSS/JS，无框架无构建；经典脚本 + `web/modules/*` 20 个 ES 模块，中英双语文案在 `web/i18n.zh.js` / `web/i18n.en.js`，HTTP 出口统一在 `web/api-client.js`，PWA 用 `web/sw.js` + `web/manifest.webmanifest`
- 开发期工具链（不进发行包）：TypeScript `checkJs`、ESLint、Prettier、Playwright、node:test；无打包器
- 本项目是 [audio.cpp](https://github.com/0xShug0/audio.cpp) 的配套管理面板（fork 维护版：<https://github.com/matthewhand/audio.cpp-hub>）；不捆绑上游二进制，模型与推理能力来自上游项目
