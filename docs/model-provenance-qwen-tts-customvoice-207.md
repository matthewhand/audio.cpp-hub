# Issue #207: Qwen3-TTS CustomVoice GGUF provenance

Metadata-only audit on 2026-10-30 against `main` `1d46ae2c092679949edeeb025a66401c254d8f7b`. Two Qwen3-TTS 12Hz 1.7B CustomVoice GGUF variants (Q8_0 and BF16) are pinned. No model weights, voice samples, credentials or model bytes were downloaded or redistributed. All source edits and Go tests are on isolated x86-64 worker1; teamstinky is an SSH/GitHub publication bastion.

## Original publisher license and immutable source

The original [Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice) publisher model card and README declare Apache-2.0 at commit `0c0e3051f131929182e2c023b9537f8b1c68adfe`. The [shared audio-cpp/audio.cpp-gguf README](https://huggingface.co/audio-cpp/audio.cpp-gguf/blob/874fcb41ececda20bcbc0782d6b4ea7f7d069ea8/README.md) separately declares Apache-2.0 for the `Qwen3-TTS-12Hz-1.7B-CustomVoice-GGUF` directory. Aggregate repository `license: other` covers other models and does not grant rights to unrelated assets. These declarations are provider metadata, not a signed source attestation or a legal redistribution finding.

For each exact file path, full 64-character Git LFS oid SHA-256 and file size in the immutable tree endpoint matched a **separate no-redirect HEAD-only** response at the identical commit (`X-Linked-Etag`, `X-Linked-Size`, `X-Repo-Commit`). No redirect to weight content was followed. Provider metadata consistency is distinct from independently hashing downloaded weights.

| Package | Immutable path | Expected SHA-256 | Provider file size (bytes) |
| --- | --- | --- | ---: |
| `qwen3_tts_1_7b_customvoice_bf16` | `Qwen3-TTS-12Hz-1.7B-CustomVoice-GGUF/qwen3-tts-12hz-1.7b-customvoice-bf16.gguf` | `5be0742e196ea9cd9ce0d7d8b69b0fc4fa8181b06cb0bd0591fb1dcdfce6c5a5` | 4,179,155,488 |
| `qwen3_tts_1_7b_customvoice_q8_0` | `Qwen3-TTS-12Hz-1.7B-CustomVoice-GGUF/qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf` | `c8ac3f94b6e73f137c0e7ecc9270bc8faec7a476ff799b87e48844d1d0987ac3` | 2,817,055,200 |

## Fail-closed mirrors and remaining work

The existing source guard rejects `source: modelscope` with `PACKAGE_MIRROR_UNVERIFIED` before any downloader or task is created for these two hash-pinned entries. ModelScope maps a separate `HereIsMark/*@master` source without proven matching bytes or revision. Synthetic offline in-memory API tests verify both rejections, strict expected digest validation, immutable HF resolve URLs, and prior pinned/legacy compatibility.

Only two manifest package entries change their revision and sha256; the other **155** remain byte-for-byte unchanged. Catalog coverage rises from **40/157 to 42/157**, and shared GGUF becomes **36/112**. Other Qwen TTS models, mixed Git-managed sidecars, gated or restricted packages, independent publisher attestations, license terms and ModelScope equivalence remain unfinished in issue #207, which must remain open. No hosted CI, ACPX, inference, deployment or source runtime changes.
