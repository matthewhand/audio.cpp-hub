# fanout-proxy — LAN fan-out router for the voice farm

One OpenAI-shaped entrypoint in front of every `audio.cpp-hub` in the farm, so
agents stop hard-coding `host:port:model` triples. Tiny (stdlib only, ~4 files),
runs beside the hubs, and changes **nothing** on them.

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
| `GET` | `/farm/health` | per-hub up/down, latency, last error, instance list; per-route resolution + skip reasons + live `inFlight` per target |
| `GET` | `/api/instances` | aggregated instances of every **up** hub, each tagged with `hub` / `hubLabel` |
| `GET` | `/v1/models` | OpenAI list of the aliases that currently resolve to a READY backend |
| `POST` | `/v1/audio/speech` | routes by `model` alias, rewrites `model` to the upstream `instanceName`, streams the response, fails over down the target list |

Not proxied: history, voices, uploads, tasks, ASR/STT. Those stay on the origin
hub (see `X-Fanout-Hub`).

## Routing

`farm.routes.json` maps aliases to an ordered target list; the first target
whose hub is up **and** whose instance is `READY` wins.

| Alias | Targets (in order) |
|---|---|
| `breeze`, `expressive` | `.36:18080 breeze` → `.30:18080 breeze` |
| `qwen3-vd`, `voice-design-fast` | `.30:18081 qwen3-vd` |
| `sanotts`, `instant` | `.36:18080 sanotts` → `.32:18080 sanotts` |
| `citrinet`, `stt` | `.36:18080 citrinet` |

Request bodies are only ever touched in one place: the top-level `"model"`
string is replaced with the upstream service name. Every other field —
`options`, `voice_ref`, `reference_text`, unknown OpenAI extras, large integers
— is relayed byte-for-byte (`json.RawMessage` per field), so a rewrite can
never reformat or round a caller value.

## Knobs (`farm.routes.json`)

`hubs` / `routes` are the topology; the rest is tuning.

| Key | Default | Meaning |
|---|---|---|
| `listen` | `:18082` | bind address (`-listen` overrides it) |
| `pollIntervalMs` | `7000` | per-hub `GET /api/instances` period |
| `pollTimeoutMs` | `3000` | per-hub poll timeout |
| `maxBodyBytes` | `67108864` (64 MiB) | request body ceiling, same as the hub's `/api/*` limit |
| `maxInFlightPerTarget` | `2` | concurrent speech forwards per **origin target**; `<= 0` turns the cap off |
| `hubs` / `routes` | — | polled hubs, and alias → ordered target list |

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
  follow-up. Watch the single-target routes (`qwen3-vd`, `citrinet`): no standby
  to spill to, so a client firing more in parallel than the cap gets 429s.
- `GET /farm/health` reports the effective `inFlightCap` plus a live `inFlight`
  count per target, so a target about to start shedding is visible before it
  does. Note that `resolved` is the poll-cache answer (first READY target);
  under load the request may still land on the next one.

## Failure behavior

- A hub is polled every `pollIntervalMs` (7 s) and marked down after **2**
  consecutive failures; one successful poll restores it immediately.
- Failover happens on transport errors, `5xx`, `409` (hub: instance still
  starting) and `429`. A `4xx` is the caller's fault, so it is returned as-is
  without burning the remaining targets.
- A target sitting at `maxInFlightPerTarget` is skipped like a down hub, so
  traffic spills to the standby; only a route whose every usable target is busy
  sheds load with `429` + `Retry-After: 5`.
- Once response bytes have reached the client there is nothing to retry, so all
  retryable outcomes are detected before anything is written.
- Total failure returns `503` with the full trail:

```json
{
  "error": {
    "message": "No fan-out backend available for model expressive",
    "type": "server_error",
    "attempts": [{"hub": "http://10.0.0.36:18080", "instanceName": "breeze", "reason": "hub is down"}],
    "hubs_tried": ["http://10.0.0.36:18080"]
  }
}
```

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

- Successful responses carry `X-Fanout-Hub` and `X-Fanout-Instance` so an agent
  can pull the archived take from the origin hub's `/api/history/...`.

## Constraints this code keeps

- LAN only: no auth, no TLS, no WAN port publishing. The hubs stay untouched —
  no instance is started, stopped or re-configured from here.
- `.30`'s RX 6600 XT (`AUDIOCPP_DEVICE=0`, throwaway port `18180`) is never in
  the route table; the committed config is asserted against that in
  `config_test.go`.
- No request timeout: TTS generation is unbounded, and a client disconnect
  cancels the upstream request through the context.

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

Or with the stdlib client, which defaults to this endpoint for TTS and
discovery (`health` = the same view as `curl /farm/health`):

```bash
../../clients/audiocpp_client.py health
../../clients/audiocpp_client.py models
../../clients/audiocpp_client.py say "Fan-out check." -m instant -o /tmp/t.wav
# [fanout] http://10.0.0.36:18080 / sanotts   <- stderr: which hub served it
```

STT, upload, voices and history do **not** go through the fan-out — that client
keeps a second base URL for them (`--direct-hub`, default
`http://10.0.0.36:18080`).

In-flight cap, ~30 s, no config change needed: two concurrent calls on a
two-target route must split across hosts, and a single-target route past the cap
must answer `429` with `Retry-After`.

```bash
curl -s localhost:18082/farm/health | grep -E '"inFlightCap"|"inFlight"'   # cap + live counts
for i in 1 2; do
  curl -s -o /dev/null -D - --max-time 30 -X POST localhost:18082/v1/audio/speech \
    -H 'Content-Type: application/json' -d '{"model":"instant","input":"cap check"}' \
    | grep -i x-fanout-hub &                                    # .36 and .32, both 200
done; wait
curl -s -D - -o /dev/null -X POST localhost:18082/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"model":"instant","input":"cap check"}'                   # 200 again, slot released
```
