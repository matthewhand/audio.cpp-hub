# fanout-proxy — LAN fan-out router for the voice farm

One OpenAI-shaped entrypoint in front of every `audio.cpp-hub` in the farm, so
agents stop hard-coding `host:port:model` triples. Tiny (stdlib only, a handful
of source files), runs beside the hubs, and changes **nothing** on them.

- Design + decisions: [`../../docs/fanout-design.md`](../../docs/fanout-design.md)
- Farm topology: [`../../docs/farm.md`](../../docs/farm.md)
- Agent usage: [`../../docs/agent-api.md`](../../docs/agent-api.md)

Default endpoint: **`http://10.0.0.36:18082`** (LAN only, no auth, no TLS — see
[`SECURITY.md`](../../SECURITY.md) for the same warning that applies to the hubs).

## Build

Host may not have a Go toolchain; the golang image is enough:

```bash
docker run --rm -v "$PWD":/src -w /src -e CGO_ENABLED=0 -e GOFLAGS=-buildvcs=false \
  golang:1.27 go build -ldflags="-s -w" -o bin/fanout-proxy ./cmd/fanout-proxy
```

Static binary, no runtime dependencies. Checks:

```bash
docker run --rm -v "$PWD":/src -w /src golang:1.27 sh -c \
  'gofmt -l cmd/fanout-proxy; go vet ./cmd/fanout-proxy/... && go test -race ./cmd/fanout-proxy/...'
```

## Run

```bash
cd cmd/fanout-proxy
../../bin/fanout-proxy -config farm.routes.json          # foreground
FANOUT_CONFIG=/path/to/farm.routes.json ../../bin/fanout-proxy   # or via env
../../bin/fanout-proxy -config farm.routes.json -listen :18090    # port override
```

Flags: `-config` (default `$FANOUT_CONFIG`, else `farm.routes.json` in the
working directory), `-listen` (overrides the config address). Restarting is
always safe: state lives only in the poll cache, and hubs keep their own
history.

As a service, copy `audio-cpp-fanout.service` to `~/.config/systemd/user/`
(install notes are in that file's header). It is a **user** unit on purpose.

## Endpoints

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/farm/health` | per-hub up/down, latency, last error, instance list; per-route resolution + skip reasons + live `inFlight` and cumulative `served`/`failed` per target |
| `GET` | `/api/instances` | aggregated instances of every **up** hub, each tagged with `hub` / `hubLabel` |
| `GET` | `/v1/models` | OpenAI list of the aliases that currently resolve to a READY backend |
| `POST` | `/v1/audio/speech` | routes by `model` alias, rewrites `model` to the upstream `instanceName`, streams the response, fails over down the target list |
| `POST` | `/api/tasks` | routes by `model` alias (ASR: whichever alias you configure), rewrites the hub-local `instanceId`, fails over down the target list |
| `GET` | `/api/tasks`, `/api/tasks/{id}`, `/api/tasks/{id}/result`, `DELETE /api/tasks/{id}` | read-through to one hub, pinned with `?hub=<baseUrl>` |

Not proxied: history, voices, uploads, `/v1/tasks/run`. Those stay on the origin
hub (see `X-Fanout-Hub`).

## Routing

`farm.routes.json` maps aliases to a target list plus a **strategy** telling the
proxy how to consume it:

- `failover` (default) — priority order: the first target whose hub is up **and**
  whose instance is `READY` wins. Deterministic; the warm primary stays warm.
- `round_robin` — every usable target shares the traffic by `weight`, still
  failing over down the same list when the chosen target does not answer.

| Alias | Targets | Strategy |
|---|---|---|
| `breeze`, `expressive` | `.30:18080 breeze` | failover |
| `qwen3-vd`, `voice-design-fast` | `.30:18081 qwen3-vd` | failover |
| `sanotts`, `instant` | `.36:18080 sanotts` (single active target; Windows2 standby offline, [#127](https://github.com/matthewhand/audio.cpp-hub/issues/127)), `maxInputChars` 160 | failover |
| `kokoro` | `127.0.0.1:18280 kokoro` weight 1, `10.0.0.31:18088 kokoro-win1` weight 4 | round_robin |

No ASR route is configured on the current farm (the `citrinet` instance was
retired on 2026-11-25). The `/api/tasks` routing below still applies once you add
a route for the ASR instance you run.

Send `model: "kokoro"` to the fan-out. `kokoro_tts` is the model card ID.
`kokoro` is the one balanced route: `kokoro-win1` on Windows1
(`10.0.0.31:18088`, Vulkan on the GTX 1080) carries 4/5 of the traffic and the
loopback hub on Ubuntu-GTX carries 1/5. The split is measured, not guessed —
one sentence of the benchmark below takes ~0.7 s on the 1080, ~3.8 s on the GTX
host's CPU (and ~5.4 s on the same Windows box's RX 6600 XT, which is why that
device is not used). The loopback address assumes the fan-out runs on
Ubuntu-GTX; the [GTX deployment notes](../../docs/deployment-10.0.0.36.md#kokoro-loopback-hub)
describe the startup hook that establishes readiness. Either hub being down or
still starting is not an outage: the other one takes 100% of the traffic. Only
a hub restart moves a take's history — `X-Fanout-Hub` still names the origin.

### Balancing (`strategy` / `weight`)

A route is `failover` unless it says otherwise. Adding `"strategy":
"round_robin"` turns the same target list into a load split: each target gets a
`weight` (`1` when omitted) and the proxy picks with smooth weighted
round-robin, so weights `2` and `1` produce `A,B,A,A,B,A` rather than a bursty
`A,A,B`. Weights are relative — `2`/`1` and `20`/`10` behave alike.

- **Only usable targets rotate.** A hub that is down, an instance that is not
  `READY`, and a target at `maxInFlightPerTarget` all drop out, so a failed
  machine costs its share and nothing else.
- **The chosen target still fails over.** The rest of the list follows it in
  config order, so balancing is layered *on top of* the failover guarantee — a
  round-robin pick that errors spills to the next target exactly like a failover
  primary would. Availability never gets worse than the failover route.
- **State is in-process and per route.** The rotation restarts at the first
  target on restart. With the proxy on one host that is the whole farm; there is
  no cross-host coordination to get out of sync.
- **Failover-only routes ignore `weight`.** Normalisation pins it to `1`, so
  leaving a weight in place while switching strategy back is harmless.
- **The split is measurable.** `/farm/health` reports each target's cumulative
  `served` and `failed` (and the route's totals) since the process started
  (`countersSince`), so "is it really 2:1?" is one call, not a header-scraping
  loop. Counters reset on restart like any process-local number; they count
  forwards, not sentences, and a client disconnect after streaming counts as
  `failed` only if it broke mid-relay.
- A sticky/multi-seed audition that must land on one host is the opposite case:
  send it serially or pin the hub, because round-robin will deliberately split
  it.
### Long input (`maxInputChars`)

sanoTTS refuses an utterance well before an agent thinks it is long: a ~200
character paragraph fails with `phonemization produced no symbols in the
packaged vocabulary`, and a 100-digit run fails the 207-phoneme ceiling. A route
can therefore declare the per-utterance budget its engine actually has:

```jsonc
{ "aliases": ["sanotts", "instant"], "maxInputChars": 160, "targets": [...] }
```

When `input` is longer than that, `POST /v1/audio/speech` splits it at sentence
boundaries (a single over-long sentence falls back to clause, then word, then a
hard cut), synthesises the chunks in order on the *same* target and returns one
joined WAV — same `Content-Type`, real `Content-Length`, `X-Fanout-Chunks`
count. Nothing changes for a client: it is still one request and one file. If a
chunk fails, no bytes have been written yet, so the normal failover still walks
to the next target. Streamed requests (`"stream": true`) and non-WAV
`response_format` are never chunked: the hub's own sentence streaming owns the
first case, and a joined file has to be WAV.

Chunking is character-based, so it cannot rescue every input: a 100-digit run is
~340 phonemes in a 160-character chunk. Those still answer the engine's `400`
for a human to shorten.

An alias names a *service*; the endpoint names the *request shape*. TTS is
`/v1/audio/speech`, ASR is `/api/tasks`. A speech call against an ASR alias fails
(`503` — the engine wants an audio contract, not text); a task call against
`breeze` would run a TTS task. Nothing translates between shapes.

Request bodies are only ever touched in one place: the routing key. On
`/v1/audio/speech` that is the top-level `"model"` string, replaced with the
upstream service name; on `/api/tasks` it is the alias plus the origin hub's
`instanceId`, resolved from the same poll snapshot routing uses. Everything else
— `request`, `options`, `voice_ref`, `reference_text`, unknown OpenAI extras,
large integers — is relayed byte-for-byte (`json.RawMessage` per field), so a
rewrite can never reformat or round a caller value.

### STT (`POST /api/tasks`)

```jsonc
// POST :18082/api/tasks
{ "model": "stt", "request": { "audio": "/abs/path/on/server.wav" } }
//  -> 202 + the hub's task record, X-Fanout-Hub: http://10.0.0.36:18080
```

- **Reads are pinned.** Task ids are hub-local, so every follow-up names its hub:
  `GET /api/tasks/<id>?hub=<baseUrl>`, `…/result?hub=…`, `DELETE …?hub=…`,
  `GET /api/tasks?hub=…&active=1`. The pin is the `X-Fanout-Hub` value from the
  submission. A hub outside the config is a `400`, one the poll cache reports
  down is a `502` without dialing.
- **Reads are relayed verbatim** — a hub `404 TASK_NOT_FOUND` stays a `404`
  instead of becoming a fan-out envelope — and carry a 30 s ceiling; only a
  transport failure becomes a `502`. The forwards stay unbounded, because
  generation is.
- **Failover covers submission, not execution.** The hub enqueues and answers
  `202` at once; the ASR then runs where it was accepted. Reads never fail over.
- **The in-flight cap covers submission too** (see below): the slot is released
  as soon as the task is queued, so for ASR the cap limits how fast work is
  queued, not how much of it runs.
- `request.audio` is a **server-side path**, so it exists on the origin hub only.
  An ASR route is single-host today; if it ever grows a second host, a
  submission that fails over would name a file the standby cannot read and the
  task would come back `FAILED` rather than failing over again.
- If a submission is accepted but its response is lost, the proxy fails over and
  the work runs twice. ASR is idempotent, so the price is one wasted engine slot.

## Knobs (`farm.routes.json`)

`hubs` / `routes` are the topology; the rest is tuning.

| Key | Default | Meaning |
|---|---|---|
| `listen` | `:18082` | bind address (`-listen` overrides it) |
| `pollIntervalMs` | `7000` | per-hub `GET /api/instances` period |
| `pollTimeoutMs` | `5000` | per-hub poll timeout |
| `maxBodyBytes` | `67108864` (64 MiB) | request body ceiling, same as the hub's `/api/*` limit |
| `maxInFlightPerTarget` | `2` | concurrent speech forwards per **origin target**; `<= 0` turns the cap off |
| `hubs` / `routes` | — | polled hubs, and alias → target list |
| `routes[].strategy` | `failover` | `failover` (priority order) or `round_robin` (weighted split over usable targets) |
| `routes[].targets[].weight` | `1` | round-robin share; ignored by a failover route |

### `maxInFlightPerTarget` — the per-origin in-flight cap

A hub runs one engine per instance and its task queue is serial, so without a
cap one noisy agent fills an instance's queue while every other agent waits
there invisibly — and the farm still looks healthy in `/farm/health`. The proxy
therefore admits at most `maxInFlightPerTarget` in-flight forwards per origin
target (hub base URL + service name):

- A target **at its cap** counts as unusable, so the request spills to the next
  target in the route (`.36 breeze` → `.30 breeze`).
- Only when *every* usable target of the route is busy does the call get
  `429 Too Many Requests` + `Retry-After: 5` + `type: rate_limit_error`. That is
  load shedding, deliberately distinct from the `503` of a real outage. OpenAI
  SDKs retry `429` on their own; a client that would rather queue than fail can
  set `"maxInFlightPerTarget": -1`.
- The default of `2` still lets one client overlap a request with its own
  follow-up. Watch the single-target routes (`qwen3-vd`, `sanotts`): no standby
  to spill to, so a client firing more in parallel than the cap gets 429s.
- For `POST /api/tasks` the slot covers the submit round trip and is released
  while the task still runs — the hub's own serial queue is what bounds
  execution, so the cap limits how fast work is *queued*.
- `GET /farm/health` reports the effective `inFlightCap` plus a live `inFlight`
  count per target, so a target about to start shedding is visible before it
  does. Note that `resolved` is the poll-cache answer (first READY target, with
  each target's `weight` and the route's `strategy` alongside); a round-robin
  route rotates past it, and under load any route may still land on the next
  target.

## Failure behavior

Same rules for both forwarded endpoints (`POST /v1/audio/speech`,
`POST /api/tasks`); only the body rewrite differs.

- A hub is polled every `pollIntervalMs` (7 s) and marked down after **2**
  consecutive failures; one successful poll restores it immediately.
- Failover happens on transport errors, `5xx`, `409` (hub: instance still
  starting) and `429`. A `4xx` is the caller's fault, so it is returned as-is
  without burning the remaining targets. A task submission additionally skips a
  target whose poll snapshot has no `instanceId` for the service.
- A target sitting at `maxInFlightPerTarget` is skipped like a down hub, so
  traffic spills to the next target (the standby on a failover route, another
  host's share on a round-robin one); only a route whose every usable target is
  busy sheds load with `429` + `Retry-After: 5`.
- Once response bytes have reached the client there is nothing to retry, so all
  retryable outcomes are detected before anything is written.
- Task **reads** are not a failover case at all: the pin names one hub, and the
  hub's own status is passed through.
- Two different total failures, because agents retry them differently:
  - **`503`** when there was nothing to try (every target skipped: hub down,
    instance not `READY`), with the full trail:

```json
{
  "error": {
    "message": "No fan-out backend available for model expressive",
    "type": "server_error",
    "attempts": [{"hub": "http://10.0.0.36:18080", "instanceName": "breeze", "reason": "hub is down"}],
    "hubs_tried": ["http://10.0.0.36:18080"],
    "inFlightCap": 2
  }
}
```

  - **`502`** when targets were reachable and every one failed: the farm is up,
    the backends are not producing audio. Same trail plus `lastError`.

- An input the engine itself refuses (sanoTTS's 207-phoneme ceiling,
  "phonemization produced no symbols") answers **`400` with the engine's own
  message** and does not try the other targets: the same text would fail there
  identically, and `503` would blame the farm for a request the caller must
  change. The `hint` field says how.

- Load shedding (every usable target busy) returns `429` with the same trail plus
  `inFlightCap`, so a client can tell "come back in a moment" from "the farm is
  broken":

```json
{
  "error": {
    "message": "All fan-out backends for model voice-design-fast are at their in-flight cap",
    "type": "rate_limit_error",
    "attempts": [{"hub": "http://10.0.0.30:18081", "instanceName": "qwen3-vd", "reason": "at in-flight cap (1)"}],
    "hubs_tried": ["http://10.0.0.30:18081"],
    "inFlightCap": 1
  }
}
```

- The engine's own observability headers are repeated unchanged, so the fan-out
  is not a black hole for timing: `X-Audiocpp-Wall-Ms`,
  `X-Audiocpp-Audio-Duration-Ms`, `X-Audiocpp-Rtf` (engine), plus `X-Hub-Request-Id`
  and `X-Hub-Stream` (hub) and the `X-Audio-*` PCM framing hints. They are also
  added to `Access-Control-Expose-Headers`, so a browser can read them. A
  chunked reply (below) carries `X-Fanout-Chunks` and `X-Fanout-Wall-Ms`
  instead: the per-chunk engine numbers do not describe the joined file.
- Successful responses carry `X-Fanout-Hub` and `X-Fanout-Instance` so an agent
  can pull the archived take from the origin hub's `/api/history/...` — and, for
  `POST /api/tasks`, name that hub in the `?hub=` pin of every task read.
  For Kokoro, `X-Fanout-Hub` and the aggregated instance's `hub` contain
  `http://127.0.0.1:18280`. Remote clients keep this value unchanged as an
  opaque pin in task URLs sent to the **fan-out**. Download the speech audio
  from the original response. The archive at
  `/api/history/kokoro_tts/<taskId>/audio` belongs to the loopback hub and
  can be read from Ubuntu-GTX.

## Constraints this code keeps

- LAN only: no auth, no TLS, no WAN port publishing. The hubs stay untouched —
  no instance is started, stopped or re-configured from here.
- `.30`'s RX 6600 XT (`AUDIOCPP_DEVICE=0`, throwaway port `18180`) is never in
  the route table; the committed config is asserted against that in
  `config_test.go`.
- No request timeout on a forward: TTS generation is unbounded, and a client
  disconnect cancels the upstream request through the context. Task *reads* are
  the exception (30 s) — they have no side effects, so a stuck hub must not be
  able to pin the request open.

## Smoke test

```bash
curl -s localhost:18082/farm/health | python3 -m json.tool | head -40
curl -s localhost:18082/v1/models
curl -s localhost:18082/api/instances | python3 -m json.tool | head
curl -s -D - -o /tmp/t.wav -X POST localhost:18082/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"model":"expressive","input":"Fan-out check.","options":{"instruction":"Dry, unimpressed female voice"}}'
grep -i x-fanout <(curl -s -D - -o /dev/null -X POST localhost:18082/v1/audio/speech \
  -H 'Content-Type: application/json' -d '{"model":"instant","input":"check"}')
```

Engine timing and the hub request id come back through the fan-out, so latency is
one call, not a second trip to the origin hub:

```bash
curl -s -D - -o /dev/null -X POST localhost:18082/v1/audio/speech \
  -H 'Content-Type: application/json' -d '{"model":"instant","input":"check"}' \
  | grep -iE 'x-audiocpp|x-hub-request-id'
# X-Audiocpp-Wall-Ms: 16.641510      <- engine, not proxy, time
# X-Audiocpp-Audio-Duration-Ms: 1290.666667
# X-Audiocpp-Rtf: 0.012894
# X-Hub-Request-Id: 5db0e-49         <- /api/metrics/requests/5db0e-49 on that hub
```

Long input on a chunked route (`sanotts` / `instant`, `maxInputChars` 160) is
split at sentences and joined, so a paragraph that used to 500 answers 200:

```bash
curl -s -D - -o /tmp/long.wav -X POST localhost:18082/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"model":"instant","input":"A long paragraph used to be refused by the engine once it passed the phoneme ceiling. The fan-out now splits it at sentence boundaries instead, synthesises each sentence in order on the same target, and returns one joined WAV. Every sentence here is deliberately ordinary."}' \
  | grep -i 'x-fanout-chunks\|content-length'
# Content-Length: 870444     <- the joined file, 18.133 s at 24 kHz mono
# X-Fanout-Chunks: 3         <- 272 characters: three sentences, three chunks
```

The input has to actually exceed the route's budget: 272 characters against
`maxInputChars` 160 chunks, while a one-line "check" stays a single chunk and
carries no `X-Fanout-Chunks` at all.

STT round trip through the fan-out. `request.audio` is a path on the hub that
serves it, so generate a take first and transcribe that file (both land on the
same host). Replace `stt` below with the ASR alias you configure — none is
shipped on the current farm:

```bash
curl -s -X POST localhost:18082/v1/audio/speech -H 'Content-Type: application/json' \
  -d '{"model":"instant","input":"The fan out handles transcription too."}' -o /tmp/stt-check.wav
curl -s http://10.0.0.36:18080/api/audio/upload -H 'Content-Type: audio/wav' \
  --data-binary @/tmp/stt-check.wav                    # -> {"ok":true,"data":{"path":"…"}}
curl -s -D - -o /dev/null -X POST localhost:18082/api/tasks -H 'Content-Type: application/json' \
  -d '{"model":"stt","request":{"audio":"<path from the upload>"}}' | grep -i x-fanout-hub
# 202 + X-Fanout-Hub: http://10.0.0.36:18080
curl -s "localhost:18082/api/tasks/<id>?hub=http://10.0.0.36:18080"   # poll to DONE, then …/result
curl -s "localhost:18082/api/tasks/<id>/result?hub=http://10.0.0.36:18080"
curl -s -X DELETE "localhost:18082/api/tasks/<id>?hub=http://10.0.0.36:18080"
```

Without the `?hub=` pin the read is a `400` that lists the known hubs, and a hub
the fan-out thinks is down is a `502` — both answers to check when debugging an
agent that "lost" its transcript.

Or with the stdlib client, which defaults to this endpoint for TTS and
discovery (`health` = the same view as `curl /farm/health`):

```bash
../../clients/audiocpp_client.py health
../../clients/audiocpp_client.py models
../../clients/audiocpp_client.py say "Fan-out check." -m instant -o /tmp/t.wav
# [fanout] http://10.0.0.36:18080 / sanotts   <- stderr: which hub served it
```

STT, upload, voices and history still go through that client's second base URL
(`--direct-hub`, default `http://10.0.0.36:18080`) — the fan-out serves STT, but
the shipped client has not been switched over to it.

In-flight cap, ~30 s, no config change needed: `instant` now has one
active target (`.36`), so both concurrent calls may resolve there (cap 2).
A third in-flight request past the cap gets `429` with `Retry-After`;
these commands do not prove that limit unless the first two remain active.

```bash
curl -s localhost:18082/farm/health | grep -E '"inFlightCap"|"inFlight"'   # cap + live counts
for i in 1 2; do
  curl -s -o /dev/null -D - --max-time 30 -X POST localhost:18082/v1/audio/speech \
    -H 'Content-Type: application/json' -d '{"model":"instant","input":"cap check"}' \
    | grep -i x-fanout-hub &                                    # both may use .36; Windows2 .32 is offline
done; wait
curl -s -D - -o /dev/null -X POST localhost:18082/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"model":"instant","input":"cap check"}'                   # 200 again, slot released
```
