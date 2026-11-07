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
    printf 'CMAKE_HOME_DIRECTORY:INTERNAL=%s\n' "$AUDIO_SRC" > "$AUDIO_BUILD/CMakeCache.txt"
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
    case "$1" in
      -S) write_cmake_cache "$@"; touch "$AUDIO_BUILD/configured" ;;
      --build) write_build_artifacts; printf 'current fixture\n' > "$AUDIO_BUILD/runtime-binary"; touch "$AUDIO_BUILD/built" ;;
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
    printf 'stale fixture\n' > "$AUDIO_BUILD/runtime-binary"
    if [[ "$BAD_ESPEAK" == wrong-source ]]; then
      sed -i 's|CMAKE_HOME_DIRECTORY:INTERNAL=.*|CMAKE_HOME_DIRECTORY:INTERNAL=/other/source|' "$AUDIO_BUILD/CMakeCache.txt"
    fi
    if [[ "$BAD_ESPEAK" == wrong-cache ]]; then
      printf 'AUDIOCPP_MODEL_SET:STRING=wrong\n' > "$AUDIO_BUILD/CMakeCache.txt"
    fi
  fi
  source "$phase"
  [[ -f "$AUDIO_BUILD/configured" && -f "$AUDIO_BUILD/built" ]] || fail "reused output was not rebuilt"
  grep -qx 'current fixture' "$AUDIO_BUILD/runtime-binary" || fail "stale runtime binary was packaged"
)
run_case fresh 0 0
echo "PASS fresh build: verification executes after generated artifacts exist"
run_case reuse 1 0
echo "PASS reuse: stale artifact rebuilt from the verified source"
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

for spec in "missing-copying:0:eSpeak-ng COPYING file missing" "wrong-cache:1:CMake cache does not match locked option" "wrong-source:1:CMake source directory mismatch"; do
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

# Exercise the production source verification with real, isolated Git trees.
source_phase="$sandbox/source-phase.sh"
python3 - "$BUILD_SCRIPT" "$source_phase" <<'PY'
from pathlib import Path
import sys
source = Path(sys.argv[1]).read_text()
start = source.index('[[ "$(git -C "$AUDIO_SRC" rev-parse HEAD)"')
end = source.index("\nMODEL_SRC_CANON=", start)
Path(sys.argv[2]).write_text(source[start:end] + "\n")
PY
source_case() (
  set -Eeuo pipefail
  local fault="$1"
  AUDIO_SRC="$sandbox/git-$fault"
  SUBMODULE_PATH=frontend
  mkdir -p "$AUDIO_SRC/$SUBMODULE_PATH"
  git init -q "$AUDIO_SRC"
  git init -q "$AUDIO_SRC/$SUBMODULE_PATH"
  printf 'source fixture\n' > "$AUDIO_SRC/$SUBMODULE_PATH/native.cpp"
  git -C "$AUDIO_SRC/$SUBMODULE_PATH" add native.cpp
  git -C "$AUDIO_SRC/$SUBMODULE_PATH" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm fixture
  SUBMODULE_COMMIT="$(git -C "$AUDIO_SRC/$SUBMODULE_PATH" rev-parse HEAD)"
  printf 'source fixture\n' > "$AUDIO_SRC/native.cpp"
  git -C "$AUDIO_SRC" add native.cpp frontend 2>/dev/null
  git -C "$AUDIO_SRC" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm fixture
  AUDIO_COMMIT="$(git -C "$AUDIO_SRC" rev-parse HEAD)"
  case "$fault" in
    dirty-main) printf 'modified\n' >> "$AUDIO_SRC/native.cpp" ;;
    dirty-submodule) printf 'modified\n' >> "$AUDIO_SRC/$SUBMODULE_PATH/native.cpp" ;;
    untracked) printf 'untracked\n' > "$AUDIO_SRC/extra.cpp" ;;
  esac
  fail() { echo "$*" >&2; exit 1; }
  source "$source_phase"
)
source_case clean
for fault in dirty-main dirty-submodule untracked; do
  if source_case "$fault" > "$sandbox/$fault-output" 2>&1; then
    echo "FAIL $fault source was accepted" >&2; exit 1
  fi
  grep -q 'source tree is dirty' "$sandbox/$fault-output"
  echo "PASS negative: $fault source rejected"
done
