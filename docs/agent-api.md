# Agent API — using this hub from an AI agent / automation

Audience: an autonomous agent (or script) on the LAN that wants to **generate speech
in a variety of voice designs** and **transcribe audio** against this hub.

- Base URL: `http://10.0.0.36:18080` (LAN-only service, no auth — never expose publicly)
- Optional single entrypoint: `http://10.0.0.36:18082` — the LAN fan-out proxy,
  same request/response shapes plus automatic failover across the farm
  (`breeze`/`expressive`, `qwen3-vd`/`voice-design-fast`, `sanotts`/`instant`,
  `citrinet`/`stt`). TTS only; history, voices and STT still live on `:18080`.
  See [Unified fan-out base URL](#unified-fan-out-base-url) below.
- All bodies are JSON unless stated otherwise
- Error bodies: `{"error": {"code", "params", "message"}}` (API routes) or
  `{"error": {"message", "type"}}` (`/v1/*` proxy routes)

## Unified fan-out base URL

`http://10.0.0.36:18082` fronts every hub in the farm (`docs/farm.md`), so an
agent can speak model **aliases** instead of `host:port:service` triples:

```jsonc
// POST http://10.0.0.36:18082/v1/audio/speech
{ "model": "expressive", "input": "…", "options": { "instruction": "…" } }
//  -> .36 breeze, or .30 breeze if .36 is down / not READY
```

- `GET /v1/models` — only the aliases that currently have a working backend.
- Successful responses add `X-Fanout-Hub` / `X-Fanout-Instance`; use the hub
  there to fetch the archived take from `/api/history/...`.
- `GET /farm/health` — per-hub up/down and which backend each alias resolved to.
- Not proxied: `/api/history/*`, `/api/voices/*`, `/api/audio/upload`,
  `/api/tasks*` and STT. Keep using `:18080` for those.
- Fan-out is LAN-only with no auth, exactly like the hubs.


## Instances used here

| Service name (`model`) | Model | Task | Warm policy |
|---|---|---|---|
| `breeze` | breeze-tts | expressive TTS / voice design | always warm |
| `sanotts` | SanoTTS (heart-nano) | ultra-fast TTS | always warm |
| `citrinet` | Citrinet ASR | STT | lazy, unloads after 5 min idle |

Registered reference voices (voice library): `persona_vex` (dry sarcastic
female), `persona_gruff` (gravelly amused male), `persona_sunny` (bright fast
female), `persona_deadpan` (flat monotone male) — seed-42 breeze designs,
STT-verified, each with its exact transcript stored as `text`.

## 1. Text → speech (voice design)

`POST /v1/audio/speech` — synchronous; response body is raw WAV bytes.

```jsonc
{
  "model": "breeze",            // or "sanotts"
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

### Where results are archived

**Every successful TTS generation is archived** under `data/history/<modelId>/` —
both the async task flow and the synchronous `/v1/audio/speech` proxy (the proxy
te-es the response audio into history on the fly):

- `GET /api/history/breeze-tts` — newest-first list (id, truncated text, refs)
- `GET /api/history/breeze-tts/<taskId>/audio` — the WAV itself
- `GET /api/history/breeze-tts/<taskId>` — full record incl. the request
  (instruction/seed/voice_ref when sent) so any take can be reproduced exactly

Sync-proxy records carry `result.via: "v1/audio/speech"`; the Web UI history
panel lists and plays them like any other take. Failed or client-interrupted
calls are not archived.

## 2. Speech → text (STT)

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

## 3. Minimal agent loop (pseudocode)

```
transcribe(sample)     -> text          # ASR for feedback
design(instruction, seed) -> wav        # breeze voice design
score(text, persona)   -> quality       # agent's own rubric / LLM judge
loop:
  for seed in seeds:
    wav = design(instr, seed)
    txt = transcribe(wav)              # sanity: did it say the line?
    keep if score high; archive take   # history already stored it
  instr = mutate(instr)                # next persona variant
```

## 4. Operational notes

- `GET /v1/models` lists READY services; `GET /api/instances` shows status/port.
- Warm models (`breeze`, `sanotts`) never idle-unload — no cold-start tax on the
  client path. `citrinet` lazy-loads (~1 s) and unloads after 5 idle minutes.
- Queues are per-instance serial; there is no concurrency limit and no request
  timeout, but a long generation delays later jobs on the **same** instance only.
- LAN-only, no auth: put a reverse proxy with TLS + auth in front before any
  non-LAN exposure.
