# Fan-out design

Status: **implemented** (option B) — `cmd/fanout-proxy/`, shipped 2026-09-30.
STT followed on 2026-09-30 (follow-up 1: `POST /api/tasks` by alias).
Decisions below are as built; superseded drafts are kept only where they explain
*why* (e.g. the 6600 XT verdict).

## Goal

Give LAN agents one stable entrypoint for TTS/ASR across the multi-host farm
without exposing ports to WAN, without breaking warm instances on `.36`
(`breeze` / `sanotts` with `idleUnloadMs=0`), and without requiring each agent
to hard-code host:port:model triples.

Live entrypoint: **`http://10.0.0.36:18082`**.

## Where this sits (read this before adding failover somewhere new)

The farm has two routers stacked, and neither is intended to absorb the other:

```
client -> LiteLLM (:8000 on .30) -> fan-out (:18082 on .36) -> hub (:18080/…) -> engine instance
          model names, keys,        alias -> hub target list,     one instance,
          budgets, cloud            health cache, failover,        one engine
          provider fallbacks        in-flight caps, task pinning
```

- **LiteLLM is the OpenAI-facing layer.** It owns what a client calls a model
  (`kokoro`, `sanotts`, `ming3-tts`), API keys, budgets and fallbacks to
  non-audiocpp providers. Its audio routing is one `api_base` per deployment, so
  per-request audio failover means another `model_name` block (its
  `…-fallback` aliases) — and it only speaks OpenAI request shapes.
- **The fan-out is the hub-contract layer.** It is the only component that
  knows `/api/tasks` (task ids are hub-local, so reads are pinned back to the
  originating hub with `?hub=`), `/api/instances`, `/farm/health` and each hub's
  readiness. LiteLLM cannot route those, and never should.
- **A hub is one instance manager.** Its `/v1` is a pass-through to the instance
  it started; it has no notion of other hosts. Cross-host failover/balancing
  inside the hub (option A) would duplicate the fan-out's whole job and add
  remote failure modes to the warm-primary process.

So: put model naming/keys in LiteLLM, put farm routing in the fan-out, and keep
hubs single-host. The one thing neither router did until 2026-11-25 was spread
load across equivalent hosts — that is now `strategy: "round_robin"` on a route
(see "Balancing" below), not a hub change.

## Current farm (source of truth: `docs/farm.md`)

| Host | Endpoint | Model / service | Backend | Role |
|---|---|---|---|---|
| `10.0.0.36:18080` | systemd hub | `breeze`, `sanotts`, `citrinet` | Vulkan GTX 1080 | Primary expressive + fast TTS + STT |
| `10.0.0.30:18080` | Docker `audio-cpp-hub-amd` | `breeze` | Vulkan iGPU DEVICE=1 | Standby breeze |
| `10.0.0.30:18081` | Docker `audio-cpp-hub-amd-qwen3` | `qwen3-vd` | Vulkan iGPU DEVICE=1 | Fast voice-design (`instruct`) |
| `127.0.0.1:18280` (GTX only) | native Kokoro hub | `kokoro` / `kokoro_tts` | CPU | Loopback-only Kokoro TTS |
| `10.0.0.31:18088` | native Windows hub (`D:\audio.cpp-hub`, scheduled task) | `kokoro-win1` | Vulkan GTX 1080 (device 1) | Primary Kokoro host on speed (~0.7 s/sentence); non-standard port: 8080 is taken |

Windows2 `10.0.0.32:18080` was an intended CPU SanoTTS overflow target,
but was offline at the 31 October 2026 read-only check (Docker Desktop stopped,
no listener). It is **not** in the active four-hub configuration until
[issue #127](https://github.com/matthewhand/audio.cpp-hub/issues/127) passes
separate storage, container, synthesis and history recovery gates. SanoTTS
`instant` and `sanotts` aliases now share the single GTX primary target; this
reduces redundancy but preserves both client model names.

RX 6600 XT (`AUDIOCPP_DEVICE=0` on `.30`) remains **unusable** for inference
(see verdict below). Keep live hubs on device 1, and keep the 6600 XT out of
`farm.routes.json`.

### Windows1 GPU choice (measured 2026-11-25)

Windows1 has both a GTX 1080 and an RX 6600 XT. One Kokoro sentence, same text,
`audiocpp_server v0.9.6` Vulkan:

| Target | Time per request | Note |
|---|---|---|
| Windows1 GTX 1080 (`device: 1`) | **~0.67 s** | now `kokoro-win1` |
| Windows1 RX 6600 XT (`device: 0`) | ~5.4 s | natively fine, just slow |
| Ubuntu-GTX host CPU (loopback hub) | ~3.8 s | keeps a 1/5 share |

Two Kokoro instances on that host — one per GPU — do **not** work together: the
second engine dies on its first synthesis with
`GGML_ASSERT(ctx->mem_buffer != NULL) failed` (Vulkan allocation), then the hub
logs `wsarecv: An existing connection was forcibly closed` and the instance goes
`EXITED`. Run exactly one Kokoro instance on Windows1; the 1080 is the one worth
having. This is why Windows1 is one target, not two.

Weights follow the measurement: `kokoro` is `1` (loopback CPU) to `4` (Windows1
GTX 1080), i.e. 80% of sentences skip the CPU path. Change the config, not the
code, if the balance ever looks wrong.

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
| `sanotts` / `instant` | `.36` `sanotts` | none (Windows2 offline, [#127](https://github.com/matthewhand/audio.cpp-hub/issues/127)) |
| `citrinet` / `stt` | `.36` `citrinet` | none (only host that has it) |
| `kokoro` | Windows1 `10.0.0.31:18088` `kokoro-win1` (weight 4) | GTX `127.0.0.1:18280` `kokoro` (weight 1), round-robin |

Rules baked into the implementation:

- Never start/stop/re-configure an instance from the proxy; warm policy on
  `.36` is untouched (`idleUnloadMs=0` stays).
- `.30` DEVICE=0 (6600 XT) is not routable, so `qwen3-vd` has no fallback: the
  draft's "`.36` breeze with `instruct` → `options.instruction`" idea was
  **dropped**, because the proxy's only body edit is the `model` string and
  translating request schemas across engines is exactly the kind of surprise a
  tiny router must not introduce. Agents asking for `qwen3-vd` get a clear
  `503` instead of a different model wearing the same name.
- `citrinet` / `stt` are the ASR aliases: TTS is served with
  `POST /v1/audio/speech`, ASR with `POST /api/tasks` (see "STT through the
  fan-out"). The reverse pairing still fails, and on purpose — a speech call
  against `citrinet` 503s because the engine wants an audio contract, not text.
  The alias names a *service*, the endpoint names the *request shape*.

## Endpoints

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/farm/health` | per-hub `ok`/`latencyMs`/`failures`/`lastError`/instances, per-route `resolved` + skip reasons |
| `GET` | `/api/instances` | aggregated instances of every up hub, each tagged `hub` / `hubLabel` |
| `GET` | `/v1/models` | OpenAI list, only aliases whose route currently has a READY target |
| `POST` | `/v1/audio/speech` | route by `model` alias → rewrite `model` → stream response → failover, with a per-origin in-flight cap |
| `POST` | `/api/tasks` | route by `model` alias → rewrite `instanceId` → submit → failover, same cap |
| `GET` | `/api/tasks`, `/api/tasks/{id}`, `/api/tasks/{id}/result`, `DELETE /api/tasks/{id}` | read-through to one hub, pinned with `?hub=<baseUrl>` (task ids are hub-local) |

**Not proxied** (deliberate): `/api/history/*`, `/api/voices/*`,
`/api/audio/upload`, `/v1/tasks/run`. Those need per-origin paths or
server-side file access, so they stay on the origin hub.

## STT through the fan-out

The hub's ASR flow is its async task API (`POST /api/tasks`, then poll for
`text`). The fan-out serves it with the same route table, poll cache and
failover list as speech, so ASR gets one alias and one entrypoint:

```jsonc
// POST http://10.0.0.36:18082/api/tasks
{ "model": "stt", "request": { "audio": "/audio.cpp/data/uploads/clip.wav" } }
//  -> 202 + the hub's task record, X-Fanout-Hub: http://10.0.0.36:18080
```

What the proxy has to bridge: the hub addresses an instance by **hub-local id**,
not by service name, and an agent only knows the alias. So submission resolves
`instanceName` → `instanceId` out of the `/api/instances` snapshot the proxy
already caches for routing, and rewrites that one field. `request` is relayed
byte-for-byte (`json.RawMessage`), the same "only the routing key is touched"
rule speech keeps. A target the snapshot cannot give an id for is skipped with
`no instance id for <service>`, exactly like `hub is down`.

Decisions taken:

- **Failover covers submission, not execution.** The hub enqueues and answers
  `202` immediately; the ASR then runs on that one engine. The reads below carry
  no failover on purpose — re-submitting elsewhere would duplicate work, not
  recover it.
- **Reads are pinned, not guessed.** Task ids are 8-char hub-local ids, so
  `GET`/`DELETE /api/tasks*` require `?hub=<baseUrl>`; a hub not in the config is
  a `400`, one the poll cache reports down is a `502` without dialing. Guessing a
  host could answer with another hub's task. The pin comes straight from
  `X-Fanout-Hub` on the submission (or from `hub` on a `GET /api/instances`
  entry); hub filters such as `active=1` / `modelId` pass through untouched.
- **A read is a read.** The hub's own status and body are the answer — its
  `404 TASK_NOT_FOUND` stays a `404` instead of being rewrapped in a fan-out
  envelope — and only a transport failure becomes a `502`. Reads carry a 30 s
  ceiling (they have no side effects, so a stuck hub must not pin the request);
  the forwards stay unbounded because generation is.
- **The in-flight cap covers submission.** A slot is held for the submit round
  trip, then released while the task still runs — the hub's own serial queue is
  what bounds execution, so for ASR the cap limits *how fast work is queued*, not
  how much of it is running.
- **`request.audio` is a server-side path**, i.e. it exists on the origin hub
  only. If the `stt` route ever grows a second host, a submission that fails
  over would reference a file the standby cannot read: that surfaces as a
  `FAILED` task on the engine, not as a second failover. Today the route is
  single-host, so it cannot happen; uploading first and keeping ASR pinned to
  the host that holds the file is the safe pattern if that changes.

Known cost of failover here: if a submission is accepted but its response is
lost in transit, the proxy fails over and the work runs twice. ASR is
idempotent, so the price is one wasted engine slot — same as a re-sent TTS
request.

## Health aggregation

`GET /farm/health` returns the shape sketched in the draft:

```jsonc
{
  "ok": true,
  "updatedAt": "2026-09-30T07:10:19Z",
  "countersSince": "2026-09-30T06:58:02Z",
  "hubsUp": 4, "hubsTotal": 4, "readyAliases": 5, "inFlightCap": 2,
  "hubs": [
    { "baseUrl": "http://10.0.0.36:18080", "label": "gtx1080-primary", "ok": true,
      "latencyMs": 0, "failures": 0, "lastError": "", "checkedAt": "…",
      "instances": [ /* passthrough of /api/instances */ ] }
  ],
  "routes": [
    { "aliases": ["breeze", "expressive"], "resolved": "http://10.0.0.36:18080/breeze",
      "served": 41, "failed": 2,
      "targets": [{ "hub": "http://10.0.0.36:18080", "instanceName": "breeze", "weight": 1, "skipped": "", "inFlight": 1, "served": 39, "failed": 2 },
                  { "hub": "http://10.0.0.30:18080", "instanceName": "breeze", "weight": 1, "skipped": "", "inFlight": 0, "served": 2, "failed": 0 }] }
  ],
  "knownAliases": ["breeze", "citrinet", "expressive", "instant", "kokoro", "qwen3-vd", "sanotts", "stt", "voice-design-fast"]
}
```

- `hubsTotal` counts configured hubs, including down targets. The checked-in
  file configures five hubs, including Kokoro's loopback hub and Windows1's
  `:18088` hub. Installations
  with additional targets report their own totals.
- Kokoro resolves to `http://127.0.0.1:18280/kokoro` when READY. The origin
  URL serves as the `?hub=` pin on requests to the fan-out. History access
  for this target is local to Ubuntu-GTX.
- Probe: `GET /api/instances` every 7 s per hub, in parallel, 3 s timeout.
- A hub is marked **down after 2 consecutive failures**; one successful poll
  restores it immediately. One blip never moves traffic off a warm primary.
- A target is usable only if its hub is up *and* that hub reports the instance
  `READY` — a lazy-loading `citrinet` on `.36` is skipped until it is warm. That
  same snapshot carries the hub-local `instanceId`, which is all `POST /api/tasks`
  needs, so task routing adds no polling.
- `inFlight` per target is a live count (not from the poll cache), shown next to
  the effective `inFlightCap` so a target about to start shedding is visible
  before it does. `resolved` stays the poll-cache answer: first READY target,
  regardless of load and regardless of strategy; each route reports its
  `strategy` and each target its `weight`, so a balanced route is visible there.
- `served` / `failed` are cumulative forward counts per target since
  `countersSince` (process start), with the sum on the route. They are the
  measurement of a split: after a five-request check on the shipped 1:4
  `kokoro` route the two targets read 1 and 4 without anyone reading
  `X-Fanout-Hub`. A forward
  counts as `failed` when the target answered non-2xx or did not answer and the
  loop walked on; a client disconnect after relaying began counts as failed
  only for the target that was streaming.

## Balancing — `strategy: "round_robin"`

A route's target list used to mean one thing: priority order. It now carries a
strategy, because two equivalent hosts (GTX loopback Kokoro and Windows1's
Vulkan Kokoro) should share traffic instead of leaving one idle as a standby.

```jsonc
{
  "aliases": ["kokoro"],
  "strategy": "round_robin",
  "targets": [
    { "hub": "http://127.0.0.1:18280", "instanceName": "kokoro",      "weight": 1 },
    { "hub": "http://10.0.0.31:18088", "instanceName": "kokoro-win1", "weight": 4 }
  ]
}
```

Decisions taken:

- **Smooth weighted round-robin** (nginx's algorithm), not random and not plain
  rotation: weights `2`/`1` give `A,B,A,A,B,A`, which keeps the expensive host
  at its intended share without a burst of three in a row. Equal weights degrade
  to plain alternation. `kokoro` ships `1` (loopback CPU) to `4` (Windows1 GTX
  1080) because that is the measured speed ratio, so most of the traffic skips
  the CPU path entirely.
- **Balancing is layered on failover, not instead of it.** The chosen target
  goes first and every other target follows in config order, so a pick that
  errors walks the rest of the list exactly as a failover primary would. A
  balanced route can never be less available than the failover route it
  replaced.
- **Only usable targets rotate.** Down hubs, instances that are not `READY` and
  targets at their in-flight cap are excluded, so a machine going away costs its
  share and nothing else; it rejoins the rotation on the first healthy poll.
- **The default stays `failover`.** Ordering is a promise (warm primary, standby
  that must not steal load), so nothing changes unless a route opts in. An
  omitted `weight` normalises to `1` for both strategies, and a failover route
  pins it to `1`, so switching strategy back needs no config cleanup.
- **State is one in-process counter per route.** One proxy, one farm: no gossip,
  no shared cursor, nothing to disagree about. A restart resets rotation, which
  no caller can observe beyond the order of two equivalent backends.
- **The split is observable.** `served` / `failed` per target in
  `/farm/health` are the balancing analogue of `inFlight`: an operator can see
  whether weights hold, and spot a target that keeps failing and being walked
  past, without parsing response headers or reading the log.
- **Not for stateful flows.** A multi-seed audition that must land on one host
  is the opposite case — send it serially or pin the hub directly (follow-up 3).


## Failure / failover

1. Target unusable per the poll cache (hub down, instance not READY, no instance
   id for a task submission) → next target, recording the skip reason.
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
  in-flight limiter, shared failover loop, streaming forward), `balance.go`
  (smooth weighted round-robin), `tasks.go` (`POST /api/tasks` by alias + pinned
  task read-through), `main.go` (flags, handlers).
- `cmd/fanout-proxy/farm.routes.json` — the committed farm topology. The task
  path needs no new key: an alias names a service, and the engine's own request
  object rides along untouched.
- `cmd/fanout-proxy/audio-cpp-fanout.service` — systemd **user** unit template
  (install notes in the file header); nothing is enabled automatically.
- `cmd/fanout-proxy/README.md` — build / run / endpoints / knobs / smoke test.
- Table-driven unit tests cover alias resolution, strategy/weight
  normalisation and rejection, weighted round-robin (order, ratio over a run,
  unusable targets dropping out and rejoining, nil safety), target planning and failover
  (including httptest stand-ins for two hubs), the 2-failure down threshold, the
  body rewrite, the in-flight cap (spill, `429` shedding, slot release, nil and
  `cap <= 0` safety), the committed route table, and the task path (alias →
  per-hub `instanceId` rewrite, submission failover, cap shedding and slot
  release, instance-id resolution incl. malformed/absent ids, and the pinned
  read-through across all four task routes plus its rejection cases).
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

1. ~~STT through the fan-out~~ — **shipped**, see "STT through the fan-out":
   `POST /api/tasks` routes by the same alias, resolves the hub-local
   `instanceId` from the poll snapshot, and fails over on submission; the task
   reads (`GET` / `GET .../result` / `DELETE`) are a read-through pinned with
   `?hub=<baseUrl>`. Remaining gaps, both about audio files rather than routing:
   uploads still go to the origin hub (`/api/audio/upload` is not proxied), and a
   failover between two hosts would reference a path only the origin can read —
   moot while `stt` is single-host.
2. ~~Per-origin in-flight cap~~ — **shipped**, see "Fairness" above.
   `maxInFlightPerTarget` (default 2), capped targets spill to the standby,
   all-busy sheds `429` + `Retry-After`, and `/farm/health` reports
   `inFlight` / `inFlightCap`. Note it caps submission for `POST /api/tasks`;
   execution is bounded by the hub's own serial queue.
3. Sticky sessions for multi-seed auditions, if agents ever need a whole sweep
   to land on one host. Both the cap and `round_robin` make this sharper, not
   softer: a sweep fired in parallel splits across the route's usable targets, so
   seeds of one audition land on different hosts unless the sweep is sent
   serially or sticky sessions land first. Which host served a take is still
   never ambiguous — `X-Fanout-Hub` / `X-Fanout-Instance` name it per response.
4. Option A (hub-native remotes) if unified history/UI becomes a requirement.
