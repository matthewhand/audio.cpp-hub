#!/usr/bin/env bash
# start-json-instance.sh PAYLOAD.json [HUB_URL]
# Idempotently start one audio.cpp-hub instance from a saved POST /api/instances payload.
#  - skips (exit 0) if an instance with the payload "name" already exists (any status)
#  - skips (exit 0) if weightsPath is missing on disk, or the payload is unreadable
#  - otherwise POSTs the payload and waits up to START_JSON_WAIT_SECONDS (default 90) for READY
# Intended for systemd ExecStartPost=- (tolerant) lines; never needs to fail the unit.
set -Euo pipefail
PAYLOAD="${1:?usage: start-json-instance.sh PAYLOAD.json [HUB_URL]}"
HUB_URL="${2:-${HUB_URL:-http://127.0.0.1:18080}}"
WAIT="${START_JSON_WAIT_SECONDS:-90}"
log() { printf '[start-json] %s\n' "$*" >&2; }
[ -r "$PAYLOAD" ] || { log "payload not readable: $PAYLOAD; skipping"; exit 0; }
field() { python3 -c 'import json,sys;v=json.load(open(sys.argv[1])).get(sys.argv[2],"");print(v if isinstance(v,str) else "")' "$PAYLOAD" "$1" 2>/dev/null; }
NAME="$(field name)"; WEIGHTS="$(field weightsPath)"
[ -n "$NAME" ] || { log "payload has no name: $PAYLOAD; skipping"; exit 0; }
if [ -n "$WEIGHTS" ] && [ ! -e "$WEIGHTS" ]; then log "$NAME: weights missing ($WEIGHTS); skipping"; exit 0; fi
for _ in $(seq 60); do curl -fsS -m2 "$HUB_URL/api/models" >/dev/null 2>&1 && break; sleep 1; done
st() { curl -fsS -m5 "$HUB_URL/api/instances" | python3 -c 'import json,sys;n=sys.argv[1];print(next((x.get("status","") for x in json.load(sys.stdin) if x.get("instanceName")==n),""))' "$NAME"; }
cur="$(st)" || { log "$NAME: hub not reachable at $HUB_URL; skipping"; exit 0; }
if [ -n "$cur" ]; then log "$NAME: already exists (status $cur); no-op"; exit 0; fi
log "$NAME: starting from $PAYLOAD"
if ! curl -fsS -m30 -X POST "$HUB_URL/api/instances" -H 'Content-Type: application/json' --data-binary "@$PAYLOAD" >/dev/null; then
  log "$NAME: POST /api/instances failed"; exit 1
fi
for _ in $(seq "$WAIT"); do s="$(st)"; [ "$s" = READY ] && { log "$NAME: READY"; exit 0; }; case "$s" in ERROR|FAILED|STOPPED|"") break;; esac; sleep 1; done
log "$NAME: not READY (status ${s:-gone})"; exit 1