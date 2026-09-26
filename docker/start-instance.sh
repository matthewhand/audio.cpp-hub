#!/usr/bin/env bash
# start-instance.sh — 环境变量驱动的 hub 实例启动器（Go 版）。
# 适用于 audio.cpp-hub 支持的任何模型（breeze-tts、pocket-tts、kokoro、…）。
#
# 环境变量契约（同时接受 AUDIOCPP_* 别名与通用名，前者优先）：
#   AUDIOCPP_WEIGHTS  / WEIGHTS        权重 .gguf 绝对路径（容器内路径，必填）
#   AUDIOCPP_MODEL_ID / MODEL_ID       hub 模型 ID（默认 breeze-tts）
#   AUDIOCPP_SERVICE_NAME / SERVICE_NAME  /v1/audio/speech 路由服务名（默认 MODEL_ID）
#   AUDIOCPP_BACKEND  / BACKEND        vulkan | cpu | hip（默认 vulkan）
#   AUDIOCPP_DEVICE   / DEVICE         传给引擎的设备序号（默认 0）
#   AUDIOCPP_THREADS  / THREADS        CPU 线程数（默认 4）
#   AUDIOCPP_VOICE_REF / VOICE_REF     参考音频路径（可选）
#   WARMUP_TEXT                        预热句子（可选）
#   HUB_URL                            hub 基础地址（默认 http://127.0.0.1:18080）
#   AUDIOCPP_EXECUTABLE_ID             指定 executables.json 条目（可选，默认取第一条）
set -Eeuo pipefail

HUB_URL="${HUB_URL:-http://127.0.0.1:18080}"
MODEL_ID="${AUDIOCPP_MODEL_ID:-${MODEL_ID:-breeze-tts}}"
SERVICE_NAME="${AUDIOCPP_SERVICE_NAME:-${SERVICE_NAME:-$MODEL_ID}}"
WEIGHTS="${AUDIOCPP_WEIGHTS:-${WEIGHTS:-}}"
BACKEND="${AUDIOCPP_BACKEND:-${BACKEND:-vulkan}}"
DEVICE="${AUDIOCPP_DEVICE:-${DEVICE:-0}}"
THREADS="${AUDIOCPP_THREADS:-${THREADS:-4}}"
VOICE_REF="${AUDIOCPP_VOICE_REF:-${VOICE_REF:-}}"
EXECUTABLE_ID="${AUDIOCPP_EXECUTABLE_ID:-}"
SERVER_BIN="${AUDIOCPP_SERVER_BIN:-/audio.cpp/bin/audiocpp_server}"
WARMUP_TEXT="${WARMUP_TEXT:-This is a short startup warm-up.}"
WARMUP_WAV="/tmp/audio-cpp-hub-warmup.wav"
WAIT_SECONDS="${START_INSTANCE_WAIT_SECONDS:-180}"

log()   { printf '[start-instance] %s\n' "$*" >&2; }
fatal() { log "ERROR: $*"; exit 1; }

[[ -n "$WEIGHTS" ]]            || fatal "AUDIOCPP_WEIGHTS must be set"
[[ -x "$SERVER_BIN" ]]         || fatal "audiocpp_server not found / not executable at $SERVER_BIN"
[[ -f "$WEIGHTS" ]]            || fatal "Weight file not found: $WEIGHTS"

log "Waiting for hub at $HUB_URL …"
for ((i = 0; i < 60; i++)); do
  if curl -fsS --max-time 2 "$HUB_URL/api/models" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS --max-time 2 "$HUB_URL/api/models" >/dev/null \
  || fatal "hub did not become reachable within 60 s"

# --- look up existing instance by service name ---
instance_line() {
  curl -fsS --max-time 5 "$HUB_URL/api/instances" \
    | python3 -c "
import json, sys
name = '${SERVICE_NAME}'
for x in json.load(sys.stdin):
    if x.get('instanceName') == name or x.get('name') == name:
        print(x.get('id',''), x.get('status',''), x.get('port',''))
        break
"
}

line="$(instance_line || true)"
if [[ -z "$line" ]]; then
  log "No existing instance '$SERVICE_NAME'; starting model=$MODEL_ID backend=$BACKEND device=$DEVICE"
  start_payload="{\"modelId\":\"$MODEL_ID\",\"name\":\"$SERVICE_NAME\",\"weightsPath\":\"$WEIGHTS\",\"backend\":\"$BACKEND\",\"device\":$DEVICE,\"threads\":$THREADS"
  if [[ -n "$EXECUTABLE_ID" ]]; then
    start_payload="$start_payload,\"executableId\":\"$EXECUTABLE_ID\""
  fi
  start_payload="$start_payload}"
  curl -fsS --max-time 15 -X POST "$HUB_URL/api/instances" \
    -H 'Content-Type: application/json' \
    --data-raw "$start_payload" \
    >/tmp/audio-cpp-hub-start.json \
    || fatal "hub rejected the instance start request"
  line="$(instance_line || true)"
fi

[[ -n "$line" ]] || fatal "Instance '$SERVICE_NAME' not visible after start request"
read -r instance_id status child_port <<< "$line"
log "Instance $instance_id is $status on child port $child_port"

for ((i = 0; i < WAIT_SECONDS; i++)); do
  line="$(instance_line || true)"
  [[ -n "$line" ]] || fatal "Instance disappeared while waiting for READY"
  read -r instance_id status child_port <<< "$line"
  case "$status" in
    READY)    break ;;
    STARTING) sleep 1 ;;
    *) fatal "Instance entered unexpected status: $status" ;;
  esac
done
[[ "$status" == READY ]] || fatal "Instance did not become READY within ${WAIT_SECONDS}s"

log "Warming up '$SERVICE_NAME' (READY does not prove model is loaded into VRAM)"
rm -f "$WARMUP_WAV"
WARMUP_PAYLOAD="{\"model\":\"$SERVICE_NAME\",\"input\":\"$WARMUP_TEXT\",\"response_format\":\"wav\""
if [[ -n "$VOICE_REF" ]]; then
  WARMUP_PAYLOAD="$WARMUP_PAYLOAD,\"voice_ref\":\"$VOICE_REF\""
fi
WARMUP_PAYLOAD="$WARMUP_PAYLOAD}"

curl -fsS --max-time 300 -X POST "$HUB_URL/v1/audio/speech" \
  -H 'Content-Type: application/json' \
  --data-raw "$WARMUP_PAYLOAD" \
  -o "$WARMUP_WAV" \
  || fatal "Warm-up request failed"

[[ -s "$WARMUP_WAV" ]] || fatal "Warm-up output is empty"
[[ "$(dd if="$WARMUP_WAV" bs=1 count=4 2>/dev/null)" == RIFF ]] \
  || fatal "Warm-up output is not a valid WAV file"

wav_bytes="$(stat -c '%s' "$WARMUP_WAV")"
log "Warm-up OK: $WARMUP_WAV (${wav_bytes} bytes) — instance $instance_id port $child_port"
