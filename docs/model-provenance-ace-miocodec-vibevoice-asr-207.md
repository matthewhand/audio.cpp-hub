# Issue #207 — ACE-Step, MioCodec and VibeVoice ASR GGUF provenance pilot

Metadata-only checks performed 2026-10-30 against public `main` at `5f7e0d6365ae488fd92c448f6370160dabe457b3`. This is a source-only manifest change: no model files, audio, weights, license documents, tokens or live inference were fetched, stored, hashed locally, copied or distributed.

## Original publisher licensing and immutable reference

| Family / count | Original publisher metadata | Shared GGUF source declaration |
| --- | --- | --- |
| ACE-Step 1.5 / 4 | [ACE-Step/Ace-Step1.5](https://huggingface.co/ACE-Step/Ace-Step1.5) currently declares MIT at original snapshot `19671f406d603126926c1b7e2adc169acbcade22`; [ACE-Step/acestep-v15-base](https://huggingface.co/ACE-Step/acestep-v15-base) also declares MIT at `e432212fec32b8965a14ffa57ae653438d6abd14`. | `ACE-Step1.5-GGUF`: MIT |
| MioCodec / 3 | [Aratako/MioCodec-25Hz-44.1kHz-v2](https://huggingface.co/Aratako/MioCodec-25Hz-44.1kHz-v2) declares MIT at `67faba34153fe74e6665991c432a7327e23c5c1c`. | `MioCodec-25Hz-44.1kHz-v2-GGUF`: MIT |
| VibeVoice ASR / 2 | [microsoft/VibeVoice-ASR](https://huggingface.co/microsoft/VibeVoice-ASR) declares MIT at `d0c9efdb8d614685062c04425d91e01b6f37d944`. | `VibeVoice-ASR-GGUF`: MIT |

The shared [audio-cpp/audio.cpp-gguf README](https://huggingface.co/audio-cpp/audio.cpp-gguf/blob/874fcb41ececda20bcbc0782d6b4ea7f7d069ea8/README.md) gives separate MIT declarations for these three directories. The aggregate source repository carries `license: other` because other model families have different conditions. These are independently cross-checked *declarations*, not formal legal clearance or independent signed original-publisher file attestations. The ACE-Step turbo variants were tied to the aggregate ACE-Step1.5 publisher declaration; the separately probed `ACE-Step/acestep-v15-turbo` path did not return public metadata and is **not** treated as a verified separate provenance grant. No third-party model files are redistributed.

For every file below, the exact path was located at Hugging Face GGUF commit `874fcb41ececda20bcbc0782d6b4ea7f7d069ea8`. Its `GET /api/models/audio-cpp/audio.cpp-gguf/tree/{commit}?recursive=true` LFS SHA-256 `oid` and size matched a separate **HEAD-only** `/resolve/{commit}/{path}` response's `X-Linked-Etag`, `X-Linked-Size` and `X-Repo-Commit`. Weight redirects were **not followed**. This establishes provider metadata consistency; SHA-256 is subsequently enforced during a real authorized download by the existing download implementation from #214.

| Package choice | Upstream file | LFS SHA-256 | Size (bytes) |
| --- | --- | --- | ---: |
| `ace_step_base_bf16` | `ACE-Step1.5-GGUF/base/ace-step-1.5-base-bf16.gguf` | `d5bb61554bd8669ba5498054422e7a771414257d77acc47b3953e5da8c98836f` | 10,090,405,184 |
| `ace_step_base_q8_0` | `ACE-Step1.5-GGUF/base/ace-step-1.5-base-q8_0.gguf` | `2fb7bc3627c79bc99486510619d4264da22d40814edff0415dd3337164336e4a` | 6,185,466,944 |
| `ace_step_turbo_bf16` | `ACE-Step1.5-GGUF/turbo/ace-step-1.5-turbo-bf16.gguf` | `7aa8cc911bb7e47647bba619cf25afc22a42e35c568a102cd9a3b28a54b94013` | 10,090,406,336 |
| `ace_step_turbo_q8_0` | `ACE-Step1.5-GGUF/turbo/ace-step-1.5-turbo-q8_0.gguf` | `1f0015f81c10a1182531e6207c7aeaa060b8cad3470a2f88daa3cb74ed636e63` | 6,185,468,096 |
| `miocodec_f16` | `MioCodec-25Hz-44.1kHz-v2-GGUF/miocodec-25hz-44khz-v2-f16.gguf` | `6b921c62f66839ca6849e53252987a76b44950f1f3e2e0c03bcd34526a4558f4` | 452,912,544 |
| `miocodec_orig` | `MioCodec-25Hz-44.1kHz-v2-GGUF/miocodec-25hz-44khz-v2-orig.gguf` | `997190af1b7a302bf037942a5aa78434d261d8c4fe54bf03f52a380aa8656868` | 905,709,120 |
| `miocodec_q8_0` | `MioCodec-25Hz-44.1kHz-v2-GGUF/miocodec-25hz-44khz-v2-q8_0.gguf` | `f785604da457327caf26e4f0fc14bd4b8aac20116d6612e9076a386071f3a05b` | 299,068,928 |
| `vibevoice_asr_f16` | `VibeVoice-ASR-GGUF/vibevoice-asr-f16.gguf` | `7858c8551dd623158e6e03b84ebc9fbf7021f67069c4d26e95c0dca6a713e67c` | 17,361,094,560 |
| `vibevoice_asr_q8_0` | `VibeVoice-ASR-GGUF/vibevoice-asr-q8_0.gguf` | `6cefa920277f13d102c0014397044c52b63aa02e1a54f519e1732e04217859f8` | 9,858,648,480 |

## Compatibility, mirror and remaining work

The existing `POST /api/downloads` `PACKAGE_MIRROR_UNVERIFIED` guard from #216 rejects `source: "modelscope"` **before** downloader/task creation for packages with expected SHA-256: ModelScope maps to a separate `HereIsMark` repository at mutable `master`, without proven equality to this immutable Hugging Face commit. Existing unhashed legacy catalog entries retain their prior mirror behaviour. No ModelScope equivalence, real weights or runtime output was tested.

Nine package choices were pinned in this change, leaving 130 of 157 catalog package variants without hashes (27 now have hashes). Among the 112 shared GGUF variants, 21 now carry hashes, leaving 91 unchanged. All 148 other catalog package variants (including prior pinned entries) retain their metadata. Both prior tests that used ACE-Step as a deliberately *unhashed* example now use the unchanged `rvc_f16` legacy package; those protections are retained rather than deleted.

Run all Go packages offline and the focused race/contract tests using fictional in-memory HTTP data only. Issue #207 stays open for remaining original publisher terms, signed attestations, mixed Git/LFS assets, gated models and mirror equivalence. No hosted Actions, deployments, audio processing or distribution of weights.
