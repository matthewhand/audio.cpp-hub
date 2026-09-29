# audio.cpp-hub

**[简体中文](README.md) | English**

A web management panel for [audio.cpp](https://github.com/0xShug0/audio.cpp): a lightweight HTTP service written in Go that starts / stops / monitors multiple `audiocpp_server` model-instance subprocesses, and provides a primarily-Chinese web UI for TTS / ASR / music-separation and other audio tasks.

Repository: <https://github.com/matthewhand/audio.cpp-hub>

- **Native single binary**: the build has no runtime dependencies (static Go build; release packages ship Windows / Linux executables)
- **The hub itself is lightweight**: it does not load model weights — models run in separate `audiocpp_server` subprocesses

## Demo

These clips are captured from the running web UI (Playwright recording + ffmpeg encoding), not mockups. Shorter ones use `<video>` (WebM + poster frame, so the whole clip is not fetched on first paint); the older GIFs are inlined.

**Overview: model list and a ready instance** — the left rail lists launchable models and instance cards (the BreezeTTS instance is READY here); selecting a model opens its workspace on the right.

![hub-overview](docs/assets/hub-overview.gif)

**Text-to-speech (TTS)** — type text, synthesise with one click, and play / download the result right on the page (async queue, so you can keep submitting).

![hub-tts](docs/assets/hub-tts.gif)

**Launching an instance** — set the weights path and device, start the model, and wait for the health check to report it ready.

<video src="docs/media/instance-start.webm" poster="docs/media/instance-start.poster.png" width="640" controls preload="none" loop muted playsinline></video>

**Operation history** — open it from the 🕘 button in the header; expand a record inline and replay the reference / result audio.

<video src="docs/media/history.webm" poster="docs/media/history.poster.png" width="640" controls preload="none" loop muted playsinline></video>

**Download manager** — open it from the ⬇️ button in the header to watch weight-download progress and pause / resume / fill the path into the launch form.

<video src="docs/media/downloads.webm" poster="docs/media/downloads.poster.png" width="640" controls preload="none" loop muted playsinline></video>

**Theme switching** — system / light / dark, restored before first paint so there is no flash (see `web/boot.js`).

<video src="docs/media/theme-switch.webm" poster="docs/media/theme-switch.poster.png" width="640" controls preload="none" loop muted playsinline></video>

> Clips are recorded by `scripts/record-demos.cjs` from a **real running hub**; see
> [`docs/media/README.md`](docs/media/README.md) for the scenario list and how to re-record.

## Diagrams

Architecture, deployment, sequence, data and operations diagrams — editable HTML source plus light/dark PNG previews: [`docs/diagrams/`](docs/diagrams/README.md).

![Overall architecture](docs/diagrams/assets/hero-overview.png)

## Features

- **Multi-instance management**: writes a `server.json` per instance and launches `audiocpp_server` as a subprocess — automatic port allocation (bound to 127.0.0.1), health polling (up to 120s), log viewing, one-click stop
- **Web UI**: plain HTML/JS frontend (no build step), bilingual Chinese/English, with model selection, parameter forms and task submission
- **UI capabilities**: hash routing and deep links (`#/model/<id>`, `#/history`, …, restorable via back/forward), a `Ctrl/Cmd-K` command palette, dark / light / follow-system themes, unified skeleton / empty / error states for lists, keyboard accessibility and WCAG AA contrast (motion respects `prefers-reduced-motion`)
- **Installable / offline**: `manifest.webmanifest` + a Service Worker — network-first for navigations, cache-first with background revalidation for static assets; `/api/*` and `/v1/*` are never cached, there is an offline fallback page, and registration failures degrade silently
- **Async task queue**: `POST /api/tasks` returns immediately and runs serially per instance; task state is persisted, so tasks survive a page refresh / hub restart, and results can be fetched later
- **TTS operation history**: per-model synthesis records and result audio (no automatic eviction; delete manually), replayable from the history panel, with grouping and inline detail
- **Voice library (reference audio)**: a global resource under `data/voices/` with unique names, rename / reference-text editing / preview
- **OpenAI-compatible proxy**: `GET /v1/models` aggregates all ready instances; `POST|PUT /v1/*` (e.g. `/v1/audio/speech`) routes by the top-level `model` in the body, streaming large base64 through disk the whole way (see OpenAI API Compatibility below for the boundary)
- **Built-in weight downloader**: `POST /api/downloads` performs multi-threaded ranged downloads from HuggingFace (or a modelscope mirror), with resume, pause/resume, and progress/speed stats; the authoritative package list is `model-packages.json`, and [`model_download_urls.md`](model_download_urls.md) is a reference for manual sources (Chinese)
- **Device probing**: the start dialog can run `audiocpp_server --list-devices` and render available devices as a dropdown
- **Windows-friendly**: system tray, auto-start, and subprocesses launched without a console window

## Quick Start

### Prerequisites

- Building from source: **Go 1.27+** (`go.mod` declares `go 1.27`; CI uses Go 1.27)
- Supported systems: release packages ship **Windows (amd64), Linux (amd64 / arm64) and macOS (arm64)**; the hub is a static single binary, and the system tray only works on Windows
- A runnable `audiocpp_server` binary: release packages **do not include** it. Download the build for your platform / GPU from [audio.cpp Releases](https://github.com/0xShug0/audio.cpp/releases/latest), place it anywhere (e.g. `audiocpp/`), and register it as an executable in the web UI
- Hardware: depends on the `audiocpp_server` build you download. The bundled `executables.json` sample is a **Windows + AMD ROCm** setup (run `--list-devices` to see the actual backends); small models also run on CPU, with speed depending on the model and thread count
- Disk: model weights range from a few hundred MB to tens of GB, so leave ample free space (the hub runs a disk-space pre-check before downloading)

### Using a release package (recommended)

Download the native zip for your platform (`-windows` / `-linux`) from [Releases](https://github.com/matthewhand/audio.cpp-hub/releases) and run it — **no runtime needs to be installed**:

```bash
# Linux
unzip audio.cpp-hub-<version>-linux.zip
cd audio.cpp-hub-<version>-linux
./audio.cpp-hub
```

On Windows, double-click `audio.cpp-hub.exe` (no console window; it goes to the system tray). After startup, visit `http://localhost:8080` (port is `httpPort` in `hub.config.json`; the release package defaults to 8080).

### Building from source

```bash
git clone https://github.com/matthewhand/audio.cpp-hub.git
cd audio.cpp-hub
go build -ldflags "-X main.version=<tag>" -o audio.cpp-hub .
./audio.cpp-hub
```

The working directory must contain `web/` (static pages); `models.json` / `model-packages.json` are embedded via `go:embed` and need no copying. After startup, visit `http://localhost:8080`.

Cross-compiling (when not on Windows):

```bash
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags "-H windowsgui -s -w -X main.version=<tag>" -o audio.cpp-hub.exe .
CGO_ENABLED=0 GOOS=linux   GOARCH=amd64 go build -ldflags "-s -w -X main.version=<tag>" -o audio.cpp-hub .
```

## Basic Usage

1. **Register an executable**: add the path to `audiocpp_server` in the UI settings (top right); each entry can have its own `env` variables, whose values support `${VAR}` placeholders
2. **Create a launch profile**: pick a model and parameters; model weight paths can be picked via the built-in file browser; use the "advanced parameters" area for one `key=value` per line
3. **Start an instance**: the hub writes `run/<id>/server.json` and launches the subprocess; after the health check passes its status becomes `READY`
4. **Submit tasks**: run inference in the web UI, or call the async task API / the OpenAI-compatible API (`model` = instance service name `instanceName`)

## OpenAI API Compatibility

The hub's `/v1/*` endpoints are a **transparent proxy** to each `audiocpp_server` instance: the hub never modifies request bodies, so the compatibility boundary is set by the upstream `audiocpp_server` and the specific model.

- Supported request shapes (`GET /v1/models` lists the service names of all `READY` instances):
  - `POST /v1/audio/speech` (`model` / `input` / `voice` / `response_format`)
  - Any other `POST|PUT /v1/<path>`, forwarded verbatim (path and body) to the same path on the instance
- **`model` extraction is JSON-only**: the hub streams over the body's top-level `"model"` string. `multipart/form-data` (e.g. a multipart `POST /v1/audio/transcriptions`) cannot be parsed for `model` and returns `400 {"error":{"message":"Missing required parameter: model","type":...}}`.
  - Workaround: use the web UI ASR flow, or call the instance's native task endpoint / `POST /api/tasks` with a JSON body.
- Routing: only `READY` instances are forwarded; an instance still starting returns `409`, an unknown service name returns `404`; a body larger than `proxyMaxBodyBytes` returns `413`.
- There is no overall upstream timeout (TTS can run for a long time); disconnecting the client cancels the forward.
- **Full compatibility with the standard OpenAI interface is not guaranteed, and the root cause is usually on the model side**: audio.cpp aggregates many model families, and the parameters each model requires/accepts differ — the same request that works on model A can fail outright on model B. For example:
  - Voice-cloning models (IndexTTS2, Qwen3-TTS Base, ...) have no built-in voices, so a bare `model` + `input` request fails; you must additionally supply reference audio via `voice_ref`;
  - Qwen3-TTS CustomVoice uses `voice` as a packaged speaker name, while the VoiceDesign variant takes a natural-language voice description in `instructions`;
  - Some standard OpenAI parameters are not supported upstream and are silently ignored, e.g. `speed` and `modalities` on speech;
  - Some models strictly validate unknown options, so sending a parameter they do not recognize can make them reject the entire request.
- The `inputs` / `paramSchema` declarations in `models.json` (which drive the web UI's parameter form) state the required inputs for each model. When a parameter has no effect or a request errors, consult that model's documentation first (the audio.cpp repo's `docs/models/`) — this is usually not a hub forwarding issue.

## Configuration

`hub.config.json` is **optional and is NOT auto-generated by the hub**: if the file exists it is read, otherwise (or on parse failure) the built-in defaults apply.

```json
{
  "httpPort": 8080,
  "instancePortBase": 18090,
  "modelsDir": "models",
  "hfEndpoint": "https://huggingface.co",
  "downloadThreads": 8,
  "downloadSegmentsPerFile": 4,
  "proxyMaxBodyBytes": 1073741824
}
```

| Key | Default | Description |
| --- | --- | --- |
| `httpPort` | `8080` | Port the hub listens on |
| `instancePortBase` | `18090` | Starting port for model instance allocation (bound to 127.0.0.1) |
| `modelsDir` | `"models"` | Root directory weight downloads land in (relative to the working directory) |
| `hfEndpoint` | `"https://huggingface.co"` | Default download source; change to a mirror such as `https://hf-mirror.com` when unreachable |
| `downloadThreads` | `8` | Global download concurrency |
| `downloadSegmentsPerFile` | `4` | Segments per file (minimum segment granularity 32MB) |
| `proxyMaxBodyBytes` | `1073741824` (1 GiB) | On-disk body size limit for `/v1/*` proxy requests |

> The development copy of `hub.config.json` in this repo sets `httpPort` to `18080`, so running from source listens on 18080.

## API Overview

The full endpoint list (method / path / body / response / error codes) is in [`docs/API.md`](docs/API.md) (Chinese-first). Common entry points:

| Endpoint | Description |
| --- | --- |
| `GET /api/models` | Supported model list (embedded `models.json`) |
| `POST /api/instances` | Start a model instance |
| `POST /api/tasks` | Create an async inference task (202, returns immediately) |
| `GET /api/tasks/<id>/result` | Fetch a non-TTS task result |
| `POST /api/run/<instanceId>` | Legacy synchronous forward (TTS results go to history) |
| `/api/history/<modelId>...` | TTS history query / audio retrieval / grouping / deletion |
| `/api/voices...` | Voice library management |
| `/api/downloads...` | Weight download tasks (list / pause / resume / delete) |
| `GET /api/executables/<id>/devices` | Run `--list-devices` to probe devices |
| `/api/fs/*` | Server-local filesystem browsing (for picking weight paths) |
| `GET /v1/models`, `POST|PUT /v1/*` | OpenAI-compatible proxy |

## Troubleshooting / FAQ

**The hub exits immediately, saying the port is in use**
At startup the hub binds the port with `net.Listen`; on failure it logs `监听 :8080 失败: ...` and exits (`main.go`). Change `httpPort` in `hub.config.json`, or stop the process holding the port and restart. Instance ports are auto-allocated from `instancePortBase`; if you specify a port explicitly in the launch form, an occupied port returns `INSTANCE_PORT_IN_USE`, and the hub's own port returns `INSTANCE_PORT_RESERVED`.

**An instance stays `STARTING` and finally times out**
The hub polls the instance's `GET /health` once per second for up to **120s** (`healthTimeoutSeconds` in `instance.go`). On timeout or early subprocess exit, it writes the last ~10 log lines into the event log (`GET /api/events`, or the UI event panel) and then **deletes** `run/<id>/`. A running instance's log is `run/<instanceId>/server.log`. Common causes: wrong weight path, insufficient VRAM/RAM, wrong backend or device, or a mismatched `audiocpp_server`/model; use `GET /api/executables/<id>/devices` (or the device dropdown in the launch dialog) to confirm devices.

**Downloading a gated HuggingFace model fails with an auth error**
Gated repos such as `PocketTTS` and `Stable Audio 3` need an HF token: pass `"token"` in the `POST /api/downloads` body, otherwise you get `DOWNLOAD_AUTH` (upstream HTTP 401/403). The token is stored in plaintext in `data/downloads/<id>/task.json` (directory `0700`, file `0600`), and the API strips it from all output.

**`/v1/audio/transcriptions` (multipart) returns 400**
The hub's `/v1/*` proxy can only route on the top-level `"model"` field of a **JSON** body; `multipart/form-data` cannot be parsed for `model` and returns `400 {"error":{"message":"Missing required parameter: model",...}}`. Use a JSON body, the web UI's ASR flow, or `POST /api/tasks`. See "OpenAI API Compatibility" above.

**Downloading from ModelScope returns `REMOTE_NOT_FOUND`**
`source:"modelscope"` only maps to `HereIsMark/<repo-name>`, and only the `audio.cpp-gguf` repo is mirrored there today; other packages 404 (`REMOTE_NOT_FOUND`). Use the default HuggingFace source, or point `hfEndpoint` at a reachable mirror.

**A `/v1/*` request returns 413**
When the body exceeds `proxyMaxBodyBytes` (default 1 GiB, in `hub.config.json`) it cannot be spooled to disk and returns 413. Raise it in the config if needed; this limit applies only to `/v1/*` proxy bodies, not `/api/*` (capped at 64MB).

**Where are the logs?**
- The hub itself: console output; in Windows GUI mode (`-H windowsgui`) it also writes `logs/hub.log`
- Model instances: `run/<instanceId>/server.log` while running; after a failed launch the directory is cleaned up and the tail is kept in the event log (`/api/events`)
- Downloads: state and progress in `data/downloads/<id>/task.json`; inference tasks in `data/tasks/<id>.task.json`

## Directory Layout

```text
main.go / api.go        # Entry point; /api/* routes and handlers
proxy.go                # /v1/* OpenAI-compatible proxy
instance.go             # Instance subprocess lifecycle, health polling, device probing
registry.go             # executables.json / data/profiles.json
task.go                 # Async inference task queue (serial queue, persisted state)
history.go              # TTS history (index.jsonl + result audio + reference snapshots)
voices.go / audio.go    # Voice library; WAV upload and header parsing
download.go / packages.go # Weight downloader; model-packages.json manifest
fs.go / models.go / util.go # Filesystem browser; model list; utilities
web/                    # Frontend static files (no build step)
├── app.js + modules/   # ES-module entrypoint + 20 feature modules
└── i18n.zh.js / i18n.en.js  # Bilingual dictionaries (i18n.js is the runtime only); api-client.js is the single HTTP exit
docs/                   # Docs: API.md, diagrams/ (19 architecture / sequence / state diagrams), ui.md, motion.md, pwa.md
test/ / e2e/            # Frontend unit tests (node:test) and e2e (Playwright + mock backend)
models.json             # Model list (embedded with go:embed)
model-packages.json     # Download package manifest (embedded with go:embed)
run/                    # Runtime: instance server.json / server.log / proxy cache
data/                   # Runtime: uploads, voices, profiles.json, history, downloads, tasks
models/                 # Runtime: downloaded model weights (modelsDir)
logs/                   # Runtime: logs/hub.log in Windows GUI mode
```

## Security Notice

> **This is a LAN / localhost tool with no authentication and no public-internet hardening.**
>
> Do not expose the port directly to the public internet. For remote access, put a reverse proxy with HTTPS and authentication in front of it yourself.

**All write operations are unauthenticated.** Common mutating endpoints include:

| Method | Path | Effect |
| --- | --- | --- |
| `POST` | `/api/instances`, `DELETE /api/instances/{id}` | Start / stop model subprocesses |
| `POST` / `PUT` / `DELETE` | `/api/executables*`, `/api/profiles*` | Add / edit / delete executables and launch profiles |
| `POST` | `/api/run/{id}`, `/api/tasks` | Trigger inference tasks |
| `DELETE` | `/api/tasks/{id}`, `/api/history/*` | Cancel tasks / delete history records and audio |
| `POST` | `/api/audio/upload`, `/api/voices*` | Upload audio; add / modify / delete the voice library |
| `POST` | `/api/fs/mkdir` | **Create folders at any writable server path** |
| `POST` / `DELETE` | `/api/downloads*` | Download weights (writes to `models/`); delete tasks |

The `/api/fs/*` endpoints intentionally expose server-local filesystem browsing and directory creation — this is by design (the hub is a local single-user tool). See [`SECURITY.md`](SECURITY.md) for the threat model and vulnerability-reporting channel.

## Development & Contributing

Build steps, code style and pre-commit checks are in [`CONTRIBUTING.md`](CONTRIBUTING.md); see [`CHANGELOG.md`](CHANGELOG.md) for the change history.

## Frontend (web/)

The Web UI is plain HTML/CSS/JS in `web/`: **no framework, no build step, and no Node.js at runtime** — the Go server
serves the static files straight from disk, so a browser refresh is all it takes. The Node/npm toolchain is
**dev/CI-only** (TypeScript `checkJs`, ESLint, Prettier, Playwright e2e, node:test unit tests) and does not ship;
the files in `web/` *are* the release artifact — there are no bundled outputs.

It is organised in two layers: classic scripts (attaching to `window.*`, loaded in the `<script>` order at the bottom of
`index.html`) plus `web/app.js` driving 20 native ES modules under `web/modules/*` (no bundling or transpiling — the
browser resolves them by URL). i18n is split into the pure-data dictionaries `web/i18n.zh.js` / `web/i18n.en.js` and the
runtime `web/i18n.js`; every HTTP request goes through `web/api-client.js` (`window.AudioCppHub.api`, with the error
envelope, timeout/abort handling and visibility-aware polling); `web/boot.js` restores the theme and UI language before
first paint, and `web/styleguide.html` is a component style guide.

See [`web/README.md`](web/README.md) for the module map, state and polling model, coding conventions and contribution
checklist. Architecture/sequence/state diagrams live in [`docs/diagrams/`](docs/diagrams/); demo GIFs in
[`docs/assets/`](docs/assets/); the API contract the frontend calls is in [`docs/API.md`](docs/API.md);
e2e/unit tests and the performance budget in [`TESTING.md`](TESTING.md); offline & installability (PWA) in
[`docs/pwa.md`](docs/pwa.md) and the motion system in [`docs/motion.md`](docs/motion.md).

## Tech Stack & Provenance

- Go 1.27, native single binary; the only dependencies are `github.com/getlantern/systray` (Windows tray) and `golang.org/x/sys`
- Frontend: plain HTML/CSS/JS, no framework and no build; classic scripts plus 20 ES modules in `web/modules/*`, bilingual strings in `web/i18n.zh.js` / `web/i18n.en.js`, a single HTTP entry point in `web/api-client.js`, and PWA support via `web/sw.js` + `web/manifest.webmanifest`
- Dev-only toolchain (not shipped): TypeScript `checkJs`, ESLint, Prettier, Playwright, node:test; no bundler
- This project is a companion management panel for [audio.cpp](https://github.com/0xShug0/audio.cpp) (fork maintained at <https://github.com/matthewhand/audio.cpp-hub>); it does not bundle upstream binaries — models and inference come from the upstream project
