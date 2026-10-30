# Issue #207 — NVIDIA Parakeet-TDT 0.6B v3 expected GGUF SHA-256

Metadata-only source audit against public audio.cpp-hub `main` `a4029ed5796bed7779baa79dc0077066925136f7`. Exactly two Parakeet-TDT 0.6B v3 GGUF variants (Q8_0 and F16) gain an immutable revision pin and expected file SHA-256. No model weights, audio, configuration secrets or private files were downloaded, redistributed or used for inference. Source changes and offline tests occur on worker1; teamstinky is only the SSH/GitHub bastion.

## Attribution, license and original publisher

**Credit:** NVIDIA, original creator/publisher of [Parakeet-TDT-0.6B-v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3); downstream GGUF conversion is published in [audio-cpp/audio.cpp-gguf](https://huggingface.co/audio-cpp/audio.cpp-gguf). The original NVIDIA [model card at immutable commit](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3/tree/541d1f99c6b0c3cd0b11a95167540bb8edefd82b) and README both declare **Creative Commons Attribution 4.0 International (CC BY 4.0)**. The [shared GGUF README at immutable commit](https://huggingface.co/audio-cpp/audio.cpp-gguf/blob/874fcb41ececda20bcbc0782d6b4ea7f7d069ea8/README.md) separately lists `Parakeet-TDT-0.6B-v3-GGUF` as CC-BY-4.0. [Full license terms](https://creativecommons.org/licenses/by/4.0/legalcode.en) and [plain-language summary](https://creativecommons.org/licenses/by/4.0/).

**Attribution obligation:** If model material or adaptations are shared, users must provide appropriate NVIDIA creator credit, a link to the license, indicate whether changes were made, and retain supplied notices where applicable. This PR only adds metadata and documentation: it **does not distribute or modify the GGUF model files**. Quantized/conversion variants may constitute adapted material; this PR makes no claim to satisfy all future distributor obligations or grant legal clearance. No claim is made that training data or other unrelated assets have CC-BY-4.0 rights.

## Immutable metadata cross-check (no weight bytes)

At shared GGUF commit `874fcb41ececda20bcbc0782d6b4ea7f7d069ea8`, each exact file's 64-character Git LFS SHA-256 `oid` and size matched a separate **HEAD-only, no-redirect, no-content** `/resolve/{commit}/{path}` response (`X-Linked-Etag`, `X-Linked-Size`, `X-Repo-Commit`). No weight redirect was followed; this is agreement between two provider metadata interfaces, **not independent hashing of model bytes** or a signed original-publisher attestation.

| Package | Immutable file path | Full declared LFS SHA-256 | Size (bytes) |
| --- | --- | --- | ---: |
| `parakeet_tdt_f16` | `Parakeet-TDT-0.6B-v3-GGUF/parakeet-tdt-0.6b-v3-f16.gguf` | `1720770887bbb6ae633b3375c6ce4b76b3eaff9cd4efd7b890db734cc0adfe80` | 1,255,386,336 |
| `parakeet_tdt_q8_0` | `Parakeet-TDT-0.6B-v3-GGUF/parakeet-tdt-0.6b-v3-q8_0.gguf` | `6fa498f10f8cb606f041aa9512733cfee842a932359b00b0c45b9b723c4f4f4b` | 915,735,760 |

## Mirror, tests, residual risk and remaining scope

Existing `PACKAGE_MIRROR_UNVERIFIED` fail-closed behavior rejects `source: modelscope` for these hash-bearing files **before** a downloader task is created. ModelScope maps a different mutable `HereIsMark/*@master` repository without demonstrated immutable byte parity. Permanent fictional in-memory Go tests check both HTTP 400 rejections with empty Hub sentinel, immutable HF URLs, expected-digest strings and adversarial 63/65/nonhex invalid inputs, and prior pinned/unhashed package compatibility. They do **not** hash actual weights or independently validate the downloader's full byte-integrity implementation.

Only **2 of 157** catalog entries change; the other **155** remain byte-for-byte unchanged. If merged, expected-hash coverage rises from **48/157 to 50/157**, shared GGUF from **42/112 to 44/112**. Issue #207 stays **OPEN** for the remaining 107 catalog entries, attribution and publisher notices, signed provenance, non-LFS sidecars, gated model rights and unverified mirrors. No hosted CI, ACPX, weight download, inference or deployment.
