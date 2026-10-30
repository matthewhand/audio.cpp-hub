# Issue #207 — Qwen3-TTS Base immutable GGUF checksums

Metadata-only provenance audit for this batch against public `main` `f2599194f65dd3f766409417ee2fcb80670c3fb3`. Only the Qwen3-TTS 12Hz 1.7B Base Q8_0 and BF16 GGUF variants gain immutable revision pins and expected SHA-256. No model weights, audio, tokenizers or user files were downloaded or redistributed. Development and tests were confined to isolated worker1; teamstinky served as SSH/GitHub bastion.

## License and source evidence

Original publisher [Qwen/Qwen3-TTS-12Hz-1.7B-Base](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base) declares **Apache-2.0** in model metadata and original README at immutable commit `fd4b254389122332181a7c3db7f27e918eec64e3`. [The shared GGUF README at immutable commit](https://huggingface.co/audio-cpp/audio.cpp-gguf/blob/874fcb41ececda20bcbc0782d6b4ea7f7d069ea8/README.md) independently declares Apache-2.0 for `Qwen3-TTS-12Hz-1.7B-Base-GGUF`. The aggregate repository's top-level license label `other` does not grant permissions over unrelated model families. These are publisher/provider declarations rather than independent legal clearance or signed provenance attestations.

For each exact file, full 64-character LFS SHA-256 `oid` and size in the immutable GGUF tree endpoint matched a **separate HEAD-only, no-redirect, no-content** request at the same commit, checking `X-Linked-Etag`, `X-Linked-Size` and `X-Repo-Commit`. This is independent provider-metadata consistency, **not** a digest recomputed from weight bytes.

| Package choice | Immutable GGUF path | Full expected LFS SHA-256 | Provider byte count |
| --- | --- | --- | ---: |
| `qwen3_tts_1_7b_base_bf16` | `Qwen3-TTS-12Hz-1.7B-Base-GGUF/qwen3-tts-12hz-1.7b-base-bf16.gguf` | `db237375e0f04d10fd0ac0afc2855e6844fdcb04a7d471e8a4b6c36bdb6030d7` | 4,203,169,600 |
| `qwen3_tts_1_7b_base_q8_0` | `Qwen3-TTS-12Hz-1.7B-Base-GGUF/qwen3-tts-12hz-1.7b-base-q8_0_v2.gguf` | `92641a8022d521efd79a5db45e952589b3f2b781680f9abfcf26f075d37b86c6` | 2,695,186,240 |

## Mirror and regression contract

The existing `PACKAGE_MIRROR_UNVERIFIED` guard rejects `source: modelscope` for newly hash-bearing files **before** any downloader/task creation; ModelScope uses a separate mutable `HereIsMark/*@master` mirror with no verified byte parity. Fictional in-memory Go tests cover both 400 rejections, exact package revision and digest string, immutable resolve URLs, negative 63/65/nonhex expected-hash formats, the prior pinned VoiceDesign entry, an unchanged unhashed Base `orig`, and legacy RVC. The tests do **not** hash model bytes or independently prove downloader implementation correctness.

Exactly two of the 157 package choices are changed; the other **155** remain unchanged. Expected-hash coverage increases from **44/157 to 46/157**, shared GGUF from **38/112 to 40/112**. The earlier Qwen CustomVoice and VoiceDesign tests used Qwen Base Q8_0 as an intentionally unhashed comparison; both assertions remain, but are narrowly redirected to the still-unhashed Qwen Base `orig` package. The original GGUF `orig`, safetensors and sidecar entries are deliberately excluded. Issue #207 must remain OPEN for remaining 111 catalog entries and independent publisher attestations, license conditions, mixed Git-managed sidecars, gated assets and ModelScope equivalence. No ACPX, hosted CI, live model inference or deployment.
