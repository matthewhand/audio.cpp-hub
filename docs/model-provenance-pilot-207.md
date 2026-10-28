# Model artifact provenance pilot — issue #207

Source-only audit: 2026-10-29. The eight **package choices** below refer to six **distinct GGUF files**. No model weights were downloaded, redistributed, executed, or hashed locally.

## Selection and integrity evidence

The expected per-file `sha256` values in `model-packages.json` are the upstream Git-LFS content `oid` values, not Git blob identifiers. For each of the six files, metadata was checked twice using an **immutable 40-character Hugging Face revision**:

1. `GET https://huggingface.co/api/models/{repo}/tree/{commit}?recursive=true`: exact remote file path, `lfs.oid` (64 hex), and declared byte length.
2. `HEAD https://huggingface.co/{repo}/resolve/{commit}/{remote}` **without following the model-content redirect**: `X-Linked-Etag` matched the tree `lfs.oid`, `X-Linked-Size` matched the tree size, and `X-Repo-Commit` matched the requested commit. Neither step retrieves weight bytes.

| Package families / source repository | Immutable source revision | Files from checked revision | License trail |
| --- | --- | --- | --- |
| `ming3_tts`, `ming3_tts_voicedesign` / [audio-cpp/Ming-3.0-TTS-0.5B-GGUF](https://huggingface.co/audio-cpp/Ming-3.0-TTS-0.5B-GGUF/tree/2eb8d37c7f10672e69c8aa33091baa04c461b66c) | `2eb8d37c7f10672e69c8aa33091baa04c461b66c` | `ming-3.0-tts-0.5b-q8_0.gguf` (1,742,280,896 bytes); `ming-3.0-tts-0.5b-bf16.gguf` (2,998,284,288 bytes) | GGUF card says MIT, with original [inclusionAI/Ming-3.0-tts-0.5B](https://huggingface.co/inclusionAI/Ming-3.0-tts-0.5B) also declaring MIT. |
| `kokoro_tts` / [audio-cpp/audio.cpp-gguf](https://huggingface.co/audio-cpp/audio.cpp-gguf/tree/874fcb41ececda20bcbc0782d6b4ea7f7d069ea8) | `874fcb41ececda20bcbc0782d6b4ea7f7d069ea8` | `Kokoro-82M-GGUF/kokoro-82m-q8_0.gguf` (189,550,976 bytes); `Kokoro-82M-GGUF/kokoro-82m-bf16.gguf` (211,956,384 bytes) | Aggregate GGUF card lists **Kokoro-82M-GGUF: Apache-2.0**, matching the original [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) license tag. The aggregate repo's `other` license is **not** a blanket license for all its families. |
| `fun_asr_nano` GGUF choices / [FunAudioLLM/Fun-ASR-Nano-2512-GGUF](https://huggingface.co/FunAudioLLM/Fun-ASR-Nano-2512-GGUF/tree/ce72677f84900f0dc57f498ace253bfb3c9155b6) | `ce72677f84900f0dc57f498ace253bfb3c9155b6` (already pinned) | `fun-asr-nano-2512-q8_0.gguf` (1,045,334,432 bytes); `fun-asr-nano-2512-f16.gguf` (1,675,708,832 bytes) | The GGUF card declares **FunASR Model Open Source License Agreement v1.1** (`license: other`). Its original [FunAudioLLM/Fun-ASR-Nano-2512-hf](https://huggingface.co/FunAudioLLM/Fun-ASR-Nano-2512-hf) card currently declares Apache-2.0; **do not assume that declaration overrides the GGUF repository's stated license terms**. |

The manifests only link to external source files; no model weights or third-party licenses are republished in this PR. Before downloading, using or redistributing a model, the operator remains responsible for its **applicable** license and terms. These metadata checks establish provider-side consistency but **not** an independent signed publisher attestation, local byte-level recomputation, model behaviour, or permission to redistribute any voice recordings.

## Mirror gate and compatibility

- These SHA-bearing package choices use Hugging Face's **exact pinned revision** by default. Runtime download hashing (merged in PR #214) checks downloaded bytes before marking completion.
- `source: "modelscope"` maps to `HereIsMark/{repositoryName}` at mutable `master`, not the above Hugging Face commit. ModelScope equivalence was **not established**, so the API returns `PACKAGE_MIRROR_UNVERIFIED` before any download for packages with an expected `sha256`. An unverified mirror or different commit cannot inherit Hugging Face provenance evidence.
- Other **legacy unhashed** packages retain their previous ModelScope routing behaviour. A configured alternative Hugging Face-compatible endpoint must still return matching file bytes or post-download SHA verification fails; its repository provenance cannot be inferred from a URL label.
- `DONE` on a legacy package with **no expected checksum** remains unverified. No existing completed downloads are auto-rehashed or deleted by these manifest changes.

## Acceptance boundaries

A future migration PR should recheck the provider-published commit, path, size, LFS SHA-256, correct license family, and full repository/source mapping at the time of change; use fictional offline tests only; never derive a trusted hash from the same file download being checked. The larger #207 inventory (mixed Git/LFS files, gated weights and ModelScope parity) remains open after this pilot. This document is an audit trail, not independent publisher attestation or legal advice.
