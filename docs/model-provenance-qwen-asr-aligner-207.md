# Issue #207: Qwen3 ASR and ForcedAligner GGUF metadata pinning

Metadata-only audit conducted 2026-10-30 against public `main` at `0c9db3afb9a1fc78ec5aedac41f9a0d54da9f903`. This source-only batch pins **six GGUF package choices**, not their separately packaged safetensors models. No weights, audio, license files, or model content were fetched, hashed locally, inferred, copied, or redistributed.

## Independent source declarations and integrity evidence

| Family and packages | Original model publisher and source-declared license | Immutable GGUF snapshot |
| --- | --- | --- |
| Qwen3 ASR 0.6B (Q8_0 and F16) | [Qwen/Qwen3-ASR-0.6B](https://huggingface.co/Qwen/Qwen3-ASR-0.6B), Apache-2.0, original model commit `5eb144179a02acc5e5ba31e748d22b0cf3e303b0` | `874fcb41ececda20bcbc0782d6b4ea7f7d069ea8` |
| Qwen3 ASR 1.7B (Q8_0 and F16) | [Qwen/Qwen3-ASR-1.7B-hf](https://huggingface.co/Qwen/Qwen3-ASR-1.7B-hf), Apache-2.0, original model commit `bcd2b5b7f32b480ab5790554cfa8347f246a14f3` | Same |
| Qwen3 ForcedAligner 0.6B (Q8_0 and F16) | [Qwen/Qwen3-ForcedAligner-0.6B](https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B), Apache-2.0, original model commit `c7cbfc2048c462b0d63a45797104fc9db3ad62b7` | Same |

The [audio-cpp/audio.cpp-gguf immutable README](https://huggingface.co/audio-cpp/audio.cpp-gguf/blob/874fcb41ececda20bcbc0782d6b4ea7f7d069ea8/README.md) separately declares Apache-2.0 for the exact three GGUF directories, despite the aggregate repository declaring `license: other` for its mixed-license families. Original Qwen cards were checked separately at metadata API endpoints. These are provider-declared licenses and metadata consistency, **not** independently signed file attestations or a final legal/redistribution determination.

Each file path was checked in `GET https://huggingface.co/api/models/audio-cpp/audio.cpp-gguf/tree/874fcb41ececda20bcbc0782d6b4ea7f7d069ea8?recursive=true`: full LFS `oid` is 64 lowercase hex characters with size in bytes. A *separate no-redirect, no-file-content HEAD* `/resolve/{commit}/{path}` response agreed on `X-Linked-Etag`, `X-Linked-Size`, and `X-Repo-Commit` for **each** of these six files. This validates provider metadata consistency, not a SHA-256 calculated from downloaded weights. The downloader from #214 enforces expected digests before completion when a user later authorizes a download.

| Package choice | Exact upstream path | Expected SHA-256 | Metadata size (bytes) |
| --- | --- | --- | ---: |
| `qwen3_asr_0_6b_f16` | `Qwen3-ASR-0.6B-GGUF/qwen3-asr-0.6b-f16.gguf` | `490fefbe91b33e1a0aeb988b97b983d3b95ecd225195e3ca5025ed00923e94d2` | 1,880,649,568 |
| `qwen3_asr_0_6b_q8_0` | `Qwen3-ASR-0.6B-GGUF/qwen3-asr-0.6b-q8_0.gguf` | `5c53bbb9a6b2ade85c16c290c560658ca18b78a23c323378528f1f945683fcbe` | 1,151,279,968 |
| `qwen3_asr_1_7b_f16` | `Qwen3-ASR-1.7B-GGUF/qwen3-asr-1.7b-f16.gguf` | `59baf62f2454a1b4d1d9ffed730dbf1d0bce28ed6fec30897de17f9d6d452fc3` | 4,087,660,800 |
| `qwen3_asr_1_7b_q8_0` | `Qwen3-ASR-1.7B-GGUF/qwen3-asr-1.7b-q8_0.gguf` | `3bc2462eca3a3a8f56abcd860d0943ffdc0546547dde55a9d08589607d6f3936` | 2,473,017,600 |
| `qwen3_forced_aligner_0_6b_f16` | `Qwen3-ForcedAligner-0.6B-GGUF/qwen3-forced-aligner-0.6b-f16.gguf` | `38c413223c5e20d20bf43e0aee488fbd7df54a153b2f40d9dea5be5be73bbb8f` | 1,840,101,056 |
| `qwen3_forced_aligner_0_6b_q8_0` | `Qwen3-ForcedAligner-0.6B-GGUF/qwen3-forced-aligner-0.6b-q8_0.gguf` | `bf4fec616f77a20d89a649cd1c97bda269644eeb3cf906d1f7488a52d71f7cb2` | 1,129,969,856 |

## Source selection, compatibility and remaining gaps

The current ModelScope route resolves a separate `HereIsMark/{name}@master` repository without proven equivalence to the immutable Hugging Face GGUF snapshot. The existing #216 `packageHasExpectedSHA256` guard fails closed (`PACKAGE_MIRROR_UNVERIFIED`) **before any downloader is used** for each of these six choices. Synthetic in-memory HTTP tests assert this behavior. Unhashed legacy packages retain their existing download semantics.

Only six existing catalog packages change their revision and `sha256` field. The other 151 catalog package entries, including **mixed Git/LFS safetensors entries** for Qwen3 ASR and ForcedAligner, are unchanged. Total package choices with expected SHA-256 becomes 33 of 157; 124 remain unverified, and the shared GGUF subset becomes 27 of 112. As before, ModelScope equivalence, authenticated publisher signatures, complete external license terms, small-file digests and gated files remain separate #207 work. No hosted CI, inference, model downloads or release/deployment occurred in this batch.
