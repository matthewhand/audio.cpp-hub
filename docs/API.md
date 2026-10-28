# API 参考

audio.cpp-hub 的 HTTP API。默认监听 `http://127.0.0.1:8080`（见 [`README.md`](../README.md) 配置章节）。所有接口**无鉴权**，仅适用于本机 / 局域网，详见 [`SECURITY.md`](../SECURITY.md)。

本文以 `api.go` 中注册的路由为准（`registerRoutes` 的 `apiRoute` 表共 49 条；另有 `/v1/*` 代理与 `web/` 静态服务）。响应约定：

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
| GET | `/api/stats` | 用量与性能统计（按模型聚合） |
| GET | `/api/metrics/summary` | 每实例状态 + 15 分钟 / 1 小时延迟分位（#198） |
| GET | `/api/metrics/recent` | 最近的 `/v1` 请求日志（只含元数据，#198） |
| GET | `/api/metrics/requests/{id}` | 单条请求详情（含分块时间线，#198） |
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
| POST | `/v1/audio/transcriptions/live?model=` | 实时语音转写直通（分块 PCM 上传 → SSE 增量，#200） |

未匹配的 `/api/*` 返回 `404 UNKNOWN_API`；其余 GET 由 `web/` 静态文件服务。

> 表中 49 条与 `api.go` 的 `registerRoutes` 一一对应。其中 `PUT` / `DELETE` 的 `groups/{gid}` 与 `{taskId}/group` 两条在代码里共用一个四段通配模式 `/api/history/{modelId}/{seg3}/{seg4}` 再按路径段分发（两条路径在 `http.ServeMux` 里互相冲突），对外仍是上表的两个独立端点。

---

## 模型清单

### `GET /api/models`

返回内嵌 `models.json` 的原始数组（`writeRawJSON`）。它是「这个模型接受哪些参数」的唯一权威来源——`GET /v1/models` 只列 READY 的服务名，不含参数结构。

卡片字段（均为可选，缺失即表示该模型不适用）：

| 字段 | 含义 |
| --- | --- |
| `id` | 模型 id，也是 `/api/history/<modelId>` 的键；实例服务名默认取它 |
| `family` | 引擎家族；同名家族共享面板上的特殊控件 |
| `displayName` / `displayNameEn` / `description` / `descriptionEn` | 展示文案 |
| `category` | `tts` / `asr` / `sep` / `music` / `other` |
| `serverTask` | 引擎任务类型；`tts` 走历史链路，其余结果落 `data/tasks/<id>.result.json` |
| `inputs` | `{text, audio, voiceRef}`，取值 `required` / `optional` / `none`。`voiceRef: "none"` 表示**不支持参考音频克隆**，音色只能来自 `paramSchema` |
| `language` | `{values: [...], default}`，语言下拉的取值 |
| `paramSchema` | 额外参数定义，见下 |
| `modes` / `backends` / `requiredFiles` / `hfUrl` / `ggufUrl` / `task` | 启动与下载相关元数据 |

`paramSchema` 为 `{参数名: 定义}`，`定义.type` 取 `string` / `number` / `integer` / `boolean` / `enum` / `path`，可带 `default`、`min` / `max` / `step`、`values`（`enum` 的候选项）、`label` / `labelEn`、`hint` / `hintEn`、`placeholder` / `placeholderEn`、`required`。

**参数进入请求体的位置**（`POST /api/tasks` 的 `request`）：

- 通用规则：`paramSchema` 字段放 `request.options`。服务端对 `options` 全量透传，顶层字段只认白名单，写错位置会被静默丢弃。
- 例外（权威来源是 `web/modules/panels.js` 的 `collectParams` / `collectEnums`，改前端时须同步本节）：
  - `lang`、BreezeTTS 的 `text_chunk_mode` → `options`；
  - `supertonic.voice_id`、`magpie_tts.language` 等其余 enum → 顶层；
  - `qwen3_tts_voicedesign.seed` → 顶层（写历史时并入 `options`）；
  - `vevo2.task_route` → 顶层（引擎按顶层键读）；
  - `index_tts2` 情感参考音频 → 顶层 `audio`，其余情感参数 → `options`。
- 预置音色（`voice_id`）的完整用法与示例见 [agent-api.md § Preset voices](agent-api.md#preset-voices-no-cloning)。

### `GET /api/models/{modelId}/packages`

返回 `model-packages.json` 中该模型对应的下载包原始 JSON（`displayName` / `category` / `status` / `packages`）。未知模型返回 `400 MODEL_UNKNOWN`。

---

## 实例

实例对象字段：`id`、`instanceName`、`modelId`、`weightsPath`、`port`、`backend`、`executableName`、`status`、`createdAt`、`taskCount`、`sessionOptions`、`mode`（`offline` / `streaming`），可选 `device`、`threads`、`liveIngest`。`status` 为 `STARTING` / `READY` / `STOPPED` / `FAILED` 等。

### `GET /api/instances`

返回实例数组（含每实例活跃任务数 `taskCount`）。

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
  "sessionOptions": { "任意键": "任意标量值" },
  "mode": "offline",
  "liveIngest": { "idleTimeoutMs": 10000, "totalTimeoutMs": 0, "maxBodyBytes": 0, "maxChunkBytes": 65536, "sendTimeoutMs": 5000 }
}
```

- `modelId` 必填且须在清单中（否则 `400 MODEL_UNKNOWN`）；`weightsPath` 必填且须存在（`400 WEIGHTS_REQUIRED` / `WEIGHTS_NOT_FOUND`）；`threads` 必须为正（`THREADS_POSITIVE`）
- `executableId` 缺省取第一个已登记的可执行文件；无可用项返回 `400 NO_EXECUTABLE`
- 服务名 `name` 全局唯一，重名拒绝启动
- `sessionOptions` 值统一转字符串，写入 `server.json` 的 `session_options`
- `mode` 可选，默认 `offline`；`streaming` 让引擎以流式会话加载模型，才能服务 `POST /v1/audio/transcriptions/live`（见下文）。取值非法 `400 MODE_INVALID`；模型卡 `modes` 不含 `streaming` 时 `400 MODE_UNSUPPORTED`。写入 `server.json` 的 `model.mode`
- `liveIngest` 可选，仅 `mode: "streaming"` 时允许（否则 `400 LIVE_INGEST_REQUIRES_STREAMING`），映射为 `server.json` 的 `model.live_ingest`（`idle_timeout_ms` / `total_timeout_ms` / `max_body_bytes` / `max_chunk_bytes` / `send_timeout_ms`）。值须为非负整数，`0` 表示不限，`maxChunkBytes` 须为正；未知键或非法值 `400 LIVE_INGEST_INVALID`。缺省用引擎默认值
- 成功返回 `200` 实例对象；启动失败返回 `500 LAUNCH_FAILED`

### `DELETE /api/instances/{id}`

停止并移除实例，返回 `{"ok":true,"data":{"id":"..."}}`；不存在 `404 INSTANCE_NOT_FOUND`。

### `GET /api/events`

实例事件数组，元素为 `{"time","level","message"}`。

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

### 请求日志与延迟（`/api/metrics/*`，#198）

用于排查流式 TTS 卡顿（冷加载、分块间隔、重启重叠）。**只记录元数据，绝不保存输入文本或音频**
（只留字数 / 字节数 / 音频秒数）；**只在内存中**，Hub 重启即清空；不影响历史归档。
仅统计经 Hub 转发的 `POST|PUT /v1/*`（引擎 audio.cpp 的 OpenAI 兼容接口），`/api/tasks` 不计入。

- 每个实例（按服务名）一个环形缓冲，保留最近 **100** 条，新的在前；没路由到实例的请求
  （404 / 409 / 400）进 `_unrouted`。
- 延迟样本保留 1 小时，用于 15m / 1h 滚动分位（最近秩法，nearest-rank）。

**调用方标记（`X-Client`）**：请求可带可选头 `X-Client: <tag>`（如 `X-Client: reachy`）。
Hub 去首尾空白，`[A-Za-z0-9._:@/+=-]` 以外的字符替换成 `_`，截到 64 字符，记为 `client`；
该头**在转发给引擎之前删除**（含 Hub 分句流式的子请求），CORS 预检已放行。不带则 `client` 省略。
每个被记录的 `/v1` 响应都带 `X-Hub-Request-Id: <id>`（CORS 已 expose），可直接拿去查
`/api/metrics/requests/{id}`。

#### `GET /api/metrics/recent?instance=&limit=&chunks=`

`instance` 为服务名（或 `_unrouted`），空 = 全部实例合并按时间倒序；`limit` 默认 50、最大 1000；
`chunks=1` 时附带 `chunks` / `segments`（默认省略以控制体积）。

```json
{ "ringSize": 100, "requests": [ RequestRecord, ... ] }
```

`RequestRecord` 字段（时间均为毫秒，`*` 表示可能省略）：

| 字段 | 含义 |
| --- | --- |
| `id` / `time` / `startMs` | 请求 ID（同 `X-Hub-Request-Id`）、开始时间（RFC 3339 UTC / epoch ms） |
| `instance` / `instanceId`* / `modelId`* / `modelFamily`* / `task`* | 服务的实例 |
| `method` / `route` / `callerIp` / `client`* | 来源；`callerIp` 仅在对端为回环地址时采信 `X-Forwarded-For` |
| `inputBytes` / `inputChars`* / `inputAudioSec`* | 输入大小（JSON `input` 字数 / 上传音频秒数），不存内容 |
| `inFlightAtStart` / `queueWaitMs`* | 到达时同实例在途请求数、排在前面请求上等待的时间 |
| `ttfbMs`* / `firstAudioMs`* / `totalMs`* / `elapsedMs` | 首字节、首段音频、完成耗时；`elapsedMs` 对进行中请求持续增长 |
| `outputBytes` / `outputAudioSec`* / `rtf`* | 输出大小、音频秒数、实时率（总耗时 ÷ 音频秒，越小越快） |
| `status` / `error`* | HTTP 状态；失败时错误文本前 300 字符 |
| `streamed` / `streamMode`* / `chunkedTransfer` | 请求了 `stream`、SSE 回复或 Hub 分句流式（`streamMode: "sentence-chunked"`）；`chunkedTransfer` = 回复无 `Content-Length` |
| `inFlight` / `clientAborted` | 仍在进行 / 客户端在收完回复前断开（写入失败，或 Content-Length 未送完 / 流式仍在写时断开；收完整个定长回复后挂断不算） |
| `coldLoad`* / `coldLoadSource`* | 是否冷加载：`engine`（请求前探测引擎 `/v1/models` 的 `loaded`，探测不重置空闲卸载计时）/ `inferred`（按上次使用与 `idleUnloadMs` 推断）/ `queued`（前面有请求，必然已热） |
| `hubUptimeMsAtStart` / `instanceUptimeMsAtStart`* | 请求开始时 Hub / 实例已运行多久 |
| `nearRestart` / `restartReason`* | 重启重叠：Hub 或实例启动后 2 分钟内、或同服务名的实例被替换后首个请求；`hub` / `instance-start` / `instance-replaced` |
| `chunkCount` / `gapsOver100ms` / `maxGapMs` | 回复分块数（10 ms 内的写合并为一块）、间隔 >100 ms 的次数、最大间隔 |
| `minHeadroomMs`* / `underrun` | 每块到达时播放端剩余缓冲的最小值（按 PCM / WAV 码率换算）；<0 即 `underrun`（播放会断） |
| `chunks`* | `[{atMs, bytes, gapMs, audioMs*, headroomMs*, slow}]`，`slow` = 间隔 >100 ms；最多 400 块 |
| `segments`* | Hub 分句流式的每句子请求 `[{index, chars, engineMs, status, error*}]` |

#### `GET /api/metrics/requests/{id}`

返回单条 `RequestRecord`（始终含 `chunks` / `segments`）；已被环形缓冲挤出或 Hub 已重启则
`404 REQUEST_NOT_FOUND`。

#### `GET /api/metrics/summary`

```json
{
  "now": 1756400000000, "hubStartedAt": 1756389200000, "hubUptimeMs": 10800000,
  "instances": [
    { "instance": "moss-tts", "instanceId": "a1", "modelId": "moss-tts-nano", "task": "tts",
      "hubStatus": "READY", "state": "loaded", "stateSource": "engine",
      "backend": "vulkan", "device": "vulkan:1", "port": 18190, "startedAt": 1756389200000,
      "inFlight": 1, "queueDepth": 0, "tasksActive": 0,
      "lastUseAt": 1756399996000, "sinceLastUseMs": 4000,
      "idleUnloadMs": 600000, "unloadInMs": 596000, "lastColdLoadAt": 1756396400000,
      "memory": { "ramBytes": 1610612736, "vramBytes": 3221225472 },
      "windows": {
        "15m": { "count": 6, "errors": 0, "coldLoads": 0, "underruns": 0,
                 "firstAudioP50Ms": 380, "firstAudioP90Ms": 2900,
                 "totalP50Ms": 1450, "totalP90Ms": 4100, "rtfP50": 0.42 },
        "1h": { "count": 14, "...": "..." }
      } }
  ]
}
```

- `state`：`loaded` / `cold` / `loading` / `starting` / `unknown` / `gone`；`stateSource` 为
  `engine`（向引擎 `/v1/models` 探测 `loaded`，250 ms 超时，不重置空闲卸载）、`inferred`（按使用记录推断）
  或 `hub`（实例未 READY）。已停止但日志里还有请求的实例以 `hubStatus: "GONE"` 列出。
- `unloadInMs`：已加载且空闲时距空闲卸载还剩多久（实例未配 `idleUnloadMs` 时省略）。
- `inFlight`：正在经 `/v1` 转发的请求；`tasksActive`：该实例上 `/api/tasks` 进行中的任务；
  `queueDepth` = `inFlight + tasksActive - 1`（不小于 0），即在等前一个的请求数。
- `memory`：与 `/api/instances` 的 `memory` 同源（RAM / VRAM 采样），未采样时省略。
- `windows`：`15m` / `1h` 滚动窗口；分位只统计成功请求，没有样本时省略对应字段。

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

任务对象字段：`id`、`instanceId`、`instanceName`、`modelId`、`category`、`status`（`QUEUED` / `RUNNING` / `DONE` / `FAILED` / `CANCELLED`）、`createdAt`、`startedAt?`、`finishedAt?`、`error?`、`text?`、`result?`。同实例任务串行执行，无执行时长上限。

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

**说话人分段（Sortformer / VibeVoice）**：任务返回保留上游原始 JSON；
`speaker_turns[]` 和 `sample_rate` 仅在后端实际返回时用于生成浏览器
`{status,segments:[{start,end,speakerId,text,confidence?}]}` 展示结果。
`start/end` 为秒，`speakerId` 仅在当前音频内有意义；单独 Sortformer
**不生成转写文本**。完整数据契约、限制与独立推理验证计划参见
[docs/diarization.md](diarization.md)。

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
- **Optional file integrity (#207):** `model-packages.json` package `files[]` may declare a full 64-hex-character `sha256` alongside `remote` and `local`. Explicit `POST /api/downloads` file objects can also provide `sha256`; neither source is implicitly trusted. The expected SHA must be independently obtained and checked against an authoritative artifact. Never derive it from the same untrusted download endpoint.
- The expected digest is stored in `task.json` and exposed in download file details (`sha256` when supplied). Invalid digest inputs return `INVALID_SHA256`. Downloaded `.part` bytes are hashed **before** final rename and `completed=true`, including segmented/range-resumed and whole-stream downloads; mismatch is classified internally as `DOWNLOAD_HASH_MISMATCH` and leaves the task FAILED with an error message, without publishing final bytes. A prior finalized file is reverified during crash recovery, and any persisted completed entry is reverified when an active download task resumes. Already-DONE tasks are not automatically rehashed at hub startup. A SHA-256 mismatch does not silently retry or mark a file verified: it discards only the mismatched task-owned `.part` file so that a separately requested Resume starts from byte zero. Review the artifact source before retrying. Existing final files are not deleted on recovery mismatch.
- **Compatibility and trust:** missing `sha256` means **unverified**, even if the task reports `DONE`; existing packages continue to work without a hash. A 40-hex-character commit ID in package `revision` pins a Hugging Face ref; `main`, `master` and tags can move. Most bundled packages still use mutable refs, and no model weight hashes are bundled yet. The UI marks packages with mutable refs and/or missing expected file hashes. Mirror (`modelscope`) aliases use their own revision mapping, so an immutable upstream commit claim does not automatically carry over. No download from an untrusted source becomes safe just because it supplies a matching self-declared digest.

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

### `POST /v1/audio/transcriptions/live?model=<服务名>`（实时转写，#200）

边说边转写：客户端以 `Transfer-Encoding: chunked` 上传原始 PCM，audio.cpp 引擎在音频到达时以 SSE 推回转写增量。Hub 对这条路由**全双工直通**，不走上面的落盘缓冲：

- 路由按查询参数 `model`（服务名）选择实例，不读请求体；缺失 `400`，启动中 `409`，不存在 `404`
- 实例必须以 `"mode":"streaming"` 创建（`POST /api/instances`），且任务为 `asr` / `diar`；否则 `400`，错误信息说明如何重建实例
- 其余查询参数原样转发给引擎：`sample_rate`（默认 `16000`）、`channels`（默认 `1`）、`sample_format`（`s16le` 默认 / `f32le`）、`language`、`prompt`、`busy_timeout_ms`
- 请求体边收边转发（chunked），不落盘、不受 `proxyMaxBodyBytes` 限制（上限由实例 `liveIngest` 决定）；响应每行 SSE 立即 Flush，并带 `X-Accel-Buffering: no`
- 无读写超时：会话持续到客户端结束上传；客户端断开会立即中止到引擎的请求
- 引擎非 2xx 原样透传状态码和错误体；会话开始后引擎拒绝的请求选项（例如 `parakeet_tdt` 不接受 `language`）以 `200` + SSE `data: {"type":"error",...}` 返回，`/api/metrics/*` 记录在该请求的 `error` 字段
- 只 `POST`，其它方法 `405`

SSE 事件（引擎定义）：`{"type":"transcript.text.partial","text":...}`、`{"type":"transcript.text.delta","delta":...}`、最终 `{"type":"transcript.text.done","text":...}`，然后 `data: [DONE]`；diar 模型另有说话人事件。

请求日志（`/api/metrics/*`）记录 `streamed: true`、`X-Client` 标签、`X-Hub-Request-Id`、首字节时间（= 第一个转写事件）、上传字节数与音频秒数（按采样率 / 声道 / 格式推算）；**不保存音频或转写文本**。

示例：把任意音频文件按实时速度转成 16 kHz 单声道 s16le 并流式上传（`-N` 关闭输出缓冲，`-T -` 从 stdin 分块上传——`-T` 默认发 `PUT`，必须加 `-X POST`，否则 `405`；`-H 'Expect:'` 跳过 100-continue）：

```bash
ffmpeg -loglevel error -re -i speech.wav -f s16le -ac 1 -ar 16000 - |
  curl -sN -X POST -T - -H 'Expect:' -H 'Content-Type: application/octet-stream' -H 'X-Client: mic-demo/1' \
    'http://127.0.0.1:8080/v1/audio/transcriptions/live?model=bark3-live&sample_rate=16000&channels=1&sample_format=s16le'
```

麦克风（Linux / PulseAudio）：把 `-re -i speech.wav` 换成 `-f pulse -i default`。

先建流式实例，例如：

```bash
curl -s http://127.0.0.1:8080/api/instances -H 'Content-Type: application/json' -d '{
  "modelId": "parakeet_tdt", "name": "bark3-live", "mode": "streaming",
  "weightsPath": "/abs/path/to/underdog-bark-3.0-q8_0.gguf", "backend": "vulkan", "device": 0
}'
```

支持 `streaming` 的模型卡（`modes` 含 `streaming`）：`nemotron_asr`、`parakeet_tdt`、`qwen3_asr`、`higgs_audio_stt`、`moss_transcribe_diarize`、`voxtral_realtime`、`kroko_asr` 等，以 `GET /api/models` 为准。

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
| `GET /api/stats` | `web/modules/stats.js:46`（`loadStats`）打开 `#/stats` 时按需拉取，非轮询 |
| `GET /api/metrics/summary` / `recent` / `requests/{id}` | `web/modules/requests.js`（`loadRequests`）打开 `#/requests` 时拉取，面板可见期间每 2s 轮询（可暂停），关闭即停 |
| `GET /api/downloads` | `web/modules/downloads-lazy.js:60` 首屏加载 + `web/modules/downloads-lazy.js:65` 2s 轮询 |
| `POST /api/tasks` | `web/modules/tasks.js:27` |
| `DELETE /api/tasks/{id}` | `web/modules/tasks.js:42` |
| `GET /api/tasks?modelId=` | `web/modules/tasks.js:106`（`Api.list` + `query`，`reattachTasks` 重挂） |
| `GET /api/tasks/{id}` | `web/modules/tasks.js:55`（每个进行中任务一个轮询句柄，到终态即 `stop()`） |

全局 2s 轮询的启动顺序在 `web/app.js:110`–`112`（实例 → 事件 → 下载）。上表只列 2s 轮询与首屏加载涉及的端点；其余接口（证书、executables、profiles、history、任务结果、voices、fs 等）同样已全部经 `Api.*` 发出——`web/` 内除 Service Worker 自身外没有裸 `fetch`。


### ASR speaker-turn display (hub UI)

When a completed ASR task returns `speaker_turns` and numeric positive `sample_rate`, the browser renders the model-supplied speaker IDs and timestamped turn list alongside its ordinary transcript. Times come from `start_sample / sample_rate` and `end_sample / sample_rate`, never guesses. Missing or invalid timing fields suppress corresponding turns; plain ASR stays transcript-only. The raw JSON remains available. The hub does not identify people by name or add an inference endpoint.
