# Agent API — using this hub from an AI agent / automation

Audience: an autonomous agent (or script) on the LAN that wants to **generate speech
in a variety of voice designs** and **transcribe audio** against this hub.

- **Base URL: `http://10.0.0.36:18082`** — the LAN fan-out proxy, i.e. one URL for
  the whole farm with automatic failover. Use it for TTS, STT and discovery.
  LAN-only, no auth — never expose publicly.
- Secondary URL: `http://10.0.0.36:18080` — a single hub, required for the routes
  the fan-out does not proxy (upload, voices, history), because each hub owns that
  state. See [Unified fan-out base URL](#unified-fan-out-base-url).
- All bodies are JSON unless stated otherwise
- Error bodies: `{"error": {"code", "params", "message"}}` (hub API routes) or
  `{"error": {"message", "type"}}` (fan-out, i.e. `:18082` — same envelope on
  `:18080 /v1/*`). One exception: the fan-out's task *reads* relay the hub's own
  status and body verbatim, because a hub `404` must stay recognizable.

The ready-made client already defaults to both: `clients/audiocpp_client.py`
(`DEFAULT_HUB` = the fan-out for TTS, `DEFAULT_DIRECT_HUB` = `.36:18080` for the
hub-only routes; override with `--hub` / `--direct-hub` or `AUDIOCPP_HUB_URL` /
`AUDIOCPP_DIRECT_HUB_URL`).

## Unified fan-out base URL

`http://10.0.0.36:18082` fronts every hub in the farm (`docs/farm.md`), so an
agent can speak model **aliases** instead of `host:port:service` triples:

```jsonc
// POST http://10.0.0.36:18082/v1/audio/speech
{ "model": "expressive", "input": "…", "options": { "instruction": "…" } }
//  -> .36 breeze, or .30 breeze if .36 is down / not READY
```

| Alias | Serves from (in order) |
|---|---|
| `breeze`, `expressive` | `.36:18080 breeze` → `.30:18080 breeze` |
| `qwen3-vd`, `voice-design-fast` | `.30:18081 qwen3-vd` |
| `sanotts`, `instant` | `.36:18080 sanotts` → `.32:18080 sanotts` |
| `citrinet`, `stt` | `.36:18080 citrinet` |

An alias names a *service*; the endpoint you call names the *request shape*.
TTS is `POST /v1/audio/speech`; ASR is `POST /api/tasks` ([§2](#2-speech--text-stt)).
Calling speech against `citrinet` 503s — the engine wants audio, not text.

- `GET /v1/models` — only the aliases that currently have a working backend.
- `GET /api/instances` — every hub's instances in one list, each entry tagged with
  its `hub` / `hubLabel`. Ids are hub-local, so they are not usable for
  `/api/tasks` on another host.
- Successful responses add `X-Fanout-Hub` / `X-Fanout-Instance`; use the hub
  there to fetch the archived take from `/api/history/...`, and to poll the task
  you just submitted.
- `GET /farm/health` — per-hub up/down, latency, which backend each alias
  resolved to, and each target's live `inFlight` against `inFlightCap`.
  Fan-out only; hubs answer 404.
- **Fairness cap:** at most `maxInFlightPerTarget` (default 2) forwards may be in
  flight per hub+service. A busy target is skipped, so the call spills to the
  standby; when *every* target of the route is busy you get `429` +
  `Retry-After: 5` (`type: rate_limit_error`) instead of a `503`. Treat that as
  "retry shortly", not as an outage — OpenAI SDKs already retry `429` by default.
  Fan out over time or raise the cap server-side; only the single-target routes
  (`qwen3-vd` / `voice-design-fast` / `citrinet`) have nowhere to spill to. For
  `POST /api/tasks` the slot covers the *submission*; the hub's own serial queue
  is what bounds how much runs at once.
- **Not proxied:** `/api/history/*`, `/api/voices/*`, `/api/audio/upload`,
  `/v1/tasks/run`, and `GET /api/events/stream`. Keep using the hub's own port
  for those — the first three because each hub owns that state, `/v1/tasks/run`
  because it is hub-shaped (`model` = service name), and the event stream
  because it is a transient push channel, not a per-hub resource the proxy
  can address. `GET /api/instances` through the fan-out still returns whatever
  each hub sent, including the optional `memory` object when that hub has
  sampled it.
- Fan-out is LAN-only with no auth, exactly like the hubs.


## Instances used here

| Service name (`model` on `:18080`) | Model | Task | Warm policy | Fan-out alias |
|---|---|---|---|---|
| `breeze` | breeze-tts | expressive TTS / voice design | always warm | `breeze`, `expressive` |
| `sanotts` | SanoTTS (heart-nano) | ultra-fast TTS | always warm | `sanotts`, `instant` |
| `citrinet` | Citrinet ASR | STT | lazy, unloads after 5 min idle | `citrinet`, `stt` (task shape only) |

Those three live on `.36:18080`; the farm adds `qwen3-vd` on `.30:18081`
(aliases `qwen3-vd` / `voice-design-fast`) and a spare `breeze` on `.30:18080`
for failover. Reach the extra hosts only through the fan-out —
`docs/farm.md` has the full table.

Registered reference voices (voice library): `persona_vex` (dry sarcastic
female), `persona_gruff` (gravelly amused male), `persona_sunny` (bright fast
female), `persona_deadpan` (flat monotone male) — seed-42 breeze designs,
STT-verified, each with its exact transcript stored as `text`.

## 1. Text → speech (voice design)

`POST /v1/audio/speech` — synchronous; response body is raw WAV bytes. Send it to
the fan-out (`:18082`) and use an alias as `model`; a hub (`:18080`) takes its
own service name.

```jsonc
{
  "model": "breeze",            // alias on :18082; "sanotts"/"instant" also fine
  "input": "Oh, brilliant. Another meeting that could have been an email.",
  "response_format": "wav",
  "options": {                  // breeze-tts paramSchema fields go here
    "instruction": "Dry, unimpressed female voice, thick sarcasm, slight smirk, medium pace",
    "temperature": 0.9,         // 0.7 safe … 1.1 wilder
    "top_k": 50,
    "seed": 12345               // same seed + same options = reproducible take
  }
}
```

### Generating a variety of voice designs

The design space is the cross product of three axes:

1. **`instruction`** — persona + delivery in one string: gender, age, accent,
   energy, pace, sarcasm/flatness, timbre hints. This is the main creative lever.
2. **`seed`** — same instruction with a different seed yields a different take
   of the same design (audition alternatives without rethinking the persona).
3. **`temperature`** — 0.7 conservative/stable, 1.0–1.1 more expressive/erratic.

Practical loop: fix an instruction, sweep 3–5 seeds, keep the best take; then
mutate the instruction for the next persona. History keeps every take with its
full request, so any good result is reproducible later.

### Cloned voices (reference audio)

`breeze` clones from a reference clip. The reference fields are **top-level**
request body keys (the engine rejects unknown keys inside `options`):

- **Ad hoc:** `"voice_ref"` = absolute path of a WAV on the server **and**
  `"reference_text"` = exact transcript of that clip (required for cloning).
  Upload clips via `POST /api/audio/upload` (raw WAV bytes, ≤50 MB) → use the
  returned `path`.
- **Voice library (reusable):** `POST /api/voices {"name", "text", "path"}`
  registers a named reference; list with `GET /api/voices`; the library is the
  best source of `voice_ref` paths for agents. Cloned designs combine with
  `instruction` for delivery steering.

Extra top-level keys the caller adds (e.g. OpenAI-style `"voice"`) are ignored,
so standard OpenAI clients work unchanged.

> **Fan-out caveat:** `voice_ref` is a path on the hub that receives the
> request, and each hub has its own voice library (`data/voices/`). A reference
> registered on `.36` does not exist on `.30`/`.32`, so a fan-out call that
> fails over mid-request will 500 on the `voice_ref`. Either pin
> `voice_ref` calls to one hub, or use `instruction` (voice design) instead,
> which is stateless.

### Where results are archived

**Every successful TTS generation is archived** under `data/history/<modelId>/` —
both the async task flow and the synchronous `/v1/audio/speech` proxy (the proxy
te-es the response audio into history on the fly):

- `GET /api/history/breeze-tts` — newest-first list; each entry has `taskId`
  (feed it to the two routes below), truncated `text`, `instanceName` and
  `result.durationSec`
- `GET /api/history/breeze-tts/<taskId>/audio` — the WAV itself
- `GET /api/history/breeze-tts/<taskId>` — full record incl. the request
  (instruction/seed/voice_ref when sent) so any take can be reproduced exactly

`modelId` is the hub's model id, not the fan-out alias: `breeze-tts`, `sanotts`,
`citrinet_asr`. These routes live on a hub, so for a take made through the
fan-out query the `X-Fanout-Hub` host (history is per hub, never unified).

Sync-proxy records carry `result.via: "v1/audio/speech"`; the Web UI history
panel lists and plays them like any other take. Failed or client-interrupted
calls are not archived.

## 2. Speech → text (STT)

STT goes through the fan-out (`http://10.0.0.36:18082`) with the `stt` alias, so
it inherits the same failover and 429-shedding behavior as TTS.

**Note:** OpenAI-style `POST /v1/audio/transcriptions` (multipart) is **not**
available — the fan-out routes by the top-level `"model"` of a JSON body and
returns 400 for multipart. Use the async task API instead.

### a) Async task API (recommended; any audio size)

```jsonc
// POST http://10.0.0.36:18082/api/tasks
{ "model": "stt",                          // alias; the fan-out resolves the
  "request": { "audio": "/abs/path/on/server.wav" } }   // engine's own request
//  -> 202 + { "id": "<hub-local task id>", "status": "QUEUED", … }
//     X-Fanout-Hub: http://10.0.0.36:18080   <- keep this, see below
```

Task ids are hub-local, so reading the result back names the origin hub:

```jsonc
// GET      http://10.0.0.36:18082/api/tasks/<id>?hub=http://10.0.0.36:18080
// GET      …/api/tasks/<id>/result?hub=…      -> {"text","timing"}
// DELETE   …/api/tasks/<id>?hub=…              (cancel / remove the record)
// GET      …/api/tasks?hub=…&active=1          (list; active/modelId filters pass through)
```

- `?hub=` is **required** for every task read and must be a hub base URL from
  `/farm/health`; anything else is a `400`, and a hub the fan-out believes is
  down answers `502` immediately. The value is exactly the `X-Fanout-Hub`
  header from the submission (or the `hub` field of a `GET /api/instances`
  entry).
- The hub's own status and body are relayed verbatim — a `404` for an unknown
  task stays a hub-shaped `404`, and is *not* a failover signal.
- `request.audio` takes a **server-side file path** — it is **not** base64.
  Files not already on the box: `POST /api/audio/upload` with the raw WAV bytes
  (`Content-Type: audio/wav`, ≤50 MB) to that same hub → response includes
  `"path"`. The fan-out does not proxy uploads, so the path you get from `.36`
  only works for work routed to `.36`.
- Poll until `status` is `DONE` or `FAILED`; the transcript is in the `text`
  field (`GET .../result` serves the same `{"text","timing"}`).
- Same-instance tasks run **serially in submit order** — safe to fire many.
  The fan-out's `inFlight` cap applies to submission only.

### b) Hub-direct shapes (when you want to pin a hub)

Both still work against `http://10.0.0.36:18080` with the service name, and are
the right call when the audio file exists on that hub and nowhere else.

```jsonc
// POST /api/tasks
{ "instanceId": "<id from GET /api/instances where instanceName==citrinet>",
  "request": { "audio": "/abs/path/on/server.wav" } }

// POST /v1/tasks/run  (JSON, not multipart) — sync, small clips
{ "model": "citrinet", "audio": "/abs/path/on/server.wav" }
//  -> the engine's JSON response directly
```

`clients/audiocpp_client.py` still defaults to (b): `transcribe()` takes
`--direct-hub` / `AUDIOCPP_DIRECT_HUB_URL`. Point an agent that wants one base
URL at the shape in (a) instead.

### STT in Open WebUI

Open WebUI's built-in OpenAI STT cannot reach `citrinet` — neither shape above is
multipart, so OWUI would need an adapter that does not exist. Leave OWUI's STT
config alone and transcribe through the task API above. OWUI's **TTS** side does
work against the fan-out; wiring: [farm.md → Open WebUI TTS wiring](farm.md#open-webui--tts-wiring).

## 3. Minimal agent loop (pseudocode)

```
transcribe(sample)     -> text          # ASR for feedback   (:18082 /api/tasks, alias stt)
design(instruction, seed) -> wav        # TTS via the fan-out (:18082 /v1/audio/speech)
score(text, persona)   -> quality       # agent's own rubric / LLM judge
loop:
  for seed in seeds:
    wav, hdrs = design(instr, seed)     # hdrs["X-Fanout-Hub"] = origin hub
    txt = transcribe(wav)               # sanity: did it say the line?
    keep if score high; archive take    # already on the origin hub
  instr = mutate(instr)                 # next persona variant
```

Every hop is `:18082`; the `X-Fanout-Hub` header is what pins the follow-up reads
(history, task result) to the hub that owns the state.

`clients/audiocpp_client.py` implements the same loop with the two-URL split:
`speech_with_origin()` returns the headers, `transcribe()`/`voices()`/`history()`
take the direct hub (`transcribe()` is hub-direct shape (b) above).
`voice_sweep()` automates the seed loop.

## 4. Per-instance memory and task push (hub-direct)

`GET /api/instances` on a hub may include a `memory` object once the process
has been sampled. It is omitted entirely until the first RSS sample, and on
builds without `/proc` (non-Linux). VRAM fields are omitted when unknown —
never a placeholder zero.

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
  "vramSource": "nvidia-smi",
  "ramSeries": [637330636, 644245094],
  "vramSeries": [3906249728, 3865470566],
  "samples": 12,
  "sampledAt": 1756400000000,
  "busy": true
}
```

| field | meaning |
| --- | --- |
| `ramBytes` / `vramBytes` | current reading (process RSS / process VRAM) |
| `ramPeakBytes` / `vramPeakBytes` | maximum since the instance started |
| `ramAvgBytes` / `vramAvgBytes` | time-weighted average (see below) |
| `ramIdleBytes` / `vramIdleBytes` | **idle baseline**: the minimum observed while the instance had no RUNNING task — what the model costs at rest. Omitted until an idle sample exists |
| `vramTotalBytes` | total VRAM of the GPU the process runs on; it is the scale of the WebUI's VRAM bar. Only reported when the answer is certain: one GPU → that card's total; several GPUs with no process→card mapping → omitted |
| `vramSource` | `drm` or `nvidia-smi` |
| `ramSeries` / `vramSeries` | last at most 60 samples in bytes, oldest → newest, for the WebUI sparkline. Omitted when fewer than 2 points (one point draws no line). `vramSeries` is omitted entirely while VRAM has never been read — an unknown reading is not a zero. Each ring is a fixed 60-slot buffer, so the payload does not grow with instance lifetime |
| `samples` / `sampledAt` / `busy` | sample count / last sample (ms) / a task is RUNNING |

`ramAvgBytes` / `vramAvgBytes` are **time-weighted** (each sample is weighted by
how long it held until the next one), accumulated since the instance started.
`vramSource` is `drm` (Linux DRM fdinfo, de-duplicated by client id) or
`nvidia-smi`. `busy` means a task is RUNNING, which is also when the sampler
runs at about 1s instead of about 10s.

`vramTotalBytes` is best-effort and never fails the endpoint: NVIDIA reads
`nvidia-smi --query-gpu=index,memory.total` once per hub lifetime (same timeout
and backoff as the per-pid query — no extra spawn per pass), AMD reads
`/sys/class/drm/card*/device/mem_info_vram_total` once, and a totals query that
does not resolve to exactly one card leaves the field out rather than guessing.

`GET /api/tasks/{id}` adds optional `peakRamBytes` / `peakVramBytes`: the max
seen while that task was RUNNING. Absent when the sampler never got a reading.

`GET /api/events/stream` is Server-Sent Events, hub-local, **not proxied by
fan-out**. On connect the hub sends `event: hello` with `data: {}`, then a
`: ping` comment about every 15s. Task transitions arrive as:

```text
event: task.started
data: {"taskId":"ab12","instanceId":"cd34","modelId":"breeze-tts","category":"tts","ts":1756400000000}

event: task.finished
data: {"taskId":"ab12","instanceId":"cd34","modelId":"breeze-tts","category":"tts","ts":1756400004200,"ok":true,"durationMs":4100,"peakRamBytes":1073741824,"peakVramBytes":4402341478}

event: task.failed
data: {"taskId":"ab12","instanceId":"cd34","modelId":"breeze-tts","category":"tts","ts":1756400004200,"ok":false,"durationMs":800,"error":"audiocpp_server 返回 500: …"}
```

Also `task.queued` and `task.cancelled` (same base fields as `task.started`;
cancel has no `ok`). A slow client loses events instead of stalling the task.
`EventSource` reconnects on its own. While a task is running the hub may also
emit `instance.memory` (`instanceId`, `ramBytes`, `ts`, and `vramBytes` /
`vramSource` when known).

## 5. Operational notes

- `GET /v1/models` lists READY services — aliases on the fan-out, service names
  on a hub; `GET /api/instances` shows status/port (hubs' entries carry
  `instanceName`; the fan-out adds `hub` / `hubLabel`).
- Warm models (`breeze`, `sanotts`) never idle-unload — no cold-start tax on the
  client path. `citrinet` lazy-loads (~1 s) and unloads after 5 idle minutes.
- Queues are per-instance serial; there is no concurrency limit and no request
  timeout, but a long generation delays later jobs on the **same** instance only.
- LAN-only, no auth: put a reverse proxy with TLS + auth in front before any
  non-LAN exposure.
