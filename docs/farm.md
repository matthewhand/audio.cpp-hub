# Multi-host voice farm

Three hosts serve TTS/ASR over the LAN. All endpoints are OpenAI-flavored
(`POST /v1/audio/speech`, `GET /v1/models`) and LAN-only, no auth — do not
expose any of them to the public internet.

**Start here:** point clients at the fan-out `http://10.0.0.36:18082` for TTS and
discovery; the `:18080` table below is the per-host detail behind it.

| Host | Hardware | Endpoint | Instances | Notes |
|---|---|---|---|---|
| `10.0.0.36` (ubuntu-gtx) | GTX 1080 8 GB, Vulkan | `:18080` | `breeze` (always warm), `sanotts` (always warm), `citrinet` ASR (5-min idle unload) | Host-native systemd service (`audio-cpp-hub.service`), see [deployment-10.0.0.36.md](deployment-10.0.0.36.md) |
| `10.0.0.30` (ubuntu-max) | Strix Halo iGPU (Radeon 8060S, 128 GB GTT), RX 6600 XT idle | `:18080` | `breeze` (warm via `ExecStartPost`) | Docker `audio-cpp-hub-amd`, image `audio-cpp-hub:amd` (Mesa RADV) |
| `10.0.0.30` (second hub) | same iGPU | `:18081` | `qwen3-vd` (voice-design, `instruct` top-level) | Docker `audio-cpp-hub-amd-qwen3`, image `audio-cpp-hub:amd-a3bfac4`, state dirs `data-qwen3/ logs-qwen3/ run-qwen3/` |
| `10.0.0.32` (WINDOWS2) | Ryzen 9 5950X, CPU only (in Docker) | `:18080` | `sanotts` (fast tiny TTS) | Docker Desktop (WSL2), container `audio-cpp-hub-cpu`, image `audio-cpp-hub:cpu-espeak` |

## Unified fan-out entrypoint — `http://10.0.0.36:18082`

`cmd/fanout-proxy` (tiny Go router, stdlib only) sits in front of the four hubs
above and gives agents one OpenAI-shaped base URL with automatic failover, so
they no longer hard-code `host:port:model` triples:

| Alias | Serves from (in order) |
|---|---|
| `breeze`, `expressive` | `.36:18080 breeze` → `.30:18080 breeze` |
| `qwen3-vd`, `voice-design-fast` | `.30:18081 qwen3-vd` |
| `sanotts`, `instant` | `.36:18080 sanotts` → `.32:18080 sanotts` |
| `citrinet`, `stt` | `.36:18080 citrinet` |

- `POST /v1/audio/speech` routes on `model`, rewrites it to the upstream service
  name, streams the audio back and fails over on hub-down / 5xx / "instance not
  READY". `GET /v1/models` lists only aliases that currently resolve.
- `GET /farm/health` — per-hub up/down + latency + which backend each alias
  resolved to, plus `inFlightCap` / per-target `inFlight`;
  `GET /api/instances` — the whole farm's instances in one list.
- **Per-origin in-flight cap** (`maxInFlightPerTarget`, default `2`, `<= 0`
  disables): at most N speech forwards may be in flight per hub+service. A hub
  runs one engine per instance with a serial queue, so an uncapped router lets
  one loud agent fill `.36 breeze`'s queue while everything else stalls
  invisibly. A target at its cap is skipped, so the request spills to the
  standby; only a route whose every target is busy answers `429` +
  `Retry-After: 5` (not `503`). `qwen3-vd` and `citrinet` are single-target, so
  parallel callers there get 429s past the cap — OpenAI SDKs retry those
  automatically. Knob details: `cmd/fanout-proxy/README.md` → "Knobs".
- History is **not** unified: responses carry `X-Fanout-Hub` /
  `X-Fanout-Instance` so a take can be fetched from the origin hub's
  `/api/history/...`. Same for voice libraries and STT: the fan-out proxies
  `/v1/audio/speech` only, so `/api/tasks`, `/api/voices` and `/api/history/*`
  go to `.36:18080` directly. The `citrinet` alias exists for routing/health
  coverage, but a speech call against it 503s (the engine wants an audio
  contract, not text) — STT uses the task API.
- The 6600 XT (`.30` DEVICE=0) is deliberately absent from the route table, and
  no hub is reconfigured by the proxy. LAN-only, no auth — same warning as
  above. Design and rationale: `docs/fanout-design.md`; ops:
  `cmd/fanout-proxy/README.md`; agent contract: `docs/agent-api.md`.

## 10.0.0.30 — two containers on one host

The prod container (port 18080) is managed by `compose.amd.yaml`. The qwen3
hub was started with an equivalent `docker run` (no compose service so the
container name doesn't clash):

```
docker run -d --name audio-cpp-hub-amd-qwen3 --restart unless-stopped \
  -p 18081:18080 \
  -e AUDIOCPP_BACKEND=vulkan -e AUDIOCPP_DEVICE=1 -e AUDIOCPP_THREADS=4 \
  -e AUDIOCPP_MODEL_ID=qwen3_tts_voicedesign -e AUDIOCPP_SERVICE_NAME=qwen3-vd \
  -e AUDIOCPP_WEIGHTS=/audio.cpp/models/qwen3-tts-12hz-1.7b-voicedesign-q8_0.gguf \
  -e LD_LIBRARY_PATH=/audio.cpp/bin:/usr/lib/x86_64-linux-gnu:/lib/x86_64-linux-gnu \
  -e MESA_VK_DEVICE_SELECT_FORCE_DEFAULT_DEVICE=0 \
  --device /dev/dri --device /dev/kfd --group-add 44 --group-add 993 \
  -v ~/audio.cpp-hub/data-qwen3:/app/data \
  -v ~/audio.cpp-hub/logs-qwen3:/app/logs \
  -v ~/audio.cpp-hub/run-qwen3:/app/run \
  -v ~/audio.cpp/bin-vulkan-0.8.0:/audio.cpp/bin:ro \
  -v ~/audio.cpp-hub/models/Qwen3-TTS-12Hz-1.7B-VoiceDesign-GGUF/qwen3-tts-12hz-1.7b-voicedesign-q8_0.gguf:/audio.cpp/models/qwen3-tts-12hz-1.7b-voicedesign-q8_0.gguf:ro \
  audio-cpp-hub:amd-a3bfac4
```

Both hubs run their engine on the Strix Halo iGPU (`AUDIOCPP_DEVICE=1`); the
iGPU's unified GTT pool has room for breeze (~4 GB) plus qwen3-vd (~3 GB).

**Known issue — RX 6600 XT Vulkan compute:** pointing the qwen3 hub at the
dGPU (`AUDIOCPP_DEVICE=0`) dies mid-inference with
`vk::Queue::submit: ErrorDeviceLost` / `radv: CS cancelled, context is lost`
(the host is a Proxmox LXC with both GPUs passed through). The iGPU is the
workaround. Retry `DEVICE=0` after a host GPU driver/kernel update.

`~/audio.cpp/` (15 GB) is **required** on this host: the containers mount
`bin-vulkan-0.8.0/` (engine + ggml libs) and `breeze/breeze-tts-2-q8_0.gguf`
from it. Do not delete it here.

## 10.0.0.32 — Windows CPU node

Layout on `E:\` (C: and E: are nearly full; this deployment adds ~200 MB):

```
E:\audiocpp\bin\        audiocpp_server + libs (Linux ELF from .36, Zen3 build)
E:\audiocpp\models\sanoTTS-heart-nano-GGUF\   model package (config.json + gguf)
E:\audiocpp-hub\{data,logs,run}\              hub state (mounts)
E:\audiocpp\hub-cpu-espeak.tar.gz             image tarball (kept for re-load)
```

Image distribution avoids installing a Go toolchain on Windows: build on a
Linux host, `docker save | gzip`, scp, `docker load -i`.

Gotchas hit during deployment (all resolved):

1. **E: drive not mounted in the Docker WSL VM** — `docker run -v E:\...`
   fails with `mkdir /run/desktop/mnt/host/e: file exists`. Fix:
   `wsl --shutdown` (Docker Desktop rebuilds the VM and re-shares drives).
2. **Engine wants the model *package*, not a bare gguf.** For a gguf path the
   engine resolves `config.json` (+ package marker) from the file's parent
   dir. Mount the package directory *as* `/audio.cpp/models` and set
   `AUDIOCPP_WEIGHTS=/audio.cpp/models/heart-nano-f32.gguf` (the boot helper
   requires a file path; the engine reads the package around it).
3. **sanoTTS requires eSpeak-ng** (phonemizer). The plain hub image does not
   include it; instance starts then 500s on first request and the container
   crash-loops. Image `audio-cpp-hub:cpu-espeak` adds it:
   `FROM audio-cpp-hub:cpu-a3bfac4` + `apt-get install espeak-ng`. Rebuild on
   any online Linux host and re-ship the tarball.

CPU performance is a non-issue for sanotts: ~30–300 ms per sentence.

## Client routing quick reference

- One base URL for everything TTS: `http://10.0.0.36:18082` (fan-out, failover
  included) — preferred for agents and the default in
  `clients/audiocpp_client.py` (`DEFAULT_HUB`).
- One hub URL for the rest: `http://10.0.0.36:18080` for STT, upload, voice
  library and history — that client's `DEFAULT_DIRECT_HUB` (`--direct-hub` /
  `AUDIOCPP_DIRECT_HUB_URL`), because the fan-out proxies TTS only and the state
  is per host.
- Per-host direct access, when you want to pin a take to one box:
  - Expressive / sarcastic voice design: `.36:18080` model `breeze`
    (`options.instruction`) or `.30:18081` model `qwen3-vd` (top-level
    `instruct`, ~2.5x faster than breeze).
  - Instant TTS: `.36:18080` or `.32:18080`, model `sanotts`.
  - Standby breeze (if .36 is down): `.30:18080` model `breeze`.
  - STT: `.36:18080` model `citrinet` via async `POST /api/tasks`.

Quick checks against the farm:

```
curl -s http://10.0.0.36:18082/farm/health | python3 -m json.tool   # who is up, where aliases resolve
curl -s http://10.0.0.36:18082/v1/models                           # aliases with a READY backend
./clients/audiocpp_client.py health                                 # same, readable, no deps
```

## Open WebUI — TTS wiring

Open WebUI (`:3000` on `.36`) has no fan-out awareness, so it must be pointed at
`:18082` by hand. **Admin → Settings → Audio:**

| Setting | Value | Why |
|---|---|---|
| TTS Engine | **OpenAI** | the fan-out speaks `POST /v1/audio/speech` only |
| OpenAI API Base URL | `http://10.0.0.36:18082/v1` | **`:18082`, not `:18080`** — failover across the farm; `:18080` is one hub, so a restart of `.36` takes voice off the air |
| TTS Model | `breeze` · `expressive` · `sanotts` · `instant` · `qwen3-vd` | fan-out aliases (the table above), not hub service names |
| Voice | leave a placeholder | audiocpp ignores the OpenAI `voice` field entirely; a value there is noise, not an error |

If the TTS model list looks empty, the base URL is wrong (`:18080` returns hub
service names, not aliases) or the backend is down — check
`curl -s http://10.0.0.36:18082/v1/models`.

**STT does not work through this path.** The fan-out does not speak OpenAI
`POST /v1/audio/transcriptions`, and OWUI's built-in OpenAI STT would need an
adapter to reach `citrinet`; there is none, so don't point OWUI's STT config at
`:18082` or `:18080` expecting it to work. Transcription stays on the hub task
API (`.36:18080`, service `citrinet`) — the Python client's `transcribe()`, or
`POST /api/tasks` directly. Contract: [agent-api.md §2](agent-api.md#2-speech--text-stt).

Because OWUI can't set per-request `options.instruction`, keep expressive voice
design (`qwen3-vd`, `breeze` + instruction) for API/agent use; from OWUI pick
the alias whose default delivery you want.
