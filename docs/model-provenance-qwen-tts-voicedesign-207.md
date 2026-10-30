# Issue #207: Qwen3-TTS VoiceDesign GGUF provenance

Metadata-only source audit on 2026-10-30 against public `main` `a9665b8cce24186458a3a8a49f0e070f3514219e`. Two Qwen3-TTS 12Hz 1.7B VoiceDesign GGUF variants (Q8_0 and BF16) gain immutable revisions and expected full SHA-256. No model weights, audio, private files or model bytes were fetched or redistributed. All development and offline tests are confined to isolated x86-64 worker1; teamstinky is an SSH/GitHub bastion.

## Original publisher licensing and immutable source

The original publisher [Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign) README and model-card metadata declare **Apache-2.0** at immutable original commit `5ecdb67327fd37bb2e042aab12ff7391903235d3`. The [shared audio-cpp/audio.cpp-gguf README at immutable commit](https://huggingface.co/audio-cpp/audio.cpp-gguf/blob/874fcb41ececda20bcbc0782d6b4ea7f7d069ea8/README.md) separately declares Apache-2.0 for `Qwen3-TTS-12Hz-1.7B-VoiceDesign-GGUF`. The aggregate repository has `license: other` because other model families have different terms. These are publisher/provider license declarations, not signed file attestations or a final legal rights determination.

For each exact file path, the full 64-character SHA-256 Git LFS `oid` and byte size in Hugging Face immutable tree metadata matched a separate **HEAD-only, no-redirect, no-content** `/resolve/{commit}/{path}` response: `X-Linked-Etag`, `X-Linked-Size`, and `X-Repo-Commit`. No weight redirect was followed. Provider metadata agreement is **not** independent on-disk hashing of model bytes.

| Package choice | Exact file path | Declared LFS SHA-256 | Metadata size (bytes) |
| --- | --- | --- | ---: |
| `qwen3_tts_1_7b_voicedesign_bf16` | `Qwen3-TTS-12Hz-1.7B-VoiceDesign-GGUF/qwen3-tts-12hz-1.7b-voicedesign-bf16.gguf` | `f12c79e8c492f006b04f5ba823bebe512c9d46e13a7837081f1d34803b4bac0e` | 4,179,100,352 |
| `qwen3_tts_1_7b_voicedesign_q8_0` | `Qwen3-TTS-12Hz-1.7B-VoiceDesign-GGUF/qwen3-tts-12hz-1.7b-voicedesign-q8_0.gguf` | `b86e03d1d2077bbaed157ab7a7fc646c3e309e69afa52c5e1c86b622b4715057` | 2,817,000,064 |

## Security and residual scope

Existing `PACKAGE_MIRROR_UNVERIFIED` validation rejects a ModelScope selection **before creating a download task** for both newly pinned entries. Its `HereIsMark/*@master` mapping has not been proven equivalent to these immutable HF files. Fictional in-memory HTTP tests exercise that boundary, strict **expected-digest string format** (including 63/65 character and non-hex adversarial cases), source URLs and legacy behavior. The tests do **not** hash model bytes or independently validate the content downloader; existing runtime hashing behavior is unchanged.

Only two catalog entries change revision and `sha256`; the other **155** remain byte-for-byte unchanged. The earlier Qwen3-TTS CustomVoice regression used VoiceDesign as an intentionally unhashed comparison; that stale fixture is preserved and repointed to the unchanged, still-unhashed Qwen3-TTS Base Q8_0 package. Catalog expected-hash coverage becomes **44/157**, shared GGUF **38/112**. Other Qwen models, small Git-managed sidecar checksums, gated assets, license conditions, publisher-signed provenance and mirror equivalence remain for #207; the issue must remain OPEN. No hosted CI, ACPX, real model downloads, inference, release or deployment.
