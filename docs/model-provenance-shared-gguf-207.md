# Shared `audio.cpp-gguf` provenance batch — issue #207

Metadata-only audit performed 2026-10-29 against public `main` before this change (`d9fb48d117913c355ea4d5943375d55aed8e2b7c`). No model weights were fetched, hashed locally, run, distributed, or republished.

## Scope and evidence

`model-packages.json` references 112 files in 43 model families in `audio-cpp/audio.cpp-gguf`. Two Kokoro 82M choices were already pinned and hashed by PR #216. **All 112 exact file paths** were present in the immutable Hugging Face tree at [`874fcb41ececda20bcbc0782d6b4ea7f7d069ea8`](https://huggingface.co/audio-cpp/audio.cpp-gguf/tree/874fcb41ececda20bcbc0782d6b4ea7f7d069ea8). Every referenced file had a complete 64-hex Git LFS `oid` that matched a separate **HEAD-only** request to `/resolve/{commit}/{path}` (no redirect followed), including `X-Linked-Etag`, `X-Linked-Size` and `X-Repo-Commit`. These values are provider-supplied candidate SHA-256 checksums, **not** independently signed publisher attestations or local recomputed hashes. The only accepted implementation scope in this PR is ten additional package choices below.

| Selected family (package choices) | Original publisher source/license (verified metadata) | Immutable GGUF commit | SHA-256 source |
| --- | --- | --- | --- |
| Chatterbox (2) | [ResembleAI/chatterbox](https://huggingface.co/ResembleAI/chatterbox), MIT card, publisher snapshot `5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18` | `874fcb41ececda20bcbc0782d6b4ea7f7d069ea8` | `Chatterbox-GGUF/chatterbox-{q8_0,f16}.gguf` LFS oids |
| Irodori TTS (6) | [v4.1 Small](https://huggingface.co/Aratako/Irodori-TTS-v4.1-Small), [500M v3](https://huggingface.co/Aratako/Irodori-TTS-500M-v3) and [600M v3 VoiceDesign](https://huggingface.co/Aratako/Irodori-TTS-600M-v3-VoiceDesign), each MIT card, publisher snapshots `2b28324dc263ed5e6638b3cf3dd94c82ead07b4b`, `236c1e56591279fc24e3c1bf6609fc06e48dde28` and `e863a3a93e652e09afeff3e84823a206a0a60314` | Same shared GGUF commit | `Irodori-TTS-*` LFS oids |
| VibeVoice 1.5B (2) | [microsoft/VibeVoice-1.5B](https://huggingface.co/microsoft/VibeVoice-1.5B), MIT card, publisher snapshot `c00898d257e6b46004e3e2866a47534085fb685a` | Same shared GGUF commit | `VibeVoice-1.5B-GGUF/vibevoice-1.5b-{q8_0,bf16}.gguf` LFS oids |

The [shared GGUF README](https://huggingface.co/audio-cpp/audio.cpp-gguf/blob/874fcb41ececda20bcbc0782d6b4ea7f7d069ea8/README.md) separately lists MIT for these three directory families. Its top-level license is `other` because **different directories have different original model conditions**. Confirming model-card tags and linked originals is necessary but not a substitute for legal review of all actual license terms; this source-only manifest does not redistribute weights or license documents.

## Explicit exclusions / review categories

Of 112 shared GGUF package references, 61 have directory-level MIT or Apache-2.0 declarations in the source README, 13 have CC-BY-4.0 declarations and 38 have non-commercial, custom, attribution/share-alike, GPL, restricted or other conditions. **These categories describe the aggregate model-provider README only, not independently confirmed grants from each original publisher.** After this batch, 12 of the 112 shared entries have pinned expected SHA-256 (two Kokoro from #216 plus the ten here); the remaining 100 remain unchanged, unpinned, and unverified in the application even though provider metadata is available. Examples needing separate review include Sortformer (CC-BY-NC), Stable Audio (community license), Vevo2 (CC-BY-NC-ND), SeedVC (GPL), Breeze TTS, IndexTTS, Fish Audio and gated/other model sources. Do not pin all remaining families merely because their metadata had matching LFS oids.

## Mirror, privacy and migration boundaries

The current `POST /api/downloads` ModelScope path substitutes `HereIsMark/{name}` at mutable `master`, **not** the pinned Hugging Face revision. The existing `packageHasExpectedSHA256` guard from PR #216 rejects ModelScope for these new hash-bearing entries *before* creating a download; no equivalence has been established. Unhashed legacy packages retain their previous mirror behaviour. Any alternative Hugging Face endpoint must produce exact bytes matching the expected file digest or the downloader fails. Do not assume equal filenames or repository names imply identical mirrored bytes.

`TestSharedGGUFLicenseReviewedPins` validates all ten immutable URLs and full 64-character expected checksums; `TestSharedGGUFHashedMirrorsRejectedWithoutNetwork` checks every selected package using synthetic in-memory HTTP requests; existing `download_integrity_test.go` covers fictional download and mismatch/restart behaviour. No live inference, original audio samples, model downloads, permission documents, private host inventory or hosted CI used. Issue #207 stays open for the remaining catalog, original license validation, external publisher attestations and ModelScope equivalence.
