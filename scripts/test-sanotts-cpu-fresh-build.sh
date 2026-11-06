#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_SCRIPT="$ROOT/scripts/build-sanotts-cpu.sh"
LOCK="$ROOT/deploy/sanotts-cpu/upstream.lock.json"
# Execute the real production CMake/build/verify phase with offline mocks.
sandbox="$(mktemp -d "${TMPDIR:-/tmp}/sanotts-cmake-order.XXXXXXXX")"
trap 'rm -rf -- "$sandbox"' EXIT
phase="$sandbox/build-phase.sh"
python3 - "$BUILD_SCRIPT" "$phase" <<'PY'
from pathlib import Path
import sys
source = Path(sys.argv[1]).read_text(encoding="utf-8")
start_marker = "\nESPEAK_ARCHIVE="
end_marker = "\nctest --test-dir"
assert source.count(start_marker) == 1, "missing/ambiguous eSpeak phase"
assert source.count(end_marker) == 1, "missing/ambiguous test boundary"
start = source.index(start_marker) + 1
end = source.index(end_marker, start)
Path(sys.argv[2]).write_text(source[start:end] + "\n", encoding="utf-8")
PY

run_case() (
  set -Eeuo pipefail
  local name="$1" reuse="$2" corrupt="$3"
  AUDIO_SRC="$sandbox/upstream-$name"
  AUDIO_BUILD="$sandbox/build-$name"
  ESPEAK_VERSION="1.52.0"
  ESPEAK_SHA="$(printf 'verified fixture\n' | sha256sum | cut -d ' ' -f1)"
  REUSE="$reuse"
  JOBS=1
  BAD_ESPEAK="$corrupt"

  fail() { echo "FAIL: $*" >&2; exit 1; }
  verify_sha() {
    printf '%s  %s\n' "$1" "$2" | sha256sum --check --status ||
      { echo "SHA mismatch: $2" >&2; exit 1; }
  }
  write_cmake_cache() {
    mkdir -p "$AUDIO_BUILD"
    : > "$AUDIO_BUILD/CMakeCache.txt"
    local opt setting key value kind
    for opt in "$@"; do
      [[ "$opt" == -D*=* ]] || continue
      setting="${opt#-D}"
      key="${setting%%=*}"
      value="${setting#*=}"
      if [[ "$value" == ON || "$value" == OFF ]]; then kind=BOOL; else kind=STRING; fi
      printf '%s:%s=%s\n' "$key" "$kind" "$value" >> "$AUDIO_BUILD/CMakeCache.txt"
    done
  }
  write_build_artifacts() {
    local archive="$AUDIO_BUILD/_deps/espeak-static/download/espeak-ng-$ESPEAK_VERSION.tar.gz"
    local copying="$AUDIO_BUILD/bin/licenses/espeak-ng/COPYING"
    mkdir -p "$(dirname "$archive")" "$(dirname "$copying")"
    if [[ "$BAD_ESPEAK" == 1 ]]; then
      printf 'corrupted fixture\n' > "$archive"
    else
      printf 'verified fixture\n' > "$archive"
    fi
    if [[ "$BAD_ESPEAK" != missing-copying ]]; then
      printf 'test-only licence fixture\n' > "$copying"
    fi
  }
  cmake() {
    if [[ "$REUSE" == 1 ]]; then
      echo "unexpected configure/build in reuse mode" >&2
      return 1
    fi
    case "$1" in
      -S) write_cmake_cache "$@" ;;
      --build) write_build_artifacts ;;
      *) echo "unexpected mocked CMake invocation: $*" >&2; return 1 ;;
    esac
  }
  if [[ "$REUSE" == 1 ]]; then
    local opts=()
    while IFS=$'\t' read -r key value; do
      if [[ "$value" == true ]]; then value=ON; elif [[ "$value" == false ]]; then value=OFF; fi
      opts+=("-D$key=$value")
    done < <(jq -r '.audio_cpp.cmake_options | to_entries[] | "\(.key)\t\(.value)"' "$LOCK")
    write_cmake_cache "${opts[@]}"
    write_build_artifacts
    if [[ "$BAD_ESPEAK" == wrong-cache ]]; then
      printf 'AUDIOCPP_MODEL_SET:STRING=wrong\n' > "$AUDIO_BUILD/CMakeCache.txt"
    fi
  fi
  source "$phase"
)
run_case fresh 0 0
echo "PASS fresh build: verification executes after generated artifacts exist"
run_case reuse 1 0
echo "PASS reuse: pre-existing verified artifacts accepted"
if run_case invalid 0 1 > "$sandbox/invalid-output" 2>&1; then
  echo "FAIL corrupted eSpeak archive was accepted" >&2
  exit 1
fi
grep -q 'SHA mismatch:' "$sandbox/invalid-output" || {
  echo "FAIL corrupt build failed for an unexpected reason" >&2
  cat "$sandbox/invalid-output" >&2
  exit 1
}
echo "PASS negative: corrupted generated eSpeak archive rejected"

for spec in "missing-copying:0:eSpeak-ng COPYING file missing" "wrong-cache:1:CMake cache does not match locked option"; do
  IFS=: read -r fault reuse expected <<< "$spec"
  if run_case "$fault" "$reuse" "$fault" > "$sandbox/$fault-output" 2>&1; then
    echo "FAIL $fault was accepted" >&2
    exit 1
  fi
  grep -q "$expected" "$sandbox/$fault-output" || {
    cat "$sandbox/$fault-output" >&2
    exit 1
  }
  echo "PASS negative: $fault rejected"
done
