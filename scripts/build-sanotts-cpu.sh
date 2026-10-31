#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="$ROOT/deploy/sanotts-cpu/upstream.lock.json"
OUT_DIR="${SANOTTS_OUTPUT_DIR:-$ROOT/.sanotts-cpu-package}"
MODEL_OUTPUT_DIR="${SANOTTS_MODEL_OUTPUT_DIR:-$ROOT/.sanotts-cpu-models}"
WORK_DIR="${SANOTTS_WORK_DIR:-$ROOT/.sanotts-cpu-work}"
REUSE="${SANOTTS_REUSE_EXISTING:-0}"
JOBS="${SANOTTS_BUILD_JOBS:-4}"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
lock() { jq -er "$1" "$LOCK"; }
verify_sha() {
  local expected="$1" file="$2"
  [[ -f "$file" ]] || fail "missing file: $file"
  printf '%s  %s\n' "$expected" "$file" | sha256sum --check --status \
    || fail "SHA-256 mismatch: $file"
}
fetch() {
  local url="$1" file="$2"
  mkdir -p "$(dirname "$file")"
  curl -fL --retry 2 --connect-timeout 15 --max-time 240 -o "$file" "$url"
}
copy_license_tree() {
  local source="$1" destination="$2" path relative
  mkdir -p "$destination"
  while IFS= read -r -d '' path; do
    relative="${path#"$source"/}"
    mkdir -p "$destination/$(dirname "$relative")"
    cp -a "$path" "$destination/$relative"
  done < <(find "$source" -type d -name .git -prune -o -type f \
    \( -iname 'LICENSE' -o -iname 'LICENSE.*' -o -iname 'COPYING' -o -iname 'COPYING.*' -o -iname 'NOTICE' -o -iname 'NOTICE.*' \) -print0)
}

[[ -f "$LOCK" ]] || fail "lock file not found: $LOCK"
command -v curl >/dev/null || fail "curl is required"
command -v git >/dev/null || fail "git is required"
command -v cmake >/dev/null || fail "cmake is required"
command -v ninja >/dev/null || fail "ninja is required"
command -v gcc >/dev/null || fail "gcc is required"
command -v g++ >/dev/null || fail "g++ is required"
command -v jq >/dev/null || fail "jq is required"
command -v python3 >/dev/null || fail "python3 is required"
command -v sha256sum >/dev/null || fail "sha256sum is required"
command -v readelf >/dev/null || fail "readelf is required"
command -v realpath >/dev/null || fail "realpath is required"
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] \
  || fail "this build recipe targets Linux x86_64 only"
[[ "$JOBS" =~ ^[1-8]$ ]] || fail "SANOTTS_BUILD_JOBS must be 1..8"
OUT_CANON="$(realpath -m "$OUT_DIR")"
MODEL_CANON="$(realpath -m "$MODEL_OUTPUT_DIR")"
WORK_CANON="$(realpath -m "$WORK_DIR")"
[[ "$OUT_CANON" != "$MODEL_CANON" ]] || fail "package and model output directories must differ"
case "$MODEL_CANON/" in "$OUT_CANON/"*) fail "model output must be outside the Docker build context" ;; esac
case "$OUT_CANON/" in "$MODEL_CANON/"*) fail "package output must be outside the model output directory" ;; esac
case "$WORK_CANON/" in "$OUT_CANON/"*) fail "work directory must be outside the Docker build context" ;; esac
case "$WORK_CANON/" in "$MODEL_CANON/"*) fail "work directory must be outside the model output directory" ;; esac
[[ ! -e "$OUT_DIR" ]] || fail "refusing to overwrite existing package output: $OUT_DIR"
[[ ! -e "$MODEL_OUTPUT_DIR" ]] || fail "refusing to overwrite existing model output: $MODEL_OUTPUT_DIR"
mkdir -m 0700 -p "$OUT_DIR" "$MODEL_OUTPUT_DIR" "$WORK_DIR/tmp"

AUDIO_REPO="$(lock '.audio_cpp.repository')"
AUDIO_COMMIT="$(lock '.audio_cpp.commit')"
SUBMODULE_PATH="$(lock '.audio_cpp.server_frontends_submodule')"
SUBMODULE_COMMIT="$(lock '.audio_cpp.server_frontends_commit')"
MODEL_REPO="$(lock '.sanotts.repository')"
MODEL_REVISION="$(lock '.sanotts.revision')"
MODEL_WEIGHTS_PATH="$(lock '.sanotts.weights.path')"
MODEL_CONFIG_PATH="$(lock '.sanotts.config.path')"
MODEL_README_PATH="$(lock '.sanotts.readme.path')"
MODEL_WEIGHTS_SHA="$(lock '.sanotts.weights.sha256')"
MODEL_CONFIG_SHA="$(lock '.sanotts.config.sha256')"
MODEL_README_SHA="$(lock '.sanotts.readme.sha256')"
GO_VERSION="$(lock '.hub_toolchain.go_version')"
GO_URL="$(lock '.hub_toolchain.go_archive_url')"
GO_SHA="$(lock '.hub_toolchain.go_archive_sha256')"
ESPEAK_SHA="$(lock '.espeak_ng.source_sha256')"
ESPEAK_VERSION="$(lock '.espeak_ng.version')"
LICENSE_COMMIT="$(lock '.sanotts.license_source_commit')"
GPL_LICENSE_PATH="$(lock '.sanotts.gpl_license.path')"
MIT_LICENSE_PATH="$(lock '.sanotts.mit_license.path')"
GPL_LICENSE_SHA="$(lock '.sanotts.gpl_license.sha256')"
MIT_LICENSE_SHA="$(lock '.sanotts.mit_license.sha256')"

if [[ "$REUSE" == 1 ]]; then
  AUDIO_SRC="${SANOTTS_SOURCE_DIR:?set SANOTTS_SOURCE_DIR when reusing existing source}"
  AUDIO_BUILD="${SANOTTS_BUILD_DIR:?set SANOTTS_BUILD_DIR when reusing existing build}"
  MODEL_DIR="${SANOTTS_MODEL_DIR:?set SANOTTS_MODEL_DIR when reusing existing model files}"
  GO_BIN="${SANOTTS_GO_BIN:?set SANOTTS_GO_BIN when reusing existing Go toolchain}"
else
  AUDIO_SRC="$WORK_DIR/audio.cpp"
  AUDIO_BUILD="$WORK_DIR/audio-build"
  MODEL_DIR="$WORK_DIR/models"
  GO_ROOT="$WORK_DIR/go$GO_VERSION"
  GO_ARCHIVE="$WORK_DIR/go$GO_VERSION.linux-amd64.tar.gz"

  [[ ! -e "$AUDIO_SRC" && ! -e "$AUDIO_BUILD" && ! -e "$MODEL_DIR" && ! -e "$GO_ROOT" ]] \
    || fail "refusing to overwrite existing work directories under $WORK_DIR"

  fetch "$GO_URL" "$GO_ARCHIVE"
  verify_sha "$GO_SHA" "$GO_ARCHIVE"
  mkdir -m 0700 "$GO_ROOT"
  tar -xzf "$GO_ARCHIVE" -C "$GO_ROOT" --strip-components=1
  GO_BIN="$GO_ROOT/bin/go"

  git clone --filter=blob:none --no-checkout "$AUDIO_REPO" "$AUDIO_SRC"
  git -C "$AUDIO_SRC" fetch --depth=1 origin "$AUDIO_COMMIT"
  git -C "$AUDIO_SRC" checkout --detach "$AUDIO_COMMIT"
  git -C "$AUDIO_SRC" submodule update --init --depth=1

  mkdir -m 0700 "$MODEL_DIR"
  fetch "$MODEL_REPO/resolve/$MODEL_REVISION/$MODEL_WEIGHTS_PATH" "$MODEL_DIR/$(basename "$MODEL_WEIGHTS_PATH")"
  fetch "$MODEL_REPO/resolve/$MODEL_REVISION/$MODEL_CONFIG_PATH" "$MODEL_DIR/$(basename "$MODEL_CONFIG_PATH")"
  fetch "$MODEL_REPO/resolve/$MODEL_REVISION/$MODEL_README_PATH" "$MODEL_DIR/$(basename "$MODEL_README_PATH")"
fi

LICENSE_DIR="${SANOTTS_LICENSE_DIR:-$WORK_DIR/licenses}"
mkdir -m 0700 -p "$LICENSE_DIR"
if [[ ! -f "$LICENSE_DIR/$(basename "$GPL_LICENSE_PATH")" ]]; then
  fetch "https://raw.githubusercontent.com/Ampixa/sanoTTS/$LICENSE_COMMIT/$GPL_LICENSE_PATH" "$LICENSE_DIR/$(basename "$GPL_LICENSE_PATH")"
fi
if [[ ! -f "$LICENSE_DIR/$(basename "$MIT_LICENSE_PATH")" ]]; then
  fetch "https://raw.githubusercontent.com/Ampixa/sanoTTS/$LICENSE_COMMIT/$MIT_LICENSE_PATH" "$LICENSE_DIR/$(basename "$MIT_LICENSE_PATH")"
fi

[[ -x "$GO_BIN" ]] || fail "Go toolchain is not executable: $GO_BIN"
[[ "$("$GO_BIN" version)" == "go version go$GO_VERSION linux/amd64" ]] \
  || fail "unexpected Go version: $("$GO_BIN" version)"
[[ "$(git -C "$AUDIO_SRC" rev-parse HEAD)" == "$AUDIO_COMMIT" ]] \
  || fail "audio.cpp source commit mismatch"
[[ "$(git -C "$AUDIO_SRC/$SUBMODULE_PATH" rev-parse HEAD)" == "$SUBMODULE_COMMIT" ]] \
  || fail "audio.cpp server-frontends submodule mismatch"
MODEL_SRC_CANON="$(realpath -m "$MODEL_DIR")"
case "$MODEL_SRC_CANON/" in "$OUT_CANON/"*) fail "model source directory must be outside the Docker build context" ;; esac

verify_sha "$MODEL_WEIGHTS_SHA" "$MODEL_DIR/$(basename "$MODEL_WEIGHTS_PATH")"
verify_sha "$MODEL_CONFIG_SHA" "$MODEL_DIR/$(basename "$MODEL_CONFIG_PATH")"
verify_sha "$MODEL_README_SHA" "$MODEL_DIR/$(basename "$MODEL_README_PATH")"
verify_sha "$GPL_LICENSE_SHA" "$LICENSE_DIR/$(basename "$GPL_LICENSE_PATH")"
verify_sha "$MIT_LICENSE_SHA" "$LICENSE_DIR/$(basename "$MIT_LICENSE_PATH")"
[[ "$(stat -c '%s' "$MODEL_DIR/$(basename "$MODEL_WEIGHTS_PATH")")" == "$(lock '.sanotts.weights.size_bytes')" ]] \
  || fail "SanoTTS weights size mismatch"

ESPEAK_ARCHIVE="$AUDIO_BUILD/_deps/espeak-static/download/espeak-ng-$ESPEAK_VERSION.tar.gz"
ESPEAK_COPYING="$AUDIO_BUILD/bin/licenses/espeak-ng/COPYING"
[[ -f "$AUDIO_BUILD/CMakeCache.txt" ]] || fail "CMake cache missing: $AUDIO_BUILD"
verify_sha "$ESPEAK_SHA" "$ESPEAK_ARCHIVE"
[[ -f "$ESPEAK_COPYING" ]] || fail "eSpeak-ng COPYING file missing"

cmake_options=()
while IFS=$'\t' read -r key value; do
  if [[ "$value" == true ]]; then value=ON; elif [[ "$value" == false ]]; then value=OFF; fi
  cmake_options+=("-D$key=$value")
done < <(jq -r '.audio_cpp.cmake_options | to_entries[] | "\(.key)\t\(.value)"' "$LOCK")

if [[ "$REUSE" != 1 ]]; then
  cmake -S "$AUDIO_SRC" -B "$AUDIO_BUILD" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
    "${cmake_options[@]}"
  CMAKE_BUILD_PARALLEL_LEVEL="$JOBS" cmake --build "$AUDIO_BUILD" \
    --target audiocpp_server sanotts_frontend_test sanotts_neon_decoder_test --parallel "$JOBS"
else
  for option in "${cmake_options[@]}"; do
    setting="${option#-D}"
    key="${setting%%=*}"
    value="${setting#*=}"
    if [[ "$value" == ON || "$value" == OFF ]]; then kind=BOOL; else kind=STRING; fi
    grep -Fqx "$key:$kind=$value" "$AUDIO_BUILD/CMakeCache.txt" \
      || fail "CMake cache does not match locked option $key=$value"
  done
fi

ctest --test-dir "$AUDIO_BUILD" --output-on-failure \
  -R '^(sanotts_frontend_test|sanotts_neon_decoder_test)$'
SERVER_BIN="$AUDIO_BUILD/bin/audiocpp_server"
[[ -x "$SERVER_BIN" ]] || fail "audiocpp_server missing or not executable"
ldd "$SERVER_BIN" > "$WORK_DIR/audiocpp-ldd.txt"
if grep -q 'not found' "$WORK_DIR/audiocpp-ldd.txt"; then
  cat "$WORK_DIR/audiocpp-ldd.txt" >&2
  fail "unresolved audiocpp_server shared library"
fi
for runtime_file in "$SERVER_BIN" "$AUDIO_BUILD"/bin/libggml*.so*; do
  [[ -f "$runtime_file" ]] || continue
  max_glibc="$(readelf --version-info "$runtime_file" 2>/dev/null | grep -oE 'GLIBC_[0-9]+\.[0-9]+' | sort -Vu | tail -1 || true)"
  if [[ -n "$max_glibc" && "$(printf '%s\n' "$max_glibc" GLIBC_2.39 | sort -V | tail -1)" != GLIBC_2.39 ]]; then
    fail "runtime requires $max_glibc, newer than pinned Ubuntu 24.04 glibc 2.39: $runtime_file"
  fi
done
LD_LIBRARY_PATH="$AUDIO_BUILD/bin" "$SERVER_BIN" --list-devices \
  > "$WORK_DIR/audiocpp-devices.txt" 2>&1
grep -q 'CPU:' "$WORK_DIR/audiocpp-devices.txt" \
  || { cat "$WORK_DIR/audiocpp-devices.txt" >&2; fail "CPU device enumeration failed"; }

export GOCACHE="${GOCACHE:-$WORK_DIR/go-build}"
export GOMODCACHE="${GOMODCACHE:-$WORK_DIR/go-modcache}"
export GOTMPDIR="${GOTMPDIR:-$WORK_DIR/tmp}"
export TMPDIR="${TMPDIR:-$WORK_DIR/tmp}"
export GOMAXPROCS=4
export GOFLAGS="${GOFLAGS:--buildvcs=false -mod=readonly}"
mkdir -m 0700 -p "$GOCACHE" "$GOMODCACHE" "$GOTMPDIR"
cd "$ROOT"
HUB_STATUS="$(git status --porcelain --untracked-files=normal)"
[[ -z "$HUB_STATUS" ]] || fail "hub source must be committed and clean before packaging"
HUB_COMMIT="$(git rev-parse HEAD)"
"$GO_BIN" mod download
"$GO_BIN" mod verify
"$GO_BIN" test -p 2 ./...
"$GO_BIN" test -race -p 2 ./...
"$GO_BIN" vet -p 2 ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 "$GO_BIN" build -trimpath \
  -ldflags="-s -w -X main.version=sanotts-cpu-${HUB_COMMIT:0:7}" \
  -o "$OUT_DIR/audio.cpp-hub" .

mkdir -p "$OUT_DIR/bin" "$OUT_DIR/docker" \
  "$OUT_DIR/web" "$OUT_DIR/licenses/audio.cpp" \
  "$OUT_DIR/licenses/audio.cpp-server-frontends" \
  "$OUT_DIR/licenses/audio.cpp-hub" "$OUT_DIR/licenses/espeak-ng" \
  "$OUT_DIR/licenses/sanotts" "$OUT_DIR/source"
cp "$SERVER_BIN" "$OUT_DIR/bin/audiocpp_server"
find "$AUDIO_BUILD/bin" -maxdepth 1 -name 'libggml*.so*' \
  -exec cp -a {} "$OUT_DIR/bin/" \;
cp "$AUDIO_BUILD/bin/espeak-ng-data.bin" "$OUT_DIR/bin/"
cp "$MODEL_DIR/$(basename "$MODEL_WEIGHTS_PATH")" "$MODEL_OUTPUT_DIR/heart-nano-f32.gguf"
cp "$MODEL_DIR/$(basename "$MODEL_CONFIG_PATH")" "$MODEL_OUTPUT_DIR/config.json"
cp "$MODEL_DIR/$(basename "$MODEL_README_PATH")" "$MODEL_OUTPUT_DIR/README.md"
cp "$LICENSE_DIR/$(basename "$GPL_LICENSE_PATH")" "$MODEL_OUTPUT_DIR/LICENSE"
cp "$LICENSE_DIR/$(basename "$MIT_LICENSE_PATH")" "$MODEL_OUTPUT_DIR/LICENSE.MIT"
cat > "$MODEL_OUTPUT_DIR/WEIGHTS-LICENSE-STATUS.txt" <<STATUS
The upstream GGUF README does not assign a separate licence to these weights.
Their redistribution status is unresolved. Keep this directory local and do not
redistribute the weights or any image containing them until the publisher
clarifies the applicable terms.
STATUS
(cd "$MODEL_OUTPUT_DIR" && sha256sum config.json README.md heart-nano-f32.gguf LICENSE LICENSE.MIT WEIGHTS-LICENSE-STATUS.txt > SHA256SUMS)
cp -a "$ROOT/web/." "$OUT_DIR/web/"
cp -a "$ROOT/docker/." "$OUT_DIR/docker/"
cp "$ROOT/deploy/sanotts-cpu/sanotts-executables.json" "$OUT_DIR/docker/executables.json"
cp "$ROOT/deploy/sanotts-cpu/Dockerfile" "$OUT_DIR/Dockerfile"
cp "$LOCK" "$OUT_DIR/upstream.lock.json"

cp "$ROOT/LICENSE" "$OUT_DIR/licenses/audio.cpp-hub/LICENSE"
cp "$AUDIO_SRC/LICENSE" "$OUT_DIR/licenses/audio.cpp/LICENSE"
cp "$AUDIO_SRC/$SUBMODULE_PATH/LICENSE" "$OUT_DIR/licenses/audio.cpp-server-frontends/LICENSE"
copy_license_tree "$AUDIO_SRC" "$OUT_DIR/licenses/audio.cpp/third-party"
copy_license_tree "$AUDIO_SRC/$SUBMODULE_PATH" "$OUT_DIR/licenses/audio.cpp-server-frontends/third-party"
cp "$ESPEAK_COPYING" "$OUT_DIR/licenses/espeak-ng/COPYING"
cp "$LICENSE_DIR/$(basename "$GPL_LICENSE_PATH")" "$OUT_DIR/licenses/sanotts/LICENSE"
cp "$LICENSE_DIR/$(basename "$MIT_LICENSE_PATH")" "$OUT_DIR/licenses/sanotts/LICENSE.MIT"
cp "$AUDIO_SRC/tools/cmake/espeak_static.cmake" "$OUT_DIR/licenses/espeak-ng/"
cp "$AUDIO_SRC/tools/cmake/espeak_patch.cmake" "$OUT_DIR/licenses/espeak-ng/"
cp "$AUDIO_SRC/docs/espeak_phonemizer.md" "$OUT_DIR/licenses/espeak-ng/"

cp "$ESPEAK_ARCHIVE" "$OUT_DIR/source/"
git -C "$AUDIO_SRC" archive --format=tar --prefix=audio.cpp/ "$AUDIO_COMMIT" \
  | gzip -n > "$OUT_DIR/source/audio.cpp-$AUDIO_COMMIT.tar.gz"
git -C "$AUDIO_SRC/$SUBMODULE_PATH" archive --format=tar \
  --prefix=audio.cpp-server-frontends/ "$SUBMODULE_COMMIT" \
  | gzip -n > "$OUT_DIR/source/audio.cpp-server-frontends-$SUBMODULE_COMMIT.tar.gz"
git -C "$ROOT" archive --format=tar --prefix=audio.cpp-hub/ "$HUB_COMMIT" \
  | gzip -n > "$OUT_DIR/source/audio.cpp-hub-$HUB_COMMIT.tar.gz"

cat > "$OUT_DIR/BUILD-STATUS.txt" <<STATUS
Hub commit: $HUB_COMMIT
Audio.cpp commit: $AUDIO_COMMIT
Audio.cpp server-frontends submodule: $SUBMODULE_COMMIT
SanoTTS revision: $MODEL_REVISION
Go version: $GO_VERSION
eSpeak-ng version: $ESPEAK_VERSION
Target: Linux x86_64 CPU

This package is a local build context. It is not a release or deployment.
No model inference, container build, container start, or service change was performed.
The GGUF model-weight licence is unresolved. The model is kept in the separate
local model directory, outside this Docker build context; do not redistribute it
until the publisher confirms the applicable terms.
Existing Windows2 files, volumes, histories, containers, and services are untouched.
STATUS

(cd "$OUT_DIR" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
printf 'PACKAGE_DIR=%s\n' "$OUT_DIR"
printf 'MODEL_OUTPUT_DIR=%s\n' "$MODEL_OUTPUT_DIR"
printf 'PACKAGE_SIZE='; du -sh "$OUT_DIR" | cut -f1
printf 'MODEL_SIZE='; du -sh "$MODEL_OUTPUT_DIR" | cut -f1
printf 'PACKAGE_FILES='; find "$OUT_DIR" -type f | wc -l
printf 'PACKAGE_SHA256SUMS='; sha256sum "$OUT_DIR/SHA256SUMS" | cut -d ' ' -f1
printf 'NO_DOCKER_BUILD_OR_DEPLOYMENT\n'
