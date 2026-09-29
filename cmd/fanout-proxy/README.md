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
| `GET` | `/farm/health` | per-hub up/down, latency, last error, instance list; per-route resolution + skip reasons |
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

## Failure behavior

- A hub is polled every `pollIntervalMs` (7 s) and marked down after **2**
  consecutive failures; one successful poll restores it immediately.
- Failover happens on transport errors, `5xx`, `409` (hub: instance still
  starting) and `429`. A `4xx` is the caller's fault, so it is returned as-is
  without burning the remaining targets.
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
