# API 参考

audio.cpp-hub 的 HTTP API。默认监听 `http://127.0.0.1:8080`（见 [`README.md`](../README.md) 配置章节）。所有接口**无鉴权**，仅适用于本机 / 局域网，详见 [`SECURITY.md`](../SECURITY.md)。

本文以 `api.go` 中注册的路由为准（`registerRoutes` 的 `apiRoute` 表共 49 条；另有 `/v1/*` 代理与 `web/` 静态服务）。响应约定：

- 绝大多数 `GET` / 增删改接口直接返回对象或数组（JSON）
- 部分删除 / 更新接口返回包装体 `{"ok": true, "data": {...}}`
- 失败统一为 `{"ok": false, "code": "错误码", "params": {...}, "error": "人类可读信息"}`（HTTP 状态码随语义变化）
- `/v1/*` 例外，错误体为 OpenAI 风格 `{"error": {"message": "...", "type": "..."}}`

> Web UI 侧的错误信封由 [`web/api-client.js`](../web/api-client.js) 归一化为 `ApiError`（`code` / `params` / `message`），见文末「[前端 API 客户端](#前端-api-客户端webapi-clientjs)」。

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

实例事件数组，元素为 `{"time","level","message"}`。

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

上面的两种错误体在浏览器侧的归一化由 `web/api-client.js` 完成，它是 `web/` 唯一的 HTTP 出口（无构建、无依赖的经典脚本，全局 `window.AudioCppHub.api`，下称 `Api`；完整契约见该文件头部注释）。

| 能力 | 用法 |
| --- | --- |
| 原语 | `Api.request(path, { method, body, query, params, headers, signal, timeout, raw })` → `Promise<data>` |
| 方法糖 | `Api.get` / `Api.post` / `Api.put` / `Api.del`；`body` 传普通对象自动 JSON 编码 |
| 列表守卫 | `Api.list(path)` → 返回体非数组时 reject `CLIENT_BAD_SHAPE` |
| 错误 | 统一 reject `ApiError`：`status` / `code` / `params` / `type` / `detail` / `envelope` / `isAbort` / `isTimeout` / `isNetwork`；`message` 已本地化（走 `I18N.errText`） |
| 客户端错误码 | `CLIENT_TIMEOUT` / `CLIENT_ABORTED` / `CLIENT_NETWORK` / `CLIENT_BAD_JSON` / `CLIENT_BAD_SHAPE` / `CLIENT_HTTP_ERROR` |
| 中断 | 每次请求默认 20s 超时（`timeout: 0` 关闭）；`signal` 可与外部 `AbortController` 联动 |
| 轮询 | `Api.poll(path, handler, { interval, list, onError, visibility })` → `{ stop(), refresh() }`：自调度不叠加请求、单飞、标签页隐藏时暂停且恢复后立即补一次、`stop()` 清定时器并中断在途请求 |

已迁移的调用方（见 `web/app.js`）：模型清单首次加载、`/api/instances`、`/api/events`、`/api/downloads` 三条 2s 轮询、任务轮询 `/api/tasks/{id}`（含 `stop()` 语义）、`POST /api/tasks`、`DELETE /api/tasks/{id}`、`GET /api/tasks?modelId=`。其余 `fetch` 调用（证书、executables、profiles、history、任务结果等）暂未迁移，`web/api-client.js` 头部「迁移约定」一节列出了后续顺序。
