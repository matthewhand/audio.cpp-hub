# Host-native deployment — host `10.0.0.36` (ubuntu-gtx)

How this machine runs audio.cpp-hub. Written 2026-09-29. The Docker path is documented
in [DOCKER.md](../DOCKER.md) but is **not used here** (see "Why not Docker" below).

## Architecture

```
systemd: audio-cpp-hub.service (enabled, Restart=on-failure)
└── /home/matthewh/audio.cpp-hub/bin/audio.cpp-hub      # static Go hub, port 18080
    ├── ExecStartPost: docker/start-instance.sh         # breeze (strict: failure aborts boot)
    │     env: AUDIOCPP_* — see the unit file
    └── ExecStartPost: start-sanotts-instance.sh        # secondary instances (tolerant: never fails boot)

Instances (each = one audiocpp_server child process, 127.0.0.1, lazy_load):
    breeze   modelId breeze-tts   port 18090  threads 10   weights runtime/breeze-tts-2-q8_0.gguf
    sanotts  modelId sanotts      port 18091  threads 4    weights runtime/models/sanoTTS-heart-nano-GGUF
    citrinet modelId citrinet_asr port 18092  threads 4    weights models/Citrinet-ASR-GGUF (hub downloader)
```

## Client entrypoints from this host

This hub answers on `:18080`, but agents should not hard-code it:

- **TTS + discovery → `http://10.0.0.36:18082`**, the fan-out proxy running on
  this host (`cmd/fanout-proxy`, `audio-cpp-fanout.service`). One URL for the
  whole farm with failover to `.30` / `.32`. This is the default in
  `clients/audiocpp_client.py`.
- **STT, upload, voice library, history → `http://10.0.0.36:18080`**: the fan-out
  proxies `/v1/audio/speech` only, and each hub owns that state (this host also
  holds the `persona_*` voice library and all `breeze` / `sanotts` takes).

Fan-in hub for the other hosts is `farm.routes.json` in `cmd/fanout-proxy/`.
Fan-out is also what Open WebUI's TTS config should point at (`:3000` on this
host) — see [farm.md → Open WebUI TTS wiring](farm.md#open-webui--tts-wiring).

## Directory layout (host-local, not in git)

| Path | Purpose |
| --- | --- |
| `bin/audio.cpp-hub` | static hub binary (`CGO_ENABLED=0`), built from this repo |
| `runtime/bin/` | `audiocpp_server` + cli + gguf (relocated from the old `~/audio.cpp/`) |
| `runtime/vulkan-loader/` | Vulkan SDK 1.3.296 loader (`libvulkan.so.1`), injected via `executables.json` env |
| `runtime/breeze-tts-2-q8_0.gguf` | Breeze2TTS weights (4.7 GB) |
| `runtime/models/` | extra model weights (sanoTTS heart-nano) |
| `models/` | hub downloader target dir (`modelsDir`) |
| `data/`, `logs/`, `run/` | hub state (history, tasks, downloads, engine configs/logs, proxy cache) |
| `audio-cpp-hub.service` | systemd unit, installed to `/etc/systemd/system/` |
| `executables.json` | registers `runtime/bin/audiocpp_server` with the loader env (gitignored) |
| `hub.config.json` | hub config (port 18080, instances from 18090, HF endpoint; gitignored) |

## Build (no host Go toolchain required)

```bash
cd /home/matthewh/audio.cpp-hub
docker run --rm -v "$PWD":/src -w /src -e CGO_ENABLED=0 golang:1.27 \
  sh -c 'go build -buildvcs=false -trimpath \
         -ldflags "-s -w -X main.version=local-$(date +%Y%m%d)" \
         -o /src/bin/audio.cpp-hub.new .'
sudo chown matthewh:matthewh bin/audio.cpp-hub.new && mv bin/audio.cpp-hub.new bin/audio.cpp-hub
sudo systemctl restart audio-cpp-hub
```

`-buildvcs=false` is required when building via a container against this git checkout.

## Engine notes

- The engine binary has a baked RUNPATH pointing at the (deleted) `~/audio.cpp/1.3.296.0`
  Vulkan SDK; `executables.json` sets `LD_LIBRARY_PATH` to `runtime/vulkan-loader/` so the
  SDK loader resolves anyway. Do not delete `runtime/vulkan-loader/`.
- Instance `server.json` files in `run/<id>/` are regenerated on every start; engine-only
  fields are supplied via `idleUnloadMs` on `POST /api/instances` (wired through by the
  boot scripts), so they survive stop/start cycles. Engine config, not hub state.
- **Warm-model policy (client-facing latency)**: `breeze` and `sanotts` run with **no
  idle unload** (always resident, warm-up request at boot — first client request never
  pays a cold start). Only `citrinet` (internal ASR) unloads after 5 idle minutes
  (`idleUnloadMs: 300000`). Reload is automatic + lazy either way; see the idleUnloadMs
  feature commit for the measured 3851 → 156 MiB unload behavior.
- Recreating an instance: `DELETE /api/instances/<id>` then `POST /api/instances` — the
  hub only regenerates its fields, which is how per-instance `threads` are changed here.

## Why not Docker on this host

- nvidia-container-runtime injection works (devices + libs + ICD land in the container),
  but the NVIDIA Vulkan ICD is then rejected by the loader inside **any** container
  (`vk_icdGetInstanceProcAddr` refuses `vkCreateInstance`, `vulkaninfo` reproduces it with
  zero host-specific mounts). Suspected toolkit/loader interaction with this driver (535.309.01).
- Host-native, the same binary enumerates the GTX 1080 on the first try; all successful
  TTS runs on this machine predate the container era.
- The Go hub is a single static binary, so the container buys nothing here.

## Housekeeping on this host

- journald capped: `/etc/systemd/journald.conf.d/90-audiohub-caps.conf` (200M / keep 1G / 14d)
- docker daemon default log rotation: `/etc/docker/daemon.json` (10 MB × 3, applies to
  containers created after 2026-09-29; old containers keep their old settings)
- disk watchdog: `audiohub-disk-watchdog.timer` runs
  `/usr/local/sbin/disk-watchdog.sh` every 10 min; WARN ≥ 85 %, CRITICAL ≥ 90 % used;
  logs to the journal (tag `audiohub-disk`) and `logs/disk-watchdog.log`
