# Issue #207: MOSS TTS Nano and Transcribe-Diarize GGUF provenance batch

Audit date: 2026-10-30. Base public `main`: `2e09a4c08ca2abb3efe747bf567682d2d740b3a8`. This PR changes only five existing GGUF package-choice revision and `sha256` fields and adds fictional offline tests. No actual model bytes, weights, voices or user information were fetched, redistributed or processed.

## Source license and snapshot evidence

| GGUF package family | Original publisher declaration | Immutable upstream GGUF snapshot |
| --- | --- | --- |
| MOSS-TTS-Nano-100M (Q8_0, BF16) | [OpenMOSS-Team/MOSS-TTS-Nano-100M](https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M) currently declares Apache-2.0, original commit `44502f80dbf9743528fa921cc544d662c685ebec` | `874fcb41ececda20bcbc0782d6b4ea7f7d069ea8` |
| MOSS-Transcribe-Diarize (Q8_0, Q4_K, BF16) | [OpenMOSS-Team/MOSS-Transcribe-Diarize](https://huggingface.co/OpenMOSS-Team/MOSS-Transcribe-Diarize) currently declares Apache-2.0, original commit `704aa4a9c304e8520be88901e0d1960158ef5b15` | Same |

The [shared `audio-cpp/audio.cpp-gguf` README at this commit](https://huggingface.co/audio-cpp/audio.cpp-gguf/blob/874fcb41ececda20bcbc0782d6b4ea7f7d069ea8/README.md) explicitly declares Apache-2.0 for these two folders, notwithstanding the aggregate repository's `license: other` tag. Model-card declarations corroborate the stated license category; neither a publisher-signed provenance attestation nor final redistribution clearance is implied. No third-party model files are bundled.

The exact file paths were found at `GET https://huggingface.co/api/models/audio-cpp/audio.cpp-gguf/tree/874fcb41ececda20bcbc0782d6b4ea7f7d069ea8?recursive=true`. Each `lfs.oid` is a full SHA-256 and its size matched the file's size. A **separate HEAD-only request** to `https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/{commit}/{path}`, without following the weight-redirect, independently confirmed within Hugging Face `X-Linked-Etag`, `X-Linked-Size` and `X-Repo-Commit` for every entry. This establishes *provider metadata consistency*, not independent attestation or a locally recomputed hash. The downloader verifies expected bytes upon an authorized future download, per PR #214.

| Package choice | Exact upstream path | Provider LFS SHA-256 | Metadata bytes |
| --- | --- | --- | ---: |
| `moss_transcribe_diarize_bf16` | `MOSS-Transcribe-Diarize-GGUF/moss-transcribe-diarize-bf16.gguf` | `5bc627289e2586fc2d9269afda15a305e545a4ff3512c902889be71d58e56ad5` | 1,833,018,080 |
| `moss_transcribe_diarize_q4_k` | `MOSS-Transcribe-Diarize-GGUF/moss-transcribe-diarize-q4_k.gguf` | `4e3020379ff592bbb22a4e3d47a7cd6709951cc5d451c561b69df955b5f0a220` | 758,293,216 |
| `moss_transcribe_diarize_q8_0` | `MOSS-Transcribe-Diarize-GGUF/moss-transcribe-diarize-q8_0.gguf` | `93eea5865615e270b827752945f2dfd0f522ed673f4f551675e9013170173679` | 1,132,110,560 |
| `moss_tts_nano_100m_bf16` | `MOSS-TTS-Nano-100M-GGUF/moss-tts-nano-100m-bf16.gguf` | `ea44b602f3fbd6e18d505c48533035bf2db604e929117abcd05d2d77b8f786c8` | 332,428,384 |
| `moss_tts_nano_100m_q8_0` | `MOSS-TTS-Nano-100M-GGUF/moss-tts-nano-100m-q8_0.gguf` | `823b0de64f01f1ee9a168356c1199be500d71ec2f769f0183b416c9e6dbc0abc` | 193,343,328 |

## Mirror and scope boundaries

ModelScope currently maps a different `HereIsMark/*` repository and mutable `master` revision. No equivalent immutable ModelScope commit/file hash has been established. The existing `packageHasExpectedSHA256` API gate returns `PACKAGE_MIRROR_UNVERIFIED` **before** downloader/task creation for these five hash-bearing package choices, as confirmed by fictional in-memory HTTP tests. Unhashed legacy packages are unaffected. Do not infer cross-provider equivalence from identical filenames.

Five packages now gain pinned revisions/hashes; the other **152** catalog entries (including the separately reviewed `moss_tts_local` family) are unchanged. The total expected-SHA-256 catalog coverage becomes **38 of 157** (119 remain unhashed), and shared GGUF becomes **32 of 112**. Separate work under #207 remains for more license families, original signed publisher provenance, 49 small Git-managed files, gated assets, and ModelScope mirror parity. No hosted CI, ACPX, deployment or inference was performed.
