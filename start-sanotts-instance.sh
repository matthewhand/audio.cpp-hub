#!/usr/bin/env bash
# start-sanotts-instance.sh — host-local boot helper (10.0.0.36).
# Starts the secondary 'sanotts' instance if absent and waits for READY.
# Deliberately tolerant: never fails the service boot (breeze must still serve).
set -u

HUB_URL="http://127.0.0.1:18080"
MODEL_ID="sanotts"
NAME="sanotts"
WEIGHTS="/home/matthewh/audio.cpp-hub/runtime/models/sanoTTS-heart-nano-GGUF"
BACKEND="vulkan"
DEVICE=0
THREADS=4
# Warm-model policy: no idle unload + boot warm-up so sanotts answers instantly
IDLE_UNLOAD_MS=0
WARMUP_TEXT="Warm-up."

log() { printf '[start-sanotts] %s\n' "$*" >&2; }

# Wait for the hub API (ExecStartPost runs after ExecStart, but the hub needs a moment)
for i in $(seq 1 30); do
  curl -fsS -m 2 "$HUB_URL/api/models" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS -m 2 "$HUB_URL/api/models" >/dev/null 2>&1 || { log "hub not reachable; skipping"; exit 0; }

# Idempotent: skip if an instance with this name already exists
if curl -fsS -m 5 "$HUB_URL/api/instances" 2>/dev/null | grep -q "\"instanceName\":\"$NAME\""; then
  log "instance '$NAME' already exists; nothing to do"
  exit 0
fi

log "starting instance name=$NAME modelId=$MODEL_ID backend=$BACKEND"
curl -fsS -m 10 -X POST "$HUB_URL/api/instances" \
  -H 'Content-Type: application/json' \
  --data-raw "{\"modelId\":\"$MODEL_ID\",\"name\":\"$NAME\",\"weightsPath\":\"$WEIGHTS\",\"backend\":\"$BACKEND\",\"device\":$DEVICE,\"threads\":$THREADS,\"idleUnloadMs\":$IDLE_UNLOAD_MS,\"executableId\":\"vulkan\"}" \
  >/dev/null 2>&1 || { log "start request failed; skipping"; exit 0; }

for i in $(seq 1 60); do
  ST=$(curl -fsS -m 3 "$HUB_URL/api/instances" 2>/dev/null | python3 -c "
import json,sys
try:
    xs=json.load(sys.stdin)
    print(next((x['status'] for x in xs if x['instanceName']=='$NAME'),'NONE'))
except Exception:
    print('NONE')
")
  case "$ST" in
    READY)    break ;;
    STARTING) sleep 2 ;;
    *)        log "instance '$NAME' status=$ST; giving up (boot continues)"; exit 0 ;;
  esac
done
if [[ "${ST:-}" != "READY" ]]; then
  log "instance '$NAME' did not reach READY in time (boot continues)"
  exit 0
fi

# Warm the model into VRAM (READY does not prove the weights are resident)
rm -f /tmp/sanotts-warmup.wav
curl -fsS -m 120 -X POST "$HUB_URL/v1/audio/speech" \
  -H 'Content-Type: application/json' \
  --data-raw "{\"model\":\"$NAME\",\"input\":\"$WARMUP_TEXT\",\"response_format\":\"wav\"}" \
  -o /tmp/sanotts-warmup.wav \
  || { log "warm-up request failed (boot continues)"; exit 0; }
[[ -s /tmp/sanotts-warmup.wav ]] && log "instance '$NAME' warm (model resident in VRAM)"
exit 0
