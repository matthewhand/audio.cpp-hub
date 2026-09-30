# Fan-out design

Status: **implemented** (option B) — `cmd/fanout-proxy/`, shipped 2026-09-30.
Decisions below are as built; superseded drafts are kept only where they explain
*why* (e.g. the 6600 XT verdict).

## Goal

Give LAN agents one stable entrypoint for TTS/ASR across the multi-host farm
without exposing ports to WAN, without breaking warm instances on `.36`
(`breeze` / `sanotts` with `idleUnloadMs=0`), and without requiring each agent
to hard-code host:port:model triples.

Live entrypoint: **`http://10.0.0.36:18082`**.

## Current farm (source of truth: `docs/farm.md`)

| Host | Endpoint | Model / service | Backend | Role |
|---|---|---|---|---|
| `10.0.0.36:18080` | systemd hub | `breeze`, `sanotts`, `citrinet` | Vulkan GTX 1080 | Primary expressive + fast TTS + STT |
| `10.0.0.30:18080` | Docker `audio-cpp-hub-amd` | `breeze` | Vulkan iGPU DEVICE=1 | Standby breeze |
| `10.0.0.30:18081` | Docker `audio-cpp-hub-amd-qwen3` | `qwen3-vd` | Vulkan iGPU DEVICE=1 | Fast voice-design (`instruct`) |
| `10.0.0.32:18080` | Docker CPU | `sanotts` | CPU | Instant TTS overflow |

RX 6600 XT (`AUDIOCPP_DEVICE=0` on `.30`) remains **unusable** for inference
(see verdict below). Keep live hubs on device 1, and keep the 6600 XT out of
`farm.routes.json`.

## Options considered

### A — Hub-side remote routing (extend audio.cpp-hub)

Add a config block listing remote hubs to the hub itself: aggregate
`/api/instances` + `/v1/models`, route `/v1/audio/speech` and `/api/tasks`,
own failover and the health cache. Pros: single binary, coherent history/UI.
Cons: code change in the hub that must not disturb warm-policy behavior, and
remote latency/failure modes inside the hub process. **Deferred** — revisit only
if agents need unified history or UI.

### B — Tiny LAN proxy (implemented)

A separate small router process beside the hubs that polls each hub's
`/api/instances`, exposes one OpenAI-shaped surface, and maps `model` → ordered
backend list with failover. Zero change to the warm hubs; trivially torn down;
ships as its own binary (`cmd/fanout-proxy`) and its own systemd **user** unit.

## Resolved decisions (were open questions in the draft)

1. **Tiny proxy (B), on `.36`** — the host that already runs the systemd hub, so
   there is one box to reason about. Not hub-native (A).
2. **History stays per-hub** — the proxy does not aggregate, mirror or forward
   history/voices/tasks. Every response carries `X-Fanout-Hub` /
   `X-Fanout-Instance`, which is all an agent needs to fetch the archived take
   from the origin hub's `/api/history/...`. Unified history is an A-side
   project if it is ever needed.
3. **New port `:18082`** — hubs keep `:18080`/`:18081`; agents that only need
   one host change nothing, agents that want failover switch base URL to
   `http://10.0.0.36:18082`.

## Model / host selection (agent-facing)

Agents pick by **capability alias**, not raw host. Aliases are case-insensitive
and both spellings in a pair resolve to the same target list.

| Alias | Preferred | Failover |
|---|---|---|
| `breeze` / `expressive` | `.36` `breeze` | `.30:18080` `breeze` |
| `qwen3-vd` / `voice-design-fast` | `.30:18081` `qwen3-vd` | none |
| `sanotts` / `instant` | `.36` `sanotts` | `.32:18080` `sanotts` |
| `citrinet` / `stt` | `.36` `citrinet` | none (only host that has it) |

Rules baked into the implementation:

- Never start/stop/re-configure an instance from the proxy; warm policy on
  `.36` is untouched (`idleUnloadMs=0` stays).
- `.30` DEVICE=0 (6600 XT) is not routable, so `qwen3-vd` has no fallback: the
  draft's "`.36` breeze with `instruct` → `options.instruction`" idea was
  **dropped**, because the proxy's only body edit is the `model` string and
  translating request schemas across engines is exactly the kind of surprise a
  tiny router must not introduce. Agents asking for `qwen3-vd` get a clear
  `503` instead of a different model wearing the same name.
- `citrinet` / `stt` are listed for discoverability only: STT is served through
  the hub's async `POST /api/tasks` flow, which the proxy does not expose yet.
  See "Not proxied" below.

## Endpoints

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/farm/health` | per-hub `ok`/`latencyMs`/`failures`/`lastError`/instances, per-route `resolved` + skip reasons |
| `GET` | `/api/instances` | aggregated instances of every up hub, each tagged `hub` / `hubLabel` |
| `GET` | `/v1/models` | OpenAI list, only aliases whose route currently has a READY target |
| `POST` | `/v1/audio/speech` | route by `model` alias → rewrite `model` → stream response → failover, with a per-origin in-flight cap |

**Not proxied** (deliberate): `/api/history/*`, `/api/voices/*`,
`/api/audio/upload`, `/api/tasks*`, `/v1/tasks/run`. Those need per-origin paths
or server-side file access, so they stay on the origin hub.

## Health aggregation

`GET /farm/health` returns the shape sketched in the draft:

```jsonc
{
  "ok": true,
  "updatedAt": "2026-09-30T07:10:19Z",
  "hubsUp": 4, "hubsTotal": 4, "readyAliases": 8, "inFlightCap": 2,
  "hubs": [
    { "baseUrl": "http://10.0.0.36:18080", "label": "gtx1080-primary", "ok": true,
      "latencyMs": 0, "failures": 0, "lastError": "", "checkedAt": "…",
      "instances": [ /* passthrough of /api/instances */ ] }
  ],
  "routes": [
    { "aliases": ["breeze", "expressive"], "resolved": "http://10.0.0.36:18080/breeze",
      "targets": [{ "hub": "http://10.0.0.36:18080", "instanceName": "breeze", "skipped": "", "inFlight": 1 },
                  { "hub": "http://10.0.0.30:18080", "instanceName": "breeze", "skipped": "", "inFlight": 0 }] }
  ],
  "knownAliases": ["breeze", "citrinet", "expressive", "instant", "qwen3-vd", "sanotts", "stt", "voice-design-fast"]
}
```

- Probe: `GET /api/instances` every 7 s per hub, in parallel, 3 s timeout.
- A hub is marked **down after 2 consecutive failures**; one successful poll
  restores it immediately. One blip never moves traffic off a warm primary.
- A target is usable only if its hub is up *and* that hub reports the instance
  `READY` — a lazy-loading `citrinet` on `.36` is skipped until it is warm.
- `inFlight` per target is a live count (not from the poll cache), shown next to
  the effective `inFlightCap` so a target about to start shedding is visible
  before it does. `resolved` stays the poll-cache answer: first READY target,
  regardless of load.

## Failure / failover

1. Target unusable per the poll cache (hub down, instance not READY) → next
   target, recording the skip reason.
2. Target at its per-origin in-flight cap → next target, same as above (see
   "Fairness" below).
3. Transport error, `5xx`, `409` (hub: instance still starting) or `429` → next
   target. A `4xx` is the caller's fault, so it is returned as-is without
   burning the remaining targets.
4. Once any response byte has reached the client there is nothing to retry, so
   every retryable outcome is detected before the first write.
5. Total failure → `503` with the trail, no guessing:

```json
{"error": {"message": "No fan-out backend available for model expressive",
           "type": "server_error",
           "attempts": [{"hub": "http://10.0.0.36:18080", "instanceName": "breeze", "reason": "hub is down"}],
           "hubs_tried": ["http://10.0.0.36:18080"]}}
```

6. Never reboot hosts or republish ports to WAN as part of recovery. The proxy
   is LAN-only and has no auth/TLS.

## Fairness — per-origin in-flight cap

A hub runs one engine per instance and its task queue is serial, so an uncapped
router lets a single loud agent occupy a target's only engine slot while every
other agent queues there invisibly — the farm still reports healthy and the
stall shows up nowhere in `/farm/health`. Hence one knob,
`maxInFlightPerTarget` (default `2`, `<= 0` disables): at most N speech
forwards may be in flight per hub+service, counted only inside this process
(no cross-host coordination, which is not needed — the hub's own queue already
serializes per instance).

Decisions taken:

- A capped target is **skipped, not queued**, so load moves to the standby
  instead of piling up behind one instance. Only when every usable target of a
  route is busy does the call get `429` + `Retry-After: 5` +
  `type: rate_limit_error` — shedding, kept distinct from the `503` of a real
  outage, with the usual attempts trail plus `inFlightCap`.
- `429` is already in the retryable set for *upstream* answers, so a hub that
  sheds on its own still fails over to the next target.
- Default `2` (not `1`) so one client can overlap a request with its own
  follow-up. Single-target routes (`qwen3-vd`, `citrinet`) therefore shed past
  two in parallel; OpenAI SDKs retry `429` by default, and the knob is there for
  clients that would rather queue.
- The slot is held for the whole forward, streaming included, and released on
  every exit path (success, upstream failure, client disconnect) so a cap can
  never wedge a target.

## Implementation

- `cmd/fanout-proxy/` — own `package main`, stdlib only, so the hub root package
  is untouched. `config.go` (farm.routes.json + validation), `health.go` (poll
  cache + down threshold), `router.go` (model rewrite, target planning,
  in-flight limiter, streaming forward), `main.go` (flags, handlers).
- `cmd/fanout-proxy/farm.routes.json` — the committed farm topology.
- `cmd/fanout-proxy/audio-cpp-fanout.service` — systemd **user** unit template
  (install notes in the file header); nothing is enabled automatically.
- `cmd/fanout-proxy/README.md` — build / run / endpoints / knobs / smoke test.
- Table-driven unit tests cover alias resolution, target planning and failover
  (including httptest stand-ins for two hubs), the 2-failure down threshold, the
  body rewrite, the in-flight cap (spill, `429` shedding, slot release, nil and
  `cap <= 0` safety), and the committed route table.
- Agent-facing contract: `docs/agent-api.md`. Farm table: `docs/farm.md`.

## RX 6600 XT throwaway verdict (2026-09-30, unchanged)

Throwaway container `audio-cpp-hub-amd-6600xt-throwaway` on `.30`:

- Image/pattern: same as `audio-cpp-hub:amd` / compose.amd.yaml
- `AUDIOCPP_DEVICE=0`, ephemeral port `18180`, tmp state under
  `/tmp/audiocpp-6600xt-throwaway`, `--restart=no`
- Live containers (`audio-cpp-hub-amd`, `audio-cpp-hub-amd-qwen3` on
  DEVICE=1) left untouched and stayed READY
- Result: instance reached **READY** quickly, but **warmup TTS timed out**
  (~60 s) → hub returned 502 and exited (exit 1). No successful WAV.
- Explicit `vk::Queue::submit: ErrorDeviceLost` / `radv: CS cancelled`
  strings were **not** captured in hub docker logs this run (engine stderr
  may not be forwarded); behavior matches the known DEVICE=0 failure mode
  documented in `farm.md` (hang / device loss mid-inference).
- Cleanup: container removed, `/tmp/audiocpp-6600xt-throwaway` deleted.
  No junk volumes left.

**Verdict: still FAIL for production.** Keep DEVICE=1 for live `.30` hubs.
Retry DEVICE=0 only after GPU driver/kernel update, again in a throwaway.

## Non-goals

- Changing warm `idleUnloadMs` on `.36`
- Deleting or remounting `~/audio.cpp/` on `.30`
- Shipping 6600 XT into the route table
- Cross-engine request translation (the `qwen3-vd` → breeze `instruction` idea)
- Auth/TLS (still LAN-trust; add later if leaving LAN)
- Unified history, task or voice-library endpoints

## Follow-ups

1. STT through the fan-out: forward `POST /api/tasks` for the `stt`/`citrinet`
   alias so ASR gets the same failover story as TTS.
2. ~~Per-origin in-flight cap~~ — **shipped**, see "Fairness" above.
   `maxInFlightPerTarget` (default 2), capped targets spill to the standby,
   all-busy sheds `429` + `Retry-After`, and `/farm/health` reports
   `inFlight` / `inFlightCap`.
3. Sticky sessions for multi-seed auditions, if agents ever need a whole sweep
   to land on one host. Note the cap makes this sharper, not softer: a sweep
   fired in parallel now splits across `.36` and `.30`, so seeds of one audition
   would land on different hosts unless a sweep is sent serially or sticky
   sessions land first.
4. Option A (hub-native remotes) if unified history/UI becomes a requirement.
