# API 参考

audio.cpp-hub 的 HTTP API。默认监听 `http://127.0.0.1:8080`（见 [`README.md`](../README.md) 配置章节）。所有接口**无鉴权**，仅适用于本机 / 局域网，详见 [`SECURITY.md`](../SECURITY.md)。

本文以 `api.go` 中注册的路由为准（`registerRoutes` 的 `apiRoute` 表共 52 条；另有 `/v1/*` 代理与 `web/` 静态服务）。响应约定：

- 绝大多数 `GET` / 增删改接口直接返回对象或数组（JSON）
- 部分删除 / 更新接口返回包装体 `{"ok": true, "data": {...}}`
- 失败统一为 `{"ok": false, "code": "错误码", "params": {...}, "error": "人类可读信息"}`（HTTP 状态码随语义变化）
- `/v1/*` 例外，错误体为 OpenAI 风格 `{"error": {"message": "...", "type": "..."}}`

> Web UI 侧的错误信封由 [`web/api-client.js`](../web/api-client.js) 归一化为 `ApiError`（`code` / `params` / `message`），见文末「[前端 API 客户端](#前端-api-客户端webapi-clientjs)」。

> 本文只覆盖 hub 本体的路由。多机语音农场的统一入口 `cmd/fanout-proxy`（默认 `:18082`）是独立二进制，只暴露 `GET /farm/health`、`GET /api/instances`、`GET /v1/models`、`POST /v1/audio/speech`，见 [`docs/fanout-design.md`](fanout-design.md)。

> English: this file is Chinese-first. Method and path are language-neutral; see the comments in `api.go` for exact handler semantics.

## 路由索引

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/models` | 模型清单 |
| GET | `/api/models/{modelId}/packages` | 模型下载包清单 |
| GET | `/api/instances` | 实例列表 |
| POST | `/api/instances` | 启动实例 |
| DELETE | `/api/instances/{id}` | 停止实例 |
| GET | `/api/events` | 实例事件日志 |
| GET | `/api/events/stream` | 任务生命周期 SSE（hub 本机；fan-out 不代理） |
| GET | `/api/farm/health` | 同域农场摘要（hub 去拉配置里的 fan-out URL；浏览器不跨源） |
| GET | `/api/stats` | 用量与性能统计（按模型聚合） |
| GET | `/api/executables` | 可执行文件列表 |
| POST | `/api/executables` | 添加可执行文件 |
| PUT | `/api/executables/{id}` | 更新可执行文件 |
| DELETE | `/api/executables/{id}` | 删除可执行文件 |
| GET | `/api/executables/{id}/devices` | 设备探测 |
| GET | `/api/profiles` | 启动配置列表 |
| POST | `/api/profiles` | 新增启动配置 |
| PUT | `/api/profiles/{id}` | 更新启动配置 |
| DELETE | `/api/profiles/{id}` | 删除启动配置 |
| POST | `/api/run/{id}` | 同步任务转发（兼容旧链路） |
| POST | `/api/tasks` | 创建异步任务 |
| GET | `/api/tasks` | 任务列表 |
| GET | `/api/tasks/{id}` | 任务详情 |
| GET | `/api/tasks/{id}/result` | 非 TTS 任务结果 |
| DELETE | `/api/tasks/{id}` | 取消 / 删除任务 |
| GET | `/api/history/{modelId}` | 历史列表 |
| DELETE | `/api/history/{modelId}` | 清空历史 |
| GET | `/api/history/{modelId}/{taskId}` | 历史详情 |
| DELETE | `/api/history/{modelId}/{taskId}` | 删除单条历史 |
| GET | `/api/history/{modelId}/{taskId}/audio` | 结果音频 |
| GET | `/api/history/{modelId}/{taskId}/audio/{name}` | 参考音频快照 |
| PUT | `/api/history/{modelId}/groups/{gid}` | 重命名分组 |
| DELETE | `/api/history/{modelId}/groups/{gid}` | 删除分组 |
| PUT | `/api/history/{modelId}/{taskId}/group` | 设置记录分组 |
| GET | `/api/history/{modelId}/groups` | 分组列表 |
| POST | `/api/history/{modelId}/groups` | 新建分组 |
| POST | `/api/audio/upload` | 上传 WAV |
| POST | `/api/audio/info` | 探测本地 WAV 信息 |
| GET | `/api/audio/file` | 读取上传件音频 |
| GET | `/api/voices` | 音色列表 |
| POST | `/api/voices` | 保存音色 |
| PUT | `/api/voices/{vid}` | 更新音色 |
| DELETE | `/api/voices/{vid}` | 删除音色 |
| GET | `/api/voices/{vid}/audio` | 音色音频 |
| GET | `/api/fs/roots` | 文件浏览根节点 |
| GET | `/api/fs/list` | 列目录 |
| GET | `/api/fs/stat` | 探测路径 |
| POST | `/api/fs/mkdir` | 新建文件夹 |
| GET | `/api/downloads` | 下载任务列表 |
| POST | `/api/downloads` | 创建下载任务 |
| GET | `/api/downloads/{id}` | 下载任务详情 |
| DELETE | `/api/downloads/{id}` | 取消 / 删除下载任务 |
| POST | `/api/downloads/{id}/pause` | 暂停下载 |
| POST | `/api/downloads/{id}/resume` | 续传下载 |
| GET | `/v1/models` | OpenAI 模型列表 |
| POST/PUT | `/v1/*` | OpenAI 兼容代理 |

未匹配的 `/api/*` 返回 `404 UNKNOWN_API`；其余 GET 由 `web/` 静态文件服务。

> `apiRoute` 表共 52 条（含 `GET /api/events/stream` 与 `GET /api/farm/health`）。上表把共用通配的端点拆开展示：`PUT` / `DELETE` 的 `groups/{gid}` 与 `{taskId}/group` 在代码里各用一条四段模式 `/api/history/{modelId}/{seg3}/{seg4}` 再按路径段分发（两条路径在 `http.ServeMux` 里互相冲突）。`/v1/models` 与 `/v1/*` 在代码里是一条 `/v1/` 代理。

---

## 模型清单

### `GET /api/models`

返回内嵌 `models.json` 的原始数组（`writeRawJSON`）。

### `GET /api/models/{modelId}/packages`

返回 `model-packages.json` 中该模型对应的下载包原始 JSON（`displayName` / `category` / `status` / `packages`）。未知模型返回 `400 MODEL_UNKNOWN`。

---

## 实例

实例对象字段：`id`、`instanceName`、`modelId`、`weightsPath`、`port`、`backend`、`executableName`、`status`、`createdAt`、`taskCount`、`sessionOptions`，可选 `device`、`threads`。`status` 为 `STARTING` / `READY` / `STOPPED` / `FAILED` 等。

### `GET /api/instances`

返回实例数组（含每实例活跃任务数 `taskCount`）。顺序稳定：先按 `createdAt` 升序，相同时按 `id` 升序。管理器内部是 map，不能按迭代顺序返回，否则前端轮询会把卡片打乱。

采样开始后，每个实例可以多一个 `memory` 对象；第一次 RSS 采样之前（以及非 Linux，本机构建没有 `/proc`）整个字段省略，调用方要把它当可选。VRAM 从未读到时省略全部 `vram*` 字段，不写 0。平均是**时间加权**平均（每个样本按它保持到下一次采样的时长加权，不是简单算术平均），从实例启动起累计，不按任务清零。

```json
{
  "ramBytes": 644245094,
  "ramPeakBytes": 1073741824,
  "ramAvgBytes": 751619277,
  "ramIdleBytes": 637330636,
  "vramBytes": 3865470566,
  "vramPeakBytes": 4402341478,
  "vramAvgBytes": 3972844749,
  "vramIdleBytes": 3906249728,
  "vramTotalBytes": 8589934592,
  "gpuName": "NVIDIA GeForce GTX 1080",
  "vramSource": "nvidia-smi",
  "idleSinceMs": 1756390000000,
  "ramSeries": [637330636, 644245094],
  "vramSeries": [3906249728, 3865470566],
  "samples": 12,
  "sampledAt": 1756400000000,
  "busy": false
}
```

| 字段 | 含义 |
| --- | --- |
| `ramBytes` / `vramBytes` | 当前读数（进程 RSS / 进程占用的显存） |
| `ramPeakBytes` / `vramPeakBytes` | 自实例启动以来的最大值 |
| `ramAvgBytes` / `vramAvgBytes` | 时间加权平均（见上文） |
| `ramIdleBytes` / `vramIdleBytes` | **空闲基线**：实例没有 RUNNING 任务期间观察到的最小值（「这个模型闲着时占多少」）。在采到第一个空闲样本之前省略 |
| `vramTotalBytes` | 该进程所在 GPU 的显存总量（前端显存条的比例尺）。只有答案确定时才给：单 GPU 直接用那张卡的；多 GPU 且进程映射不到具体卡时省略（宁缺勿错） |
| `gpuName` | 那张卡的名字。只在 `vramSource` 为 `nvidia-smi` 且整机恰好一张 NVIDIA 卡、名字非空时给出。多卡或 DRM 省略，避免标错卡 |
| `vramSource` | `drm`（Linux DRM fdinfo，按 `drm-client-id` 去重）或 `nvidia-smi` |
| `idleSinceMs` | 最近一次由忙转闲的时刻（epoch ms）。从未忙过则是第一次空闲采样的时刻。一直处于 RUNNING、还没采到空闲样本时省略。转忙之后不清除，界面在生成中自己藏起「空闲了多久」 |
| `ramSeries` / `vramSeries` | 最近最多 60 个采样点（字节，旧→新），给 WebUI 迷你折线。不足 2 个点时整个字段省略（单点画不出线）。VRAM 从未读到时不写 `vramSeries`（未知不是 0）。环形缓冲定长，不随实例寿命增长 |
| `samples` / `sampledAt` / `busy` | 采样次数 / 最后一次采样时间（毫秒）/ 当前是否有 RUNNING 任务 |

- `busy` 为真表示该实例当前有 RUNNING 任务，采样间隔约 1s；空闲约 10s
- `vramTotalBytes` 是尽力而为：nvidia 走 `nvidia-smi --query-gpu=index,name,memory.total`（整个 hub 生命周期只查一次，与进程查询共用超时与失败退避）。卡名里可以有逗号：第一个字段是序号，最后一个字段是 MiB，中间拼回去才是名字。AMD 走 `/sys/class/drm/card*/device/mem_info_vram_total`（同样只读一次，且只有机器上只有一张卡时才认）。`gpuName` 与总量用同一条「恰好一张卡」规则，DRM 不带名字
- 采样失败不会让这个接口报错。fan-out 聚合 `GET /api/instances` 时原样带上 `memory`（多出来的字段不影响路由）

### `POST /api/instances`

启动实例。

```json
{
  "modelId": "index_tts2",
  "weightsPath": "/abs/path/to/weights",
  "backend": "cpu",
  "device": 0,
  "port": 18091,
  "threads": 8,
  "executableId": "507bed27",
  "name": "可选的服务名，默认 modelId",
  "sessionOptions": { "任意键": "任意标量值" }
}
```

- `modelId` 必填且须在清单中（否则 `400 MODEL_UNKNOWN`）；`weightsPath` 必填且须存在（`400 WEIGHTS_REQUIRED` / `WEIGHTS_NOT_FOUND`）；`threads` 必须为正（`THREADS_POSITIVE`）
- `executableId` 缺省取第一个已登记的可执行文件；无可用项返回 `400 NO_EXECUTABLE`
- 服务名 `name` 全局唯一，重名拒绝启动
- `sessionOptions` 值统一转字符串，写入 `server.json` 的 `session_options`
- 成功返回 `200` 实例对象；启动失败返回 `500 LAUNCH_FAILED`

### `DELETE /api/instances/{id}`

停止并移除实例，返回 `{"ok":true,"data":{"id":"..."}}`；不存在 `404 INSTANCE_NOT_FOUND`。

### `GET /api/events`

实例事件数组，元素为 `{"time","level","message"}`。这是轮询日志，不是推送。

### `GET /api/events/stream`

Server-Sent Events（`Content-Type: text/event-stream`）。连接后先发一条 `event: hello` / `data: {}`，之后约每 15 秒一条 `: ping` 注释保活。任务状态变化另发命名事件，`data` 为 JSON：

| 事件 | 数据 |
| --- | --- |
| `task.queued` | `taskId` `instanceId` `modelId` `category` `ts` |
| `task.started` | 同上 |
| `task.finished` | 同上，加 `ok: true`、`durationMs`，已知时还有 `peakRamBytes` / `peakVramBytes` |
| `task.failed` | 同上，加 `ok: false`、`durationMs`、`error` |
| `task.cancelled` | 同 `task.queued` |
| `instance.memory` | 可选。实例正忙时每次采样一条：`instanceId` `ramBytes` `ts`，已知时还有 `vramBytes` `vramSource` |

慢订阅者的缓冲满了就丢掉那一条，任务执行不会等 UI。客户端断开即退订。`EventSource` 默认会重连。`main.go` 不设 `WriteTimeout`，所以这条长连接不会被写超时掐断。

**fan-out 不代理这条流**（`cmd/fanout-proxy` 只转发它文档里列出的那些路由）。要收推送就直连那台 hub。

没有事件总线时（不应出现在正常进程里）返回 `503 EVENTS_UNAVAILABLE`。

### `GET /api/farm/health`

同域的农场摘要。浏览器只打这条（CSP `connect-src 'self'`），hub 自己去拉 fan-out 的 `GET /farm/health`。

URL 来自进程环境变量 `AUDIOCPP_HUB_FANOUT_URL`。未设置时用 `http://127.0.0.1:18082/farm/health`。设成空字符串（或只有空白）则关闭探测。这个 URL 是进程配置，**不读请求里的 query / header / body**，所以不是 SSRF 入口。

服务端超时 1.5 秒，成功和失败都缓存约 5 秒，并发请求共用一次在途拉取（single-flight）。不跟随重定向。正文超过 1 MiB 视为无效。

始终 `200`。fan-out 给出可用摘要时：

```json
{"available":true,"hubsUp":3,"hubsTotal":4,"failures":1,"checkedAt":"2026-10-10T00:00:00Z","inFlightCap":2}
```

- `hubsUp` / `hubsTotal` 来自 fan-out 正文里的同名字段（必须都在，且 `0 <= hubsUp <= hubsTotal`）
- `failures` 是 `hubs[].failures` 之和（`hubs` 可以没有；有但不是数组则整段无效）。`0` 也写出来
- `checkedAt` 优先用 fan-out 的 `updatedAt`（非空字符串），否则是 hub 这次检查的 UTC 时间
- `inFlightCap` **可选**：fan-out 的 `MaxInFlightPerTarget` 逐字透传。没有这个键表示 fan-out 没报（旧版本或单机部署），客户端回落到自己的默认值，**不会**把「缺字段」读成「额度为 0」；上报 `0` 则照实写 `0`。存在但不是 `0 <= n <= 1e9` 的整数时整份摘要无效（同 `hubs[].failures` 的规则）。WebUI 用它作为「Now / Queue」状态条的并发上限
- fan-out 的 `ok` 若出现必须是布尔，但不决定 `available`。`available: true` 只表示「拿到了一份能用的摘要」

连不上、非 200、正文不是这份形状时，同样 `200`，正文只有：

```json
{"available":false}
```

### `GET /api/stats`

按模型聚合的用量与性能统计，纯派生读接口——不新增采集点、不改任务/历史结构。

**口径说明（重要）：**

- **用量**（`total` / `ok` / `failed` / `successRate` / `audioSeconds` / `outputBytes` / `lastAt`）
  取自历史索引 `data/history/<modelId>/index.jsonl`。历史**无数量淘汰**，因此这是长期口径。
  注意：仅 TTS 任务会写历史；ASR / 分离 / 音乐等类别不计入本统计。
- **性能**（`queueMsP50` / `runMsP50` / `runMsP95` / `rtfP50` / `samplesForPerf`）
  取自内存中的任务记录（带 `createdAt` / `startedAt` / `finishedAt` 与 `result.durationSec`）。
  内存仅保留最近 `finishedKeep`（100）条已完成任务，因此性能样本是**近期窗口**，非全量。
  `samplesForPerf` 为 0 表示尚无可用样本，看板此时不展示性能行。

`rtfP50` 为实时率 = 执行秒数 ÷ 生成音频秒数，**越小越快**，小于 1 表示快于实时。
`audioSeconds` 取自 WAV 解析结果，缺失结果的记录不计入。

```json
{
  "generatedAt": 1756400000000,
  "totals": { "models": 2, "total": 12, "ok": 11, "failed": 1, "successRate": 0.917,
              "audioSeconds": 48.6, "outputBytes": 778240 },
  "models": [
    { "modelId": "breeze-tts", "instanceName": "breeze2tts", "category": "tts",
      "total": 10, "ok": 10, "failed": 0, "successRate": 1, "audioSeconds": 40.2,
      "outputBytes": 643200, "lastAt": 1756399000000,
      "queueMsP50": 120, "runMsP50": 2100, "runMsP95": 3400, "rtfP50": 0.42,
      "samplesForPerf": 10 }
  ]
}
```

模型数组按 `total` 降序、`lastAt` 次序。

---

## 可执行文件

条目字段：`id`、`name`、`path`、`note`、`env`（键值表）、`createdAt`。

### `GET /api/executables`

返回条目数组。

### `POST /api/executables`

```json
{ "name": "ROCm", "path": "/opt/audiocpp/audiocpp_server", "note": "可选", "env": { "PATH": "/opt/rocm/bin:${PATH}" } }
```

返回新条目；失败 `400 EXEC_ADD_FAILED`。`env` 值支持 `${VAR}` 占位符，从 hub 进程环境展开。

### `PUT /api/executables/{id}`

body 同上，更新后返回条目；不存在 `404 EXEC_NOT_FOUND`。

### `DELETE /api/executables/{id}`

返回 `{"ok":true,"data":{"id":"..."}}`。

### `GET /api/executables/{id}/devices`

运行 `<可执行文件> --list-devices`（60s 超时，注入条目 `env`）并解析：

```json
{
  "devices": [ { "backend": "hip", "index": 0, "name": "AMD Radeon ...", "type": "GPU" } ],
  "raw": "原始输出"
}
```

失败：`404 EXEC_NOT_FOUND`、`400 FILE_NOT_FOUND`、`500 DEVICE_LIST_FAILED`。

---

## 启动配置（Profile）

条目为持久化的启动参数集合，字段与 `POST /api/instances` 的 body 基本一致（含 `id`、`name`）。

### `GET /api/profiles`

返回配置数组。

### `POST /api/profiles` / `PUT /api/profiles/{id}`

```json
{ "name": "IndexTTS2 常用", "modelId": "index_tts2", "weightsPath": "/abs/path", "backend": "cpu" }
```

- `name` 必填（`NAME_REQUIRED`）、`modelId` 须在清单中（`MODEL_UNKNOWN`）、`weightsPath` 必填（`WEIGHTS_REQUIRED`）；`backend` 缺省 `cpu`
- 返回保存后的条目；`PUT` 不存在返回 `404 PROFILE_NOT_FOUND`

### `DELETE /api/profiles/{id}`

返回 `{"ok":true,"data":{"id":"..."}}`。

---

## 推理任务

任务对象字段：`id`、`instanceId`、`instanceName`、`modelId`、`category`、`status`（`QUEUED` / `RUNNING` / `DONE` / `FAILED` / `CANCELLED`）、`createdAt`、`startedAt?`、`finishedAt?`、`error?`、`text?`、`result?`，以及可选的 `peakRamBytes` / `peakVramBytes`（该任务处于 RUNNING 期间采样到的峰值；没采到就省略，不会写 0）。同实例任务串行执行，无执行时长上限。

### `POST /api/tasks`

```json
{ "instanceId": "ab12cd34", "request": { "text": "你好", "voice_ref": "/abs/ref.wav" } }
```

返回 `202` 任务对象（`GET /api/tasks/{id}` 可见队列位置）。`instanceId` 缺失 `400 INSTANCE_REQUIRED`；实例不存在 `404`；未就绪 `409 INSTANCE_NOT_READY`。

- **TTS 任务**：taskId 即历史记录 id，结果音频落入 `data/history/<modelId>/<taskId>.wav`，通过 `/api/history/.../audio` 获取
- **非 TTS 任务**：结果 JSON 落盘 `data/tasks/<id>.result.json`，通过 `/api/tasks/{id}/result` 获取

### `GET /api/tasks`

查询参数：`active=1` 仅活跃任务；`modelId=<id>` 按模型过滤。返回任务数组（活跃在前）。

### `GET /api/tasks/{id}`

返回任务详情（含 `position` 队列位置）。

### `GET /api/tasks/{id}/result`

流式回写非 TTS 结果 JSON；TTS 任务或结果不存在返回 `404 RESULT_NOT_FOUND`（提示走 `/api/history`）。

### `DELETE /api/tasks/{id}`

`QUEUED` 直接取消；`RUNNING` 中断 hub 侧等待（引擎会跑完，属已知限制）；已结束则删除记录。返回 `{"ok":true,"data":{"id":"..."}}`。

### `POST /api/run/{id}`（兼容旧链路，同步）

```json
{ "request": { "text": "..." } }
```

不创建队列任务，直接转发到实例 `/v1/tasks/run` 并等待结果：非 TTS 响应原样回写；TTS 响应落盘、提取音频进历史后回写。实例不存在 `404`，未就绪 `409 INSTANCE_NOT_READY`，转发失败 `502 FORWARD_FAILED`。

---

## TTS 操作历史

历史按 `modelId` 隔离，保存在 `data/history/<modelId>/`（`index.jsonl` + 结果音频 + 参考音频快照）。**无自动淘汰**，只由用户手动删除。记录含四要素快照：参考音频、参考文本、音色提示词、生成内容。

### `GET /api/history/{modelId}`

简要列表（新 → 旧），元素含 `taskId`、`time`、`instanceName`、`ok`、`text`（超 100 字截断并带 `textTruncated: true`）、可选 `groupId`、`error`、`result`。

### `DELETE /api/history/{modelId}`

清空该模型历史（保留分组），返回 `{"ok":true,"data":{"modelId":"..."}}`。

### `GET /api/history/{modelId}/{taskId}`

返回完整记录（含 `voice`、`options`、`refs`、`refBytes`、`result` 等）。

### `DELETE /api/history/{modelId}/{taskId}`

删除单条记录（含结果音频与参考快照），返回 `{"ok":true,"data":{"taskId":"..."}}`。

### `GET /api/history/{modelId}/{taskId}/audio`

流式返回结果 WAV（`Content-Type: audio/wav`）。

### `GET /api/history/{modelId}/{taskId}/audio/{name}`

返回参考音频快照，`name` 为 `ref` | `emo` | `spkN`。

### 分组

- `GET /api/history/{modelId}/groups` — 分组数组
- `POST /api/history/{modelId}/groups` — body `{"name":"..."}`，返回新分组
- `PUT /api/history/{modelId}/groups/{gid}` — body `{"name":"..."}`，重命名
- `DELETE /api/history/{modelId}/groups/{gid}` — 删除分组（记录回未分组）
- `PUT /api/history/{modelId}/{taskId}/group` — body `{"groupId":"..."}`（空串移回未分组）

---

## 音频上传

音频信息对象字段：`id?`（上传件才有）、`path`（绝对路径）、`durationSec`、`sampleRate`、`channels`、`bitsPerSample`、`sizeBytes`。仅接受标准 PCM WAV（`audioFormat` 1 或 3），上限 50MB。

### `POST /api/audio/upload`

请求体为原始 WAV 字节。返回音频信息（含 `id`，保存到 `data/uploads/<id>.wav`）。超限 `413 FILE_TOO_LARGE`；非 WAV `400 UPLOAD_FAILED`（错误码 `NOT_WAV` / `WAV_CHUNKS_MISSING` / `WAV_NOT_PCM` / `WAV_FMT_INVALID`）。

### `POST /api/audio/info`

```json
{ "path": "/abs/path/to/audio.wav" }
```

探测本地路径的 WAV 信息。`path` 必填（`PATH_REQUIRED`）；失败 `400 PROBE_FAILED`。

### `GET /api/audio/file?id=<uploadId>`

流式返回上传件 WAV（`Content-Type: audio/wav`）；id 非法或不存在 `404 UPLOAD_NOT_FOUND`。

---

## 音色库

条目字段：`vid`、`name`（全局唯一）、`createdAt`、`path`、`durationSec`、`sampleRate`、`channels`、`bitsPerSample`、`sizeBytes`，可选 `text`（参考音频配套文本）。

### `GET /api/voices`

返回全部音色数组。

### `POST /api/voices`

```json
{ "name": "女声A", "text": "参考文本（可选）", "uploadId": "abcd1234" }
```

`uploadId` 与 `path` 二选一（服务器绝对路径）。返回新条目。错误：`VOICE_NAME_REQUIRED`、`VOICE_NAME_EXISTS`、`VOICE_SOURCE_REQUIRED`、`UPLOAD_NOT_FOUND`、`FILE_NOT_FOUND`（均为 400）。

### `PUT /api/voices/{vid}`

body `{"name"?: "...", "text"?: "..."}`，缺省字段不修改；`text` 传空串则清除。返回 `{"ok":true,"data":{"vid":"..."}}`；不存在 `404 VOICE_NOT_FOUND`。

### `DELETE /api/voices/{vid}`

删除音色及其音频，返回 `{"ok":true,"data":{"vid":"..."}}`。

### `GET /api/voices/{vid}/audio`

流式返回音色 WAV。

---

## 文件浏览

> 有意暴露服务器本地文件系统，仅限本机 / 受信网络使用。

### `GET /api/fs/roots`

根节点数组：Windows 为各盘符，其它系统为 `/`，并附带主目录与程序根目录，元素为 `{"name","path"}`。

### `GET /api/fs/list?path=<dir>`

```json
{
  "path": "/abs/dir",
  "parent": "/abs",
  "entries": [ { "name": "x.wav", "path": "/abs/dir/x.wav", "dir": false, "hidden": false, "size": 123, "ext": ".wav", "mtime": "2026-01-01 12:00" } ]
}
```

`path` 缺失 `400 PATH_REQUIRED`；不存在 / 非目录 `PATH_NOT_FOUND` / `NOT_A_DIRECTORY`。

### `GET /api/fs/stat?path=<path>`

返回 `{"path","exists","name?","dir?","size?","ext?","mtime?","hidden?"}`；路径不存在也返回 `200`（`exists:false`）。

### `POST /api/fs/mkdir`

```json
{ "parent": "/abs/dir", "name": "new-folder" }
```

返回新目录条目。错误：`PARENT_REQUIRED`、`DIR_NAME_REQUIRED`、`DIR_NAME_INVALID`（名称含 `\ / : * ? " < > |` 等）、`PARENT_NOT_FOUND`、`ALREADY_EXISTS`。

---

## 权重下载

任务详情字段：`id`、`targetDir`、`modelId?`、`packageId?`、`source?`（`hf` / `modelscope`）、`status`、`error?`、`createdAt`、`updatedAt`、`files[]`（含 `path`、`url`、`size`、`supportsRange`、`completed`、`segments[]`）。`GET` 列表 / 详情会剔除 `token`。

### `GET /api/downloads`

返回任务数组（含 `percent` / `speedBps` 统计）。

### `POST /api/downloads`

两种形式，创建即开始下载：

```json
// 1) 按模型清单
{ "modelId": "index_tts2", "packageId": "可选，缺省取 default 包", "token": "HF token（gated 仓库需要）", "overwrite": false, "endpoint": "可选，覆盖 hfEndpoint", "source": "hf | modelscope" }

// 2) 显式文件列表
{ "targetDir": "index_tts2", "files": [ { "url": "https://.../a.bin", "path": "a.bin" } ], "token": "可选", "overwrite": false }
```

- 权重落盘 `models/<targetDir>/`，先写 `<file>.part`，完成后改名
- `source: "modelscope"` 走 `modelscope.cn` 镜像（repo 映射为 `HereIsMark/<名字>`，revision 固定 `master`；目前仅 `audio.cpp-gguf` 仓库可用，其它包返回 `REMOTE_NOT_FOUND`）
- `token` 明文存 `task.json`（API 输出剔除）
- 错误：`MODEL_UNKNOWN`、`PACKAGE_UNKNOWN`、`FILES_REQUIRED`（400）；`DOWNLOAD_NOT_FOUND`（404）；内部错误 500

### `GET /api/downloads/{id}`

返回详情（含分段进度）。

### `POST /api/downloads/{id}/pause` / `POST /api/downloads/{id}/resume`

暂停 / 续传，返回 `{"ok":true,"data":{"id":"..."}}`。

### `DELETE /api/downloads/{id}?purge=true`

取消并移除任务；`purge=true` 清理 `.part` 残留。

---

## OpenAI 兼容代理

### `GET /v1/models`

聚合全部 `READY` 实例的服务名，返回 OpenAI 格式的模型列表：

```json
{ "object": "list", "data": [ { "id": "instanceName", "object": "model", "created": 1700000000, "owned_by": "audiocpp" } ] }
```

### `POST|PUT /v1/*`

1. 请求体流式落盘 `run/proxy-cache/<id>.req`（超 `proxyMaxBodyBytes` 返回 `413`）
2. 流式扫描顶层 `"model"` 字符串（缺失 / 非 JSON 返回 `400`）
3. 按服务名路由到 `READY` 实例（启动中 `409`，不存在 `404`）
4. 落盘文件作为 body 原样转发到实例同名路径，响应状态码 / `Content-Type` 透传、逐块 Flush

> **已知限制**：`multipart/form-data` 无法提取 `model`（extractor 只认 JSON），例如 multipart 的 `POST /v1/audio/transcriptions` 会返回 `400 Missing required parameter: model`。请改用 JSON body 或 Web UI 的 ASR 流程。

其它方法（非 GET/POST/PUT）返回 `405`。

---

## 前端 API 客户端（`web/api-client.js`）

上面的两种错误体在浏览器侧的归一化由 `web/api-client.js` 完成，它是 `web/` 唯一的 HTTP 出口（无构建、无依赖的经典脚本，全局 `window.AudioCppHub.api`，下称 `Api`；完整契约见该文件头部注释）。业务代码经 `web/modules/api.js` 绑定该全局后 `import { Api } from "./api.js"`，**新增请求一律走 `Api.*`，不要再直接写 `fetch`**。

| 能力 | 用法 |
| --- | --- |
| 原语 | `Api.request(path, { method, body, query, params, headers, signal, timeout, raw, cache })` → `Promise<data>`；`params` 替换 path 的 `{name}` 占位并做 `encodeURIComponent` |
| 方法糖 | `Api.get` / `Api.post` / `Api.put` / `Api.del`；`body` 传普通对象自动 JSON 编码，`FormData` / `Blob` / 字符串原样发送 |
| 列表守卫 | `Api.list(path)` → 返回体非数组时 reject `CLIENT_BAD_SHAPE` |
| 错误 | 统一 reject `ApiError`：`status` / `code` / `params` / `type` / `detail` / `envelope` / `url` / `method` / `isAbort` / `isTimeout` / `isNetwork` / `isClient`；`message` 已本地化（走 `I18N.errText`） |
| 客户端错误码 | `CLIENT_TIMEOUT` / `CLIENT_ABORTED` / `CLIENT_NETWORK` / `CLIENT_BAD_JSON` / `CLIENT_BAD_SHAPE` / `CLIENT_HTTP_ERROR`（`Api.CODE`） |
| 默认值 | 单次请求 20s（`Api.DEFAULTS.timeout`，`timeout: 0` 关闭）；轮询间隔 2s、单次 10s（`Api.DEFAULTS.pollInterval` / `pollTimeout`） |
| 中断 | 每次请求内部自建 `AbortController`，链接调用方 `signal` 与超时定时器，请求结束即清理，不留悬挂句柄 |
| 轮询 | `Api.poll(path, handler, { interval, timeout, list, visibility, immediate, onError })` → `{ stop(), refresh() }`：自调度（上一轮结束才排下一轮，不叠加请求）、单飞、标签页隐藏时暂停且恢复后立即补一次、`list: true` 加数组形状守卫、失败只交给 `onError` 不打断轮询 |
| 收尾 | `Api.stopAllPollers()` 停掉本客户端创建的全部轮询（组件整体卸载 / 测试清理用） |

已迁移的调用方（均已随 `web/app.js` 拆分落到 `web/modules/*`）：

| 端点 | 调用点 |
| --- | --- |
| `GET /api/models` | `web/modules/models.js:27`（`Api.list`） |
| `GET /api/instances` | `web/modules/instances.js:49` 首屏加载 + `web/modules/instances.js:57` 2s 轮询 |
| `GET /api/events` | `web/modules/async-ui.js:189`（`startEventsPolling`）2s 轮询（失败静默） |
| `GET /api/events/stream` | `web/modules/task-events.js`（`EventSource`，不是 `fetch`；失败静默，实例列表仍靠 2s 轮询） |
| `GET /api/farm/health` | `web/modules/hub-chip.js`（约 5s 轮询；不可用时 chip 退回本机实例计数；同一份摘要里的 `inFlightCap` 由 `web/modules/nowqueue.js` 读作并发上限，不另发请求） |
| `GET /api/tasks` | `web/modules/activity.js`（最近活动面板播种；SSE 未连接且面板打开时约 5s 再拉） |
| `GET /api/stats` | `web/modules/stats.js:46`（`loadStats`）打开 `#/stats` 时按需拉取，非轮询 |
| `GET /api/downloads` | `web/modules/downloads-lazy.js:60` 首屏加载 + `web/modules/downloads-lazy.js:65` 2s 轮询 |
| `POST /api/tasks` | `web/modules/tasks.js:27` |
| `DELETE /api/tasks/{id}` | `web/modules/tasks.js:42` |
| `GET /api/tasks?modelId=` | `web/modules/tasks.js:106`（`Api.list` + `query`，`reattachTasks` 重挂） |
| `GET /api/tasks/{id}` | `web/modules/tasks.js:55`（每个进行中任务一个轮询句柄，到终态即 `stop()`） |

全局 2s 轮询的启动顺序在 `web/app.js` 启动段（实例 → 任务事件流 → 事件日志 → 下载）。上表只列 2s 轮询与首屏加载涉及的端点；其余接口（证书、executables、profiles、history、任务结果、voices、fs 等）同样已全部经 `Api.*` 发出——`web/` 内除 Service Worker 自身外没有裸 `fetch`。任务推送是 `EventSource`，Service Worker 对 `/api/*` 不 `respondWith`，因此不会拦截或缓存这条流。
