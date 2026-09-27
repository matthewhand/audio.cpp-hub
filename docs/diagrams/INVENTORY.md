# Diagram inventory — audio.cpp-hub

Visual documentation derived from the actual repository (main @ `698e0f4`).
Every label, port, path, and constant below is traceable to a source file.
Anything not directly stated in code is marked **[inferred]**.

## Source map used

| Concern | Source |
|---|---|
| Entry / wiring / config / shutdown | `main.go`, `hub.config.example.json` |
| Instance lifecycle, port reservation, health poll, `server.json` | `instance.go`, `constants.go` |
| Async task queue, serial executor, TTS finalize, result files | `task.go`, `constants.go` |
| `/v1/*` OpenAI-compatible proxy, model extraction | `proxy.go` |
| Model weight downloader, SSRF guard, segments, resume | `download.go`, `packages.go`, `model-packages.json` |
| TTS history, groups, reference snapshots | `history.go` |
| Voice library | `voices.go` |
| Executable + Profile registries | `registry.go` |
| Route table, CSRF guard, static serving | `api.go` |
| API contract | `docs/API.md` |
| Threat model / deployment | `SECURITY.md`, `DOCKER.md`, `compose.amd.yaml`, `Dockerfile.amd`, `docker/start-hub.sh`, `docker/start-instance.sh` |
| Frontend | `web/` (`app.js`, `index.html`, `i18n.js`) |
| CI / build / release | `.github/workflows/`, `README.md` |
| External engine contract | `audiocpp_server --config server.json`, `GET /health`, `POST /v1/tasks/run`, `--list-devices` |

## Key facts pinned during discovery

- Hub default port **8080** (`hub.config.example.json`), dev copy **18080**; instances from **18090** up, bound to `127.0.0.1` (`instance.go:520` `"host":"127.0.0.1"`).
- Health poll: `GET http://127.0.0.1:<port>/health` every 1s, max **120s** (`instance.go:402`, `healthTimeoutSeconds = 120`).
- Instance state is register-only-while-alive: only `STARTING` / `READY` exist in the manager (`instance.go:24`).
- Task states: `QUEUED / RUNNING / DONE / FAILED / CANCELLED` (`task.go:29`); per-instance serial queue, `taskQueueSize = 100`, `finishedKeep = 100`.
- TTS path = history path: `modelId`/`taskId` key → `data/history/<modelId>/`; `audio` base64 extracted streaming from response JSON (`task.go:591 extractAudio`).
- Non-TTS path: response stored `data/tasks/<id>.result.json`, served via `/api/tasks/{id}/result`.
- `/v1/*`: body streamed to `run/proxy-cache/<id>.req`, top-level `"model"` scanned byte-wise, route to READY instance by `instanceName`; `ResponseHeaderTimeout: 60s`, no overall timeout; multipart unsupported (`proxy.go:20`, `proxy.go:68`).
- Downloads: Range segments + `os.File.WriteAt`, `<file>.part` then rename; SSRF guard blocks loopback/private/link-local/CGNAT/metadata ranges; allowed hosts `huggingface.co`, `hf-mirror.com`, `modelscope.cn`, `www.modelscope.cn` + configured `hfEndpoint` (`download.go:169`, `download.go:188`).
- CSRF: mutating `/api/*` rejected when `Sec-Fetch-Site: cross-site` or `Origin` host ≠ `Host`; missing headers allowed (curl) (`api.go:197`).
- **No authentication, no TLS** — hub binds all interfaces by default; explicitly stated in `SECURITY.md`. Trust boundary is the loopback/instance link plus same-origin CSRF only.
- Executables registry accepts arbitrary paths ⇒ "access to the hub ≈ arbitrary code execution as the hub user" (`SECURITY.md`).
- Static UI served from `web/` on disk (no `go:embed`), dir listings disabled (`api.go:150`).
- Deployment: native single binary (Win/Linux/macOS) with Windows tray, **and** Go-native Docker/Compose (generic + AMD Vulkan) with bind-mounted `data/ logs/ run/` (`DOCKER.md`).

## Proposed diagrams

| # | File | Type | Audience | Question answered | Confidence | Assumptions |
|---|---|---|---|---|---|---|
| 1 | `01-hero.html` | Architecture (hero) | README / new contributors | What is this, for whom, and what does it wrap? | High | — |
| 2 | `02-system-architecture.html` | Architecture | Developers | What are the runtime components, stores and boundaries? | High | — |
| 3 | `03-deployment.html` | Deployment | Operators | Where does it run: native vs Docker, ports, mounts, devices? | High | Docker paths from `DOCKER.md`/`compose.amd.yaml` |
| 4 | `04-integration.html` | Dependency / integration | Developers, operators | What external systems and protocols are involved? | High | — |
| 5 | `05-data-flow.html` | Data flow | Developers | How does payload data enter, transform, persist, expire? | High | — |
| 6 | `06-security-boundaries.html` | Layer stack (trust zones) | Operators, security | What are the trust zones, credentials, and unauthenticated surfaces? | High | — |
| 7 | `07-seq-http-api.html` | Sequence | Developers | Normal authenticated-less request to a model instance | High | Auth = CSRF/same-origin only (no authn exists) |
| 8 | `08-seq-core-tts.html` | Sequence | Developers | Core business op: TTS end-to-end with history extraction | High | — |
| 9 | `09-seq-proxy.html` | Sequence | Developers / integrators | OpenAI-compatible `/v1/*` routing by `model` | High | — |
| 10 | `10-seq-download.html` | Sequence | Operators | Weight download: probe → segments → resume | High | — |
| 11 | `11-seq-failure.html` | Sequence | Developers, ops | Failure/retry/recovery paths (health timeout, task replay, segment retry) | High | Combined recap; each leg traced to code |
| 12 | `12-operations.html` | Process / swimlane | Operators | Startup, shutdown, health, backup, rollback, diagnosis | High | Backup = copy `data/` (stated in `SECURITY.md`) |
| 13 | `13-state-instance-task.html` | State machine | Developers | Instance and task state lifecycles | High | — |
| 14 | `14-data-model.html` | ER / nested | Developers | On-disk entities and their relationships | High | Optional — included for completeness |

**Sizes:** all diagrams authored at a doc-inline/wide preset (`viewBox` width 1000), light theme default with the shipped palette (paper `#f5f5f5`, ink `#2d3142`, accent `#eb6c36`).

**Deliberately omitted (would be filler):**
- A radar/quadrant/treemap of model categories — a table already answers it.
- An org chart — no human/agent ownership model in this repo.
- A Gantt of CI stages — the workflow file is the source of truth.
- Per-model sequence diagrams — the engine contract is uniform; one TTS diagram covers it, differences live in `models.json`.

## Unresolved / uncertain

- **Windows tray specifics** (`tray_windows.go`) are not depicted beyond "tray host" because they are OS-UI behavior, not architecture.
- **macOS release** is claimed in `README.md`; the deposited workflow file list was not fully inspected in this pass — marked [inferred] in diagram 3.
- **`internal/wav`** is a small helper package; grouped as one node in the data-flow diagram, not expanded.
