# Docker / Compose deployment (Go hub)

This repository ships the **Go** implementation of `audio.cpp-hub` as a single
static binary. The container images below are Go-native: the Java deployment
(`eclipse-temurin` image, `lib/` jars, `build/classes`, systemd unit) is
**superseded and retired**. Do not run the old Java container or the systemd
unit anymore.

| File | Purpose |
| --- | --- |
| `Dockerfile` | Generic image (CPU / general Vulkan). Multi-stage: `golang:1.27` → `debian:bookworm-slim`. |
| `Dockerfile.amd` | AMD GPU image (Vulkan via Mesa RADV). Multi-stage: `golang:1.27` → `ubuntu:24.04`. |
| `compose.yaml` | Generic Compose service (`docker compose up -d --build`). |
| `compose.amd.yaml` | AMD GPU Compose service (`docker compose -f compose.amd.yaml up -d --build`). |
| `docker/start-hub.sh` | Container entrypoint: runs the Go hub, optionally launches + warms one instance. |
| `docker/start-instance.sh` | Env-driven instance launcher, talks to the hub HTTP API. |
| `docker/executables.json` | Registers `/audio.cpp/bin/audiocpp_server` as the default executable. |

The Go hub serves the UI from `web/` **on disk** (`http.FileServer(http.Dir("web"))`),
so `web/` is copied into the image. `models.json` / `model-packages.json` are
`go:embed`-ded and compiled into the binary. `hub.config.json` and
`executables.json` are read from the working directory `/app` at runtime.

## AMD GPU quick start

```bash
# 1. Stop and remove the old Java container (migration)
docker rm -f audio-cpp-hub-amd 2>/dev/null || true
sudo systemctl disable --now audio-cpp-hub.service 2>/dev/null || true

# 2. Provide host paths (put these in a .env file next to the compose file)
cat > .env <<'EOF'
HOST_AUDIOCPP_BIN=/home/matthewh/audio.cpp/bin
HOST_AUDIOCPP_WEIGHTS=/home/matthewh/audio.cpp/breeze/breeze-tts-2-q8_0.gguf
AUDIOCPP_DEVICE=0
AUDIOCPP_THREADS=4
# host-specific GPU group ids (getent group video render | cut -d: -f3)
GPU_GID_VIDEO=44
GPU_GID_RENDER=993
EOF

# 3. Build + start
docker compose -f compose.amd.yaml up -d --build
curl -fsS http://127.0.0.1:18080/api/models | head -c 200
curl -fsS http://127.0.0.1:18080/v1/models
```

The service publishes `http://<host>:18080`, restarts with `unless-stopped`,
creates the child instance if absent, waits for `READY`, then sends a warm-up
speech request. Enable Docker at host boot so Compose restarts automatically:

```bash
sudo systemctl enable --now docker
```

## Environment contract

Both names are accepted; the `AUDIOCPP_*` name takes precedence. Compose wires
the generic name into the canonical variable (see `compose.amd.yaml`).

| Generic | Canonical (live contract) | Default | Meaning |
| --- | --- | --- | --- |
| `MODEL_ID` | `AUDIOCPP_MODEL_ID` | `breeze-tts` | hub model id |
| `SERVICE_NAME` | `AUDIOCPP_SERVICE_NAME` | `breeze` | `/v1/*` routing name (instanceName) |
| `WEIGHTS` | `AUDIOCPP_WEIGHTS` | `/audio.cpp/models/breeze-tts-2-q8_0.gguf` | weight file path **inside container** |
| `VOICE_REF` | `AUDIOCPP_VOICE_REF` | empty | reference audio path (optional) |
| `DEVICE` | `AUDIOCPP_DEVICE` | `0` | device index passed to the engine |
| `BACKEND` | `AUDIOCPP_BACKEND` | `vulkan` (AMD) / `cpu` (generic) | engine backend (`vulkan`/`hip`/`cpu`) |
| `THREADS` | `AUDIOCPP_THREADS` | `4` | CPU threads |
| `WARMUP_TEXT` | — | short English sentence | warm-up sentence |
| — | `AUDIOCPP_EXECUTABLE_ID` | first entry | pick a specific `executables.json` entry |
| — | `HUB_URL` | `http://127.0.0.1:18080` | hub base URL used by `start-instance.sh` |

If `AUDIOCPP_WEIGHTS` is empty the entrypoint runs the **hub only** and skips
instance launch — useful for smoke tests and CI.

## AMD GPU requirements (manual test)

- Host must expose the render nodes: `/dev/dri` (and `/dev/kfd` for HIP builds).
- The host user's `video`/`render` group GIDs must be passed via `group_add`
  (`GPU_GID_VIDEO`, `GPU_GID_RENDER`).
- Mesa RADV comes from `mesa-vulkan-drivers` in the image (Ubuntu 24.04 Noble is
  required for RDNA3 / GFX1100+; older cards work too).
- `audiocpp_server` and its ggml shared libraries are **not** in the image. Mount
  them read-only:

```text
${HOST_AUDIOCPP_BIN}:/audio.cpp/bin:ro
${HOST_AUDIOCPP_WEIGHTS}:${AUDIOCPP_WEIGHTS}:ro
```

Validate GPU visibility before serving traffic:

```bash
# Vulkan device list inside the container
docker compose -f compose.amd.yaml run --rm --no-deps \
  --entrypoint /bin/bash audio-cpp-hub \
  -lc 'vulkaninfo --summary | head -40; /audio.cpp/bin/audiocpp_server --list-devices'
```

`--list-devices` must report a Vulkan device (e.g. `Vulkan:0`). If it reports
only `CPU:0`, stop and fix the passthrough/Mesa setup before using the
deployment.

Manual end-to-end check:

```bash
curl -fS --max-time 240 http://127.0.0.1:18080/v1/audio/speech \
  -H 'Content-Type: application/json' \
  --data-raw '{"model":"breeze","input":"Docker Compose Go hub test.","response_format":"wav"}' \
  -o /tmp/breeze.wav && file /tmp/breeze.wav
```

## Persistence

`data/`, `logs/`, and `run/` are bind-mounted from the repository root and
persist across container restarts:

```yaml
volumes:
  - ./data:/app/data   # uploads, voices, history, task + download state, profiles
  - ./logs:/app/logs
  - ./run:/app/run     # run/<id>/server.json + server.log, /v1 proxy cache
```

## Migration from the Java deployment

1. `docker rm -f audio-cpp-hub-amd` (old Java container).
2. `docker image rm audio-cpp-hub:amd` if it pointed at the Java build.
3. `sudo systemctl disable --now audio-cpp-hub.service` (old systemd unit).
4. Keep `data/` unchanged — the Go hub reads the same `data/history`,
   `data/voices`, `data/uploads`, `data/profiles.json`.
5. Start the Go deployment as shown above. The old Java container files
   (`src/`, `lib/`, `build/classes`) are no longer used by the image.

## Notes / known limits

- This is a LAN/local tool with **no authentication**. Do not expose port 18080
  to the public internet; front it with a reverse proxy + HTTPS.
- The hub is unprivileged and binds only `18080`; child instances bind
  `127.0.0.1:18090+` inside the container and are reached only through the hub.
- The image runs as root (like the old Java image) so the bind-mounted `run/`
  and `data/` directories are writable regardless of host ownership.
