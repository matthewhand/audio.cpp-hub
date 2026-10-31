#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/compose.sanotts-cpu.yaml"
LOCK_FILE="$ROOT/deploy/sanotts-cpu/upstream.lock.json"

command -v docker >/dev/null 2>&1 || { echo "docker CLI is required" >&2; exit 1; }
docker compose version >/dev/null

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$TMP_DIR/package"
printf '%s\n' 'FROM scratch' > "$TMP_DIR/package/Dockerfile"

SANOTTS_PACKAGE_DIR="$TMP_DIR/package" \
AUDIOCPP_STARTUP_MODE=hub-only \
AUDIOCPP_WARMUP_POLICY=skip \
AUDIOCPP_WEIGHTS= \
SANOTTS_BIND_ADDRESS=127.0.0.1 \
SANOTTS_PORT=18081 \
AUDIOCPP_THREADS=4 \
  docker compose -f "$COMPOSE_FILE" --profile sanotts-cpu config --format json \
  > "$TMP_DIR/compose.json"

python3 - "$TMP_DIR/compose.json" "$LOCK_FILE" "$ROOT/scripts/build-sanotts-cpu.sh" <<'PY'
import json
import re
import sys

compose = json.load(open(sys.argv[1], encoding="utf-8"))
lock = json.load(open(sys.argv[2], encoding="utf-8"))
dockerfile = open(sys.argv[2].replace("upstream.lock.json", "Dockerfile"), encoding="utf-8").read()
executable = json.load(open(sys.argv[2].replace("upstream.lock.json", "sanotts-executables.json"), encoding="utf-8"))
build_script = open(sys.argv[3], encoding="utf-8").read()
service = compose["services"]["sanotts-cpu"]

assert service["profiles"] == ["sanotts-cpu"]
assert service["restart"] == "no"
assert service["read_only"] is True
assert "ALL" in service["cap_drop"]
assert "no-new-privileges:true" in service["security_opt"]
assert service["environment"]["AUDIOCPP_STARTUP_MODE"] == "hub-only"
assert service["environment"]["AUDIOCPP_WARMUP_POLICY"] == "skip"
assert service["environment"]["AUDIOCPP_WEIGHTS"] == ""
assert service["environment"]["AUDIOCPP_BACKEND"] == "cpu"
assert service["environment"]["AUDIOCPP_EXECUTABLE_ID"] == "cpu"
assert service["ports"][0]["host_ip"] == "127.0.0.1"
assert service["ports"][0]["target"] == 18080
assert service["ports"][0]["published"] == "18081"
assert service["healthcheck"]["test"][-1].endswith("/api/models")

mounts = service["volumes"]
assert {m["target"] for m in mounts} == {"/audio.cpp/models", "/app/data", "/app/logs", "/app/run"}
assert all(m["type"] == "volume" for m in mounts), mounts
assert all("source" in m for m in mounts)
model_mount = next(m for m in mounts if m["target"] == "/audio.cpp/models")
assert model_mount["read_only"] is True

assert lock["target"] == {"os": "linux", "architecture": "amd64", "backend": "cpu"}
assert re.fullmatch(r"[0-9a-f]{40}", lock["audio_cpp"]["commit"])
assert re.fullmatch(r"[0-9a-f]{40}", lock["audio_cpp"]["server_frontends_commit"])
assert re.fullmatch(r"[0-9a-f]{40}", lock["sanotts"]["revision"])
for item in (
    lock["hub_toolchain"]["go_archive_sha256"],
    lock["espeak_ng"]["source_sha256"],
    lock["sanotts"]["weights"]["sha256"],
    lock["sanotts"]["config"]["sha256"],
    lock["sanotts"]["readme"]["sha256"],
    lock["sanotts"]["gpl_license"]["sha256"],
    lock["sanotts"]["mit_license"]["sha256"],
):
    assert re.fullmatch(r"[0-9a-f]{64}", item)
assert "UNRESOLVED" in lock["sanotts"]["weights_license_status"]
assert lock["runtime_image"]["digest"].startswith("sha256:")
assert lock["runtime_image"]["platform"] == "linux/amd64"
assert f"FROM {lock['runtime_image']['reference']}@{lock['runtime_image']['digest']}" in dockerfile
assert lock["runtime_image"]["apt_snapshot"] in dockerfile
assert "COPY models/" not in dockerfile
assert "SANOTTS_MODEL_OUTPUT_DIR" in build_script
assert "$OUT_DIR/models" not in build_script
assert len(executable) == 1 and executable[0]["id"] == "cpu"
assert executable[0]["path"] == "/audio.cpp/bin/audiocpp_server"

print("SanoTTS CPU Compose/lock checks passed (config only; no image build or container start).")
PY
