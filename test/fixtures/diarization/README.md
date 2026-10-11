# Diarization fixture set (model-free)

Four **independently constructed, script-attributed** WAV/RTTM test pairs.
These are prepared from upstream `0xShug0/audio.cpp`'s tracked
`assets/resources/four_speaker_short.wav` and matching
`four_speaker_short.txt` at commit
`f6277c1695a83cf388a8282c1c1a8757cf626f18`.
The source's script explicitly labels four successive lines Speaker 1–4.
Broad source windows are selected using the source script's turn order and
FFmpeg silence inspection, **not** the Sortformer model's output.

## What is—and is not—ground truth

The generated RTTM start/end values and speaker-track labels are exact,
deterministic records of **where each separately selected source turn was
placed into the output recording**. They can validate RTTM parsing,
speaker-label permutations, multi-speaker overlap accounting, timestamp
arithmetic, false alarms, missing segments, and scoring integration.

**Important:** The underlying four voices have not been independently
audited by listening and identity verification. A source window may contain
internal silence and its edges are coarse, rather than human-annotated
phonetic speech onset/offset. The source audio's individual recording /
voice copyright permissions beyond the upstream Apache-2.0 repository
license have not been separately verified. Therefore, **these tests are
script-labelled engineering fixtures, not certified diarization accuracy
ground truth**. Do not publish Sortformer DER/JER on them as an
externally validated accuracy benchmark until source identities, labels,
boundaries and rights have been independently checked. No model-produced
labels were used to construct the references.

| WAV + RTTM basename | Duration | Source tracks | Deliberate overlap |
| --- | ---: | ---: | --- |
| `silence_0spk` | 6 s | 0 | None |
| `solo_1spk` | 8.5 s | 1 | None |
| `overlap_2spk` | 12 s | 2 | Yes |
| `overlap_4spk` | 19 s | 4 | Yes, two simultaneous |

All WAVs are 16-kHz mono signed-16-bit PCM; all RTTMs are native
`SPEAKER` records with source-track labels. The empty 0-speaker
reference is a deliberately **zero-byte RTTM**, not an RTTM for an
unlabelled or unknown speaker. `manifest.json` holds the source hash,
exact source/output sample offsets, WAV and RTTM SHA-256 hashes, and
explicit `human_voice_identity_verified: false` /
`phoneme_boundary_verified: false` review gates. The files contain
no private audio or user recordings.

## Rebuild (no model, no inference, no network)

From this repository with a local upstream audio.cpp checkout and FFmpeg:

```bash
python3 scripts/build-diarization-fixtures.py \
  --source ~/audio.cpp/assets/resources/four_speaker_short.wav \
  --output test/fixtures/diarization
```

The source is decoded once via FFmpeg and mixed by Python standard
library; this does **not** load a voice model. FFmpeg resampler versions
may affect byte-for-byte hashes; compare the resulting source and output
manifest when reproducing.

## RTTM scoring

The dependency-free `scripts/score-diarization-rttm.mjs` handles exact
reference/hypothesis interval partitioning, global one-to-one
permutation-invariant speaker mapping (up to four speakers), no forgiving
boundary collar, and included overlap. It reports missed speech,
false alarms, speaker confusion, and
`DER = (missed + falseAlarm + confusion) / referenceSpeakerSeconds`.

For a **silence** reference, the DER denominator is zero: the scorer
returns `der: null` alongside false-alarm seconds instead of inventing
a perfect score. Audio isn't loaded by the scoring utility.

```bash
node scripts/score-diarization-rttm.mjs \
  --ref test/fixtures/diarization/overlap_2spk.rttm \
  --hyp test/fixtures/diarization/overlap_2spk.rttm \
  --recording overlap_2spk --duration 12
```

For **previously saved** raw CLI Sortformer output
(`--turns-out` emits a bare JSON array, without its sample rate):

```bash
node scripts/score-diarization-rttm.mjs \
  --ref test/fixtures/diarization/overlap_2spk.rttm \
  --hyp-json /path/to/saved-turns.json \
  --sample-rate 16000 --duration 12
```

The sample-rate is required for bare native output; it must be the
actual sample-offset rate for that result. No rate or speaker
identity is inferred. The score uses a straightforward global
permutation and includes overlap; it does not yet offer pyannote/
md-eval-equivalent speaker collars, forgiveness, JER, or uncertainty
intervals. Such scores must be separately validated before cross-paper
comparisons.

Run **offline regression tests** (no inference and negligible CPU):

```bash
node --test test/unit/diarization-rttm.test.mjs
```

Live model inference, production server tests, GPU execution, new model
downloads, deployment and merge are **outside this fixture-building
task** and require their own approval. The existing pinned Q8 GGUF
on ubuntu-max may remain on disk **unloaded** throughout this work.
