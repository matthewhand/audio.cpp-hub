# SanoTTS CPU recovery candidate (issue #127)

## Status and scope

This is an isolated, reproducible Linux x86-64 CPU build path for the SanoTTS
Heart-nano GGUF model. It does not claim to repair the existing Windows/Docker
installation or its host bind mounts.

The alternative container configuration keeps the engine in the image and the model plus application state in four Docker-managed named volumes. The model volume is read-only and starts empty. It does not mount or modify existing host bind paths or migrate their contents.

The pinned Ubuntu 24.04 runtime is intentional: the freshly built engine and
CPU libraries require GLIBC_2.38, so Debian Bookworm (GLIBC_2.36) is too old.
The Ubuntu 24.04 base provides GLIBC_2.39.

The build stage has no backup-recovery prerequisite: it uses a separate source
checkout and downloads pinned upstream inputs. It does not read, copy, or alter
existing installation data.

## Immutable inputs

`deploy/sanotts-cpu/upstream.lock.json` records the Go toolchain, audio.cpp
source commit and submodule commit, eSpeak-ng source hash, SanoTTS Hugging Face
revision, and independently checked SHA-256 hashes for the GGUF, config, model
card, and upstream licence files.

The build recipe:

```sh
scripts/build-sanotts-cpu.sh
```

The default runtime package is `.sanotts-cpu-package/`; verified model files
and their licence notices are written separately to `.sanotts-cpu-models/`.
Both are ignored by Git and must remain local. The script builds audio.cpp
with the SanoTTS frontend, static eSpeak-ng, and portable x86-64 CPU variants;
runs the two SanoTTS upstream regression tests; verifies shared-library
resolution; runs the hub's Go tests, race tests and vet; and packages the
runtime, source archives and licence notices. The model files are not part of
the Docker build context. It never builds or starts a container.

A previously verified local build can be reused without recompiling the
upstream engine by setting `SANOTTS_REUSE_EXISTING=1` and supplying
`SANOTTS_SOURCE_DIR`, `SANOTTS_BUILD_DIR`, `SANOTTS_MODEL_DIR`, `SANOTTS_GO_BIN`,
and optionally `SANOTTS_LICENSE_DIR`. This mode still verifies the pinned
commits, hashes, CMake cache, upstream tests, hub tests and package checksums.

## Isolated Compose candidate

`compose.sanotts-cpu.yaml` is an opt-in profile, not the existing production
Compose file. Its defaults are deliberately non-inferential:

- profile `sanotts-cpu` must be selected explicitly;
- host port binds to `127.0.0.1:18081`;
- model and state paths use four new Docker-managed named volumes, not Windows host binds;
- the model volume is read-only and remains empty until an operator imports the verified files;
- startup defaults to `hub-only`, with no model weights path configured;
- the executable registry selects the CPU server entry explicitly;
- warm-up defaults to `skip`;
- restart policy is `no`;
- health checks only the hub API and do not claim model readiness;
- no GPU device or privileged mode is requested.

The safe, read-only configuration check is:

```sh
scripts/test-sanotts-cpu-compose.sh
```

That check runs `docker compose config` and the offline mocked CMake phase
regression (`scripts/test-sanotts-cpu-fresh-build.sh`). It does not build an
image, create volumes, start containers, download dependencies, load a model,
or access an engine. The regression executes the real fresh/reuse build-script
phase with mock CMake outputs and a corrupted-archive negative case; it does
not replace a full clean build or production mount/synthesis acceptance.

Before synthesis can work in the container, an operator must copy the verified
model files from `.sanotts-cpu-models/` into the named model volume, preserving
their filenames, and set `AUDIOCPP_WEIGHTS` to the corresponding path under
`/audio.cpp/models`. The recipe does not import those files automatically.
Changing `AUDIOCPP_STARTUP_MODE` to `normal` or `AUDIOCPP_WARMUP_POLICY` to
`required` can start model work. Model import and container inference have not
been exercised by this PR; they remain container acceptance steps.

Failed builds preserve their outputs for inspection and refuse to overwrite
them on retry. Use fresh output, model and work directories for a new build;
partial downloads are not accepted as verified inputs.

## Licensing boundary

- audio.cpp is Apache-2.0; its server-frontends submodule and third-party
  notices are retained in the local package.
- eSpeak-ng 1.52.0 is GPL-3.0; its source archive, COPYING notice, build patch,
  and phonemizer documentation are retained with the package.
- The SanoTTS repository is GPL-3.0-or-later as a whole because its broader
  grapheme-to-phoneme layer embeds eSpeak-ng. Its `LICENSE.MIT` applies only to
  the specifically enumerated inference-runtime and binding files.
- The pinned GGUF README documents conversion provenance and teacher models,
  but does not clearly assign a separate licence to the GGUF weights. Their
  redistribution status is therefore unresolved. The weights are fetched only
  into the ignored local package; do not publish them or an image containing
  them until the publisher clarifies the applicable terms.
- audio.cpp-hub remains MIT-licensed.

## Acceptance boundary

Verified build/test evidence is not a Windows mount repair or live operational
acceptance. Issue #127 must remain open until Windows
maintenance proves the new storage path is writable and a synthesis test proves
a non-silent WAV and matching persisted history.
No existing container, WSL distribution, mount, file, history, volume, or
service is restarted, migrated, deleted, or modified by this work.
