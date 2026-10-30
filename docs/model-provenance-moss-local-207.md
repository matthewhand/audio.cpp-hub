# Issue #207 — MOSS-TTS Local GGUF immutable provenance batch

Metadata-only audit performed 2026-10-30 against public `main` `783d5f73042f0a355348ec4fe7d5b594bb85533f`. No model weights, voice audio or private content were downloaded, copied, inferred or redistributed. Development was performed in a task-owned isolated checkout on x86-64 worker1 rather than on the teamstinky filesystem.

## Source and original publisher license evidence

The original publisher [OpenMOSS-Team/MOSS-TTS-Local-Transformer-v1.5](https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Local-Transformer-v1.5) declares **Apache-2.0** in its original model-card metadata and README at immutable original commit `be7766a6735b98bd793f7c79fb720b4d0f5d13b8`. The [audio-cpp/audio.cpp-gguf README at immutable snapshot](https://huggingface.co/audio-cpp/audio.cpp-gguf/blob/874fcb41ececda20bcbc0782d6b4ea7f7d069ea8/README.md) separately declares Apache-2.0 for `MOSS-TTS-Local-v1.5-GGUF`. The aggregate GGUF repository declares `license: other` because different model families have different conditions. Model-card declarations are not signed provenance attestations or independent legal clearance.

Each exact file path was found in immutable `GET /api/models/audio-cpp/audio.cpp-gguf/tree/874fcb41ececda20bcbc0782d6b4ea7f7d069ea8?recursive=true`. Its full 64-character Git LFS SHA-256 `oid` and size matched a **separate no-redirect and no-file-content HEAD** request to `/resolve/{commit}/{path}`, including `X-Linked-Etag`, `X-Linked-Size`, and `X-Repo-Commit`. No redirect to model weight content was followed. These checks establish provider metadata consistency, not a hash independently recomputed from weights.

| Package choice | Exact GGUF source file | LFS SHA-256 | Provider size (bytes) |
| --- | --- | --- | ---: |
| `moss_tts_local_v1_5_bf16` | `MOSS-TTS-Local-v1.5-GGUF/moss-tts-local-v1.5-bf16.gguf` | `293d590dcf8c01686762af605cdc11b7aade5e328ea2b091150e09839794d57f` | 13,367,800,768 |
| `moss_tts_local_v1_5_q8_0` | `MOSS-TTS-Local-v1.5-GGUF/moss-tts-local-v1.5-q8_0.gguf` | `d465210814e60cc09224b33bf272bde519c871dda76997a8c17aed4878d1ba9a` | 7,512,224,256 |

## Mirror boundary and residual work

The existing `PACKAGE_MIRROR_UNVERIFIED` guard prohibits `source: modelscope` for these newly hash-bearing packages **before** downloader or task creation. ModelScope currently uses a different `HereIsMark/{name}` repository at mutable `master`. Equal filenames do not establish source byte equality. Fictional in-memory Go HTTP tests verify both rejections, immutable Hugging Face resolve paths, and preservation of legacy unhashed and previously pinned catalog variants. No runtime logic was changed.

Only two of 157 catalog choices gain immutable revisions and SHA-256; the other **155** stay unchanged. The prior #221 regression that used MOSS-TTS Local as an intentionally unhashed comparison now uses still-unhashed Higgs-Audio STT Q8_0; its guard remains rather than being removed. Catalog coverage becomes **40/157**, and the shared GGUF subset **34/112**. Original signed publisher attestations, other license conditions, gated packages, Git-managed sidecar checksums and ModelScope mirror parity remain unresolved under #207, which must stay OPEN. No hosted CI, model inference, release publication or deployment occurred.
