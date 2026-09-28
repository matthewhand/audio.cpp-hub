# Diagram inventory

All diagrams are derived from the `feat/go-magpie-tts` tree (base commit `37341bf`). Source citations refer
to repository files. **Confidence** is the author's confidence that the diagram matches the implementation;
any inferred behavior is listed under **Assumptions**.

| # | File | Type | Audience | Question it answers | Primary sources | Confidence |
|---|---|---|---|---|---|---|
| 1 | `hero-overview.html` | Architecture (hero) | all | What is audio.cpp-hub, and what sits around it? | README.md, AGENTS.md, compose.amd.yaml | High |
| 2 | `system-architecture.html` | Architecture | dev / contributor | Which components run inside the hub, and how do they connect? | main.go, api.go, instance.go, task.go, proxy.go | High |
| 3 | `deployment-docker.html` | Deployment | operator | How is it deployed on an AMD host — devices, ports, volumes? | Dockerfile.amd, compose.amd.yaml, docker/*, DOCKER.md | High |
| 4 | `deployment-modes.html` | Deployment | operator | Native/systemd vs Docker bridge vs LXC host-network? | DOCKER.md, compose*.yaml, *.service | Medium |
| 5 | `seq-tts-task.html` | Sequence | dev / operator | How does an async TTS task run end-to-end? | api.go, task.go, history.go, web/app.js | High |
| 6 | `seq-openai-proxy.html` | Sequence | integrator | How does an OpenAI-compatible `/v1/*` request traverse the hub? | proxy.go, api.go | High |
| 7 | `seq-instance-lifecycle.html` | Sequence | operator | How is a model child process started and stopped? | instance.go, api.go | High |
| 8 | `seq-download.html` | Sequence | operator | How are model weights downloaded with resume? | download.go, packages.go | High |
| 9 | `seq-auth.html` | Sequence | security | How are requests authenticated and authorized? | util.go, api.go, SECURITY.md | High (finding: not at all) |
| 10 | `seq-failure-recovery.html` | Sequence | operator | What happens on timeout, cancel, or restart? | instance.go, task.go, download.go, main.go | Medium |
| 11 | `integration-external.html` | DP integration | integrator | Which external systems are integrated, over what protocols/auth? | download.go, packages.go, proxy.go, models.go | High |
| 12 | `data-flow.html` | Data flow | dev / operator | How does data enter, transform, persist, and leave? | history.go, voices.go, download.go, task.go, audio.go | High |
| 13 | `security-boundaries.html` | Architecture (secure paved road) | security | Which routes cross a trust boundary, and what is forbidden? | api.go, util.go, fs.go, download.go, SECURITY.md | Medium (inferred) |
| 14 | `ops-startup-shutdown-health.html` | Process / flow | operator | How does the deployment boot, become healthy, and stop gracefully? | docker/start-hub.sh, docker/start-instance.sh, main.go, instance.go | High |
| 15 | `state-machines.html` | State machine | dev / operator | What are the instance and task state lifecycles? | instance.go, task.go | High |
| 16 | `data-model.html` | ER | dev | What artifacts are persisted, and how do they relate? | registry.go, voices.go, history.go, download.go, task.go | High |
| 17 | `dependency-graph.html` | Dependency | dev | How do Go packages/files depend on each other? | main.go, api.go, internal/*, go.mod | High |
| 18 | `ui-information-architecture.html` | Nested / tree | user / contributor | How is the Web UI organized, and how does i18n apply? | web/index.html, web/app.js, web/i18n.js | Medium |
| 19 | `ci-release-pipeline.html` | Process / flow | maintainer | What does CI do on PR and on tag — gates, artifacts, release? | .github/workflows/*.yml | High |

## Notes per diagram

**1 hero-overview** — Product boundary is the hub process; clients are the Web UI and any OpenAI-compatible
client. The engine (`audiocpp_server`) is an external process the user supplies. *Assumption:* the diagram
shows the common single-host LAN deployment, not every supported topology.

**2 system-architecture** — Managers (`InstanceManager`, `TaskManager`, `DownloadManager`, `HistoryManager`,
voice library, `ExecutableRegistry`, `ProfileRegistry`) plus the HTTP mux and `/v1` proxy. *Assumption:* the
flat `package main` is treated as one runtime; internal seams (`internal/wav`, `internal/idvalidate`) are noted
but not separate services.

**3 deployment-docker** — Artifact chips carry the image tags; paths/ports come from `compose.amd.yaml`.
*Assumption:* the AMD/Vulkan host is representative; the generic `Dockerfile`/`compose.yaml` is the CPU path.

**4 deployment-modes** — Three placements: native binary + systemd (dev/non-GPU), Docker bridge (prod AMD),
Compose `network_mode: host` (LXC). *Assumption:* LXC mode taken from `.env.lxc100`/DOCKER.md.

**5 seq-tts-task** — Web UI `POST /api/tasks` → per-instance serial queue → engine `/v1/tasks/run` → response
spooled → `history.go` extracts `"audio"` to `data/history/<modelId>/<taskId>.wav` → 2s poll renders the
player. *Assumption:* TTS is the primary path; non-TTS results take `forwardToFile`.

**6 seq-openai-proxy** — Body is streamed to `run/proxy-cache/`, top-level `"model"` is extracted byte-by-byte,
then routed by service name to the READY instance; response status/type streamed back. *Known limit:*
multipart bodies cannot yield a model → 400.

**7 seq-instance-lifecycle** — `POST /api/instances` → write `run/<id>/server.json` → `os/exec` child →
`/health` poll (≤120s) → READY; stop via `DELETE`. Health polling is the readiness gate.

**8 seq-download** — Parallel HEAD probes → segmented Range download via `WriteAt` to `.part` → verify →
rename; pause/resume uses context cancel; hub restart resumes from segment offsets.

**9 seq-auth** — **There is no authentication or authorization.** Every `/api/*` and `/v1/*` request from the
network is treated as trusted; the security model is "local/LAN only". The diagram makes the trust boundary
and the compensating controls (loopback children, path validation, CSRF/Content-Type checks) explicit rather
than implying an auth layer that does not exist.

**10 seq-failure-recovery** — Covers start timeout (120s), task cancel on RUNNING (hub-side only; engine runs
on), download pause/restart resume, proxy header timeout, and hub restart replay (RUNNING→CANCELLED).
*Assumption:* exact recovery text taken from code comments and is summarized.

**11 integration-external** — Hugging Face (default), `hfEndpoint` mirrors, ModelScope (`source:"modelscope"`),
the audio.cpp engine interface, and OpenAI-compatible clients. Auth is a bearer token for gated HF repos
(stored 0600 in the download task state).

**12 data-flow** — Inputs (WAV upload, `voice_ref`, prompts, model packages) → hub transforms → outputs
(result WAV under `data/history`, non-TTS JSON under `data/tasks`, model weights under `models/`). Retention:
history has **no eviction**; task state is replayed on restart.

**13 security-boundaries** — *Inferred:* the "secure paved road" pattern is applied from the code's actual
controls, not a formal threat model. Included from the post-uplift code: CSRF/Origin + `Content-Type`
enforcement, `internal/idvalidate` path validation, SSRF/private-range blocking in `download.go`, CSP meta,
and signed-off warnings in SECURITY.md.

**14 ops-startup-shutdown-health** — `start-hub.sh` starts the Go binary, `start-instance.sh` waits for
`/api/models`, starts and warms an instance, exits non-zero on failure; `SIGTERM` drains via `srv.Shutdown`.

**15 state-machines** — Instance: `STARTING → READY → STOPPED / FAILED`. Task: `QUEUED → RUNNING →
DONE / FAILED / CANCELLED`. *Assumption:* terminal-state names follow the API docs.

**16 data-model** — Registry/config JSON (`executables.json`, `data/profiles.json`), voice index, history
`index.jsonl` + `groups.json` + WAV snapshots, `data/downloads/<id>/task.json`, `data/tasks/<id>.task.json`,
embedded `models.json`/`model-packages.json`.

**17 dependency-graph** — `main.go` wires managers; `api.go` is the hub; managers depend on `util.go` and the
`internal/` helpers; `models.json`/`model-packages.json` are `go:embed`ed.

**18 ui-information-architecture** — Page header actions (history 🕘, voices 🎙, downloads ⬇), the model
workspace, and the launch/settings/task flows; `web/i18n.js` provides zh/en for all UI strings.
*Assumption:* panel grouping reflects the current app.js structure.

**19 ci-release-pipeline** — `ci.yml` runs gofmt/vet/race tests on PRs; `build-and-release.yml` builds
windows/linux/arm64, generates `SHA256SUMS`, runs a startup smoke test, and publishes on tags.

## Recommended future diagrams

- A per-model parameter matrix (models.json `inputs` → UI form) — better as a table than a diagram.
- A WebSocket/SSE streaming sequence if streaming mode returns to the Go line.
- An incident runbook flowchart keyed to `/api/events` levels.
