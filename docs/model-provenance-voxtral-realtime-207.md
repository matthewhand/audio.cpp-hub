# Issue #207: Voxtral Realtime immutable GGUF provenance

Metadata-only audit against public audio.cpp-hub `main` `d7329c1a39286cd8316118c36c6495f650dcbe4d`. Only two Voxtral Mini 4B Realtime 2602 GGUF variants (Q8_0 and BF16) gain immutable revision and full expected LFS SHA-256. No weights, voice audio, private files or model bytes were fetched or redistributed; source edits and all offline tests occur on worker1, with teamstinky used only as an SSH/GitHub bastion.

## Publisher license and immutable per-file evidence

Original publisher [mistralai/Voxtral-Mini-4B-Realtime-2602](https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602) declares **Apache-2.0** in original model-card metadata and README at immutable publisher commit `2769294da9567371363522aac9bbcfdd19447add`. The [shared audio-cpp/audio.cpp-gguf README](https://huggingface.co/audio-cpp/audio.cpp-gguf/blob/874fcb41ececda20bcbc0782d6b4ea7f7d069ea8/README.md) independently declares Apache-2.0 for exact `Voxtral-Mini-4B-Realtime-2602-GGUF` directory. The shared aggregate license label `other` does not imply rights for other model families. These are provider-declared licenses, not signed upstream provenance or a final legal determination.

For each exact file path, immutable GGUF tree full 64-character Git LFS `oid` SHA-256 and byte size matched a **separate HEAD-only, no-redirect, no-content** `/resolve/{commit}/{path}` response (`X-Linked-Etag`, `X-Linked-Size`, and `X-Repo-Commit`). No redirect to weight bytes was followed. These provider metadata checks do **not** constitute independently hashing downloaded weights.

| Package | Exact immutable file path | Expected provider LFS SHA-256 | Provider byte size |
| --- | --- | --- | ---: |
| `voxtral_realtime_bf16` | `Voxtral-Mini-4B-Realtime-2602-GGUF/voxtral-mini-4b-realtime-2602-bf16.gguf` | `8970c7c1ce0c1db94da79a44f7c65e098d228bdb293d6ff31ede446d58a89e20` | 8,874,407,424 |
| `voxtral_realtime_q8_0` | `Voxtral-Mini-4B-Realtime-2602-GGUF/voxtral-mini-4b-realtime-2602-q8_0.gguf` | `d246cf359a34e365440e7af5064ff01fa54d8a9848d2127907d1864d1131fef3` | 5,104,571,904 |

## Fail-closed mirror and remaining work

The existing `PACKAGE_MIRROR_UNVERIFIED` safety guard rejects `source: modelscope` for the hash-bearing variants *before* a downloader/task is created. ModelScope resolves a different mutable `HereIsMark/*@master` mapping with unproven byte equivalence. In-memory fictional Go tests cover both HTTP 400 rejections, exact immutable HF URLs, expected digest strings and malformed 63/65/nonhex expected-hash inputs. They **do not hash model bytes** or independently prove the downloader's runtime hash-check implementation.

Exactly two of 157 package entries are modified; the other **155** remain byte-for-byte unchanged. Overall expected-hash coverage increases from **46/157 to 48/157**; shared GGUF from **40/112 to 42/112**. The Voxtral `q4_k` package remains unhashed and mutable for the existing compatibility contract. Issue #207 must remain **OPEN** for remaining 109 unhashed catalog choices, license conditions, gated assets, non-LFS sidecars, signed publisher provenance and unverified mirror equivalence. No ACPX, hosted CI, weight downloads, inference or deployment.
