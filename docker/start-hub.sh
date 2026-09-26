#!/usr/bin/env bash
# start-hub.sh — 容器入口：启动 Go 版 audio.cpp-hub，并按需拉起一个模型实例。
#
# 与 Java 版保持同一环境变量契约（见 docker/start-instance.sh）：
#   AUDIOCPP_WEIGHTS / AUDIOCPP_MODEL_ID / AUDIOCPP_SERVICE_NAME /
#   AUDIOCPP_BACKEND / AUDIOCPP_DEVICE / AUDIOCPP_THREADS / AUDIOCPP_VOICE_REF /
#   WARMUP_TEXT
#
# - 设置 AUDIOCPP_WEIGHTS 时：hub 起来后自动创建并预热一个实例，失败即退出（与 Java 版一致）。
# - 未设置 AUDIOCPP_WEIGHTS 时：只运行 hub（方便本地 / CI 冒烟测试）。
set -Eeuo pipefail

HUB_BIN="${HUB_BIN:-/usr/local/bin/audio.cpp-hub}"

echo "[start-hub] 启动 Go hub: $HUB_BIN" >&2
"$HUB_BIN" &
hub_pid=$!

shutdown() {
  kill -TERM "$hub_pid" 2>/dev/null || true
  wait "$hub_pid" 2>/dev/null || true
}
trap shutdown TERM INT

if [[ -n "${AUDIOCPP_WEIGHTS:-}" ]]; then
  if ! /usr/local/bin/start-instance.sh; then
    echo "[start-hub] 实例启动失败，停止 hub" >&2
    shutdown
    exit 1
  fi
else
  echo "[start-hub] AUDIOCPP_WEIGHTS 未设置，跳过自动实例启动（仅运行 hub）" >&2
fi

wait "$hub_pid"
