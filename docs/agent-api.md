# Agent API — using this hub from an AI agent / automation

Audience: an autonomous agent (or script) on the LAN that wants to **generate speech
in a variety of voice designs** and **transcribe audio** against this hub.

- **Base URL: `http://10.0.0.36:18082`** — the LAN fan-out proxy, i.e. one URL for
  the whole farm with automatic failover. Use it for TTS and discovery. LAN-only,
  no auth — never expose publicly.
- Secondary URL: `http://10.0.0.36:18080` — a single hub, required for the routes
  the fan-out does not proxy (STT/async tasks, upload, voices, history), because
  each hub owns that state. See [Unified fan-out base URL](#unified-fan-out-base-url).
- All bodies are JSON unless stated otherwise
- Error bodies: `{"error": {"code", "params", "message"}}` (API routes) or
  `{"error": {"message", "type"}}` (`/v1/*` proxy routes)

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
| `citrinet`, `stt` | `.36:18080 citrinet` (TTS shape only — see below) |

- `GET /v1/models` — only the aliases that currently have a working backend.
- `GET /api/instances` — every hub's instances in one list, each entry tagged with
  its `hub` / `hubLabel`. Ids are hub-local, so they are not usable for
  `/api/tasks` on another host.
- Successful responses add `X-Fanout-Hub` / `X-Fanout-Instance`; use the hub
  there to fetch the archived take from `/api/history/...`.
- `GET /farm/health` — per-hub up/down, latency, which backend each alias
  resolved to, and each target's live `inFlight` against `inFlightCap`.
  Fan-out only; hubs answer 404.
- **Fairness cap:** at most `maxInFlightPerTarget` (default 2) speech forwards
  may be in flight per hub+service. A busy target is skipped, so the call spills
  to the standby; when *every* target of the route is busy you get `429` +
  `Retry-After: 5` (`type: rate_limit_error`) instead of a `503`. Treat that as
  "retry shortly", not as an outage — OpenAI SDKs already retry `429` by default.
  Fan out over time or raise the cap server-side; only the single-target routes
  (`qwen3-vd` / `voice-design-fast`) have nowhere to spill to.
- **Not proxied:** `/api/history/*`, `/api/voices/*`, `/api/audio/upload`,
  `/api/tasks*` and therefore STT. Keep using `:18080` for those. The `citrinet`
  alias exists so the route table and `/farm/health` cover the ASR box, but a
  `/v1/audio/speech` call against it fails (503 — the engine wants an audio
  contract, not text). Transcribe through the hub's task API instead.
- Fan-out is LAN-only with no auth, exactly like the hubs.


## Instances used here

| Service name (`model` on `:18080`) | Model | Task | Warm policy | Fan-out alias |
|---|---|---|---|---|
| `breeze` | breeze-tts | expressive TTS / voice design | always warm | `breeze`, `expressive` |
| `sanotts` | SanoTTS (heart-nano) | ultra-fast TTS | always warm | `sanotts`, `instant` |
| `citrinet` | Citrinet ASR | STT | lazy, unloads after 5 min idle | `citrinet`, `stt` (TTS unusable) |

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

Hub-only: the fan-out does not proxy `/api/tasks`, so STT goes to
`http://10.0.0.36:18080` with the service name `citrinet`.

Two supported shapes. **Note:** OpenAI-style `POST /v1/audio/transcriptions`
(multipart) is **not available** — the proxy routes by the top-level `"model"`
of a JSON body and returns 400 for multipart. Use one of these instead:

### a) Async task API (recommended; any audio size)

```jsonc
// POST /api/tasks
{ "instanceId": "<id from GET /api/instances where instanceName==citrinet>",
  "request": { "audio": "/abs/path/on/server.wav" } }
```

- `request.audio` takes a **server-side file path** — it is **not** base64.
- Files not already on the box: `POST /api/audio/upload` with the raw WAV bytes
  (`Content-Type: audio/wav`, ≤50 MB) → response includes `"path"`.
- Poll `GET /api/tasks/<id>` until `status` is `DONE` or `FAILED`; the transcript
  is in the `text` field (also `GET /api/tasks/<id>/result` → `{"text","timing"}`).
- `DELETE /api/tasks/<id>` cancels queued work or removes the record.
- Same-instance tasks run **serially in submit order** — safe to fire many.

### b) Sync JSON proxy (small clips, script-friendly)

The engine also accepts a plain JSON body on its native endpoint via the proxy:

```jsonc
// POST /v1/tasks/run  (JSON, not multipart)
{ "model": "citrinet", "audio": "/abs/path/on/server.wav" }
```

which returns the engine's JSON response (`{"text", "timing"}`) directly.

### STT in Open WebUI

Open WebUI's built-in OpenAI STT cannot reach `citrinet` — neither shape above is
multipart, so OWUI would need an adapter that does not exist. Leave OWUI's STT
config alone and transcribe through the task API above. OWUI's **TTS** side does
work against the fan-out; wiring: [farm.md → Open WebUI TTS wiring](farm.md#open-webui--tts-wiring).

## 3. Minimal agent loop (pseudocode)

```
transcribe(sample)     -> text          # ASR for feedback   (:18080 task API)
design(instruction, seed) -> wav        # TTS via the fan-out (:18082)
score(text, persona)   -> quality       # agent's own rubric / LLM judge
loop:
  for seed in seeds:
    wav, hdrs = design(instr, seed)     # hdrs["X-Fanout-Hub"] = origin hub
    txt = transcribe(wav)               # sanity: did it say the line?
    keep if score high; archive take    # already on the origin hub
  instr = mutate(instr)                 # next persona variant
```

`clients/audiocpp_client.py` implements exactly this split:
`speech_with_origin()` returns the headers, `transcribe()`/`voices()`/`history()`
take the direct hub. `voice_sweep()` automates the seed loop.

## 4. Operational notes

- `GET /v1/models` lists READY services — aliases on the fan-out, service names
  on a hub; `GET /api/instances` shows status/port (hubs' entries carry
  `instanceName`; the fan-out adds `hub` / `hubLabel`).
- Warm models (`breeze`, `sanotts`) never idle-unload — no cold-start tax on the
  client path. `citrinet` lazy-loads (~1 s) and unloads after 5 idle minutes.
- Queues are per-instance serial; there is no concurrency limit and no request
  timeout, but a long generation delays later jobs on the **same** instance only.
- LAN-only, no auth: put a reverse proxy with TLS + auth in front before any
  non-LAN exposure.
