# Speaker diarization contract and limitations

The hub dispatches **Sortformer** as `serverTask: diar` using the existing
asynchronous `POST /api/tasks` -> upstream `/v1/tasks/run` path. The model
must be loaded in a compatible audio.cpp server. Sortformer is a standalone
speaker-turn detector, **not** an ASR model and not an identity recognizer.
The four-speaker v1 checkpoint supports at most four distinct speakers and
its v1 inference mode is offline.

VibeVoice ASR may also return speaker turns alongside transcript text. Plain
Citrinet and Higgs STT do not become diarization models just because they
can produce a transcription.

## Raw and normalized formats

Non-TTS task results remain byte-for-byte preserved in
`data/tasks/<taskId>.result.json` and accessible at
`GET /api/tasks/<taskId>/result`. Upstream JSON may include:

```json
{
  "sample_rate": 16000,
  "speaker_turns": [
    {"speaker_id": "speaker_0", "start_sample": 0, "end_sample": 32000,
     "confidence": 0.92}
  ]
}
```

The Web UI normalizer `normalizeSpeakerTurns` returns a **presentation
object**, not a changed HTTP result. Its normalized contract is:

```json
{
  "status": "ok",
  "segments": [
    {"start": 0, "end": 2, "speakerId": "speaker_0", "text": null,
     "confidence": 0.92}
  ]
}
```

Time offsets are seconds derived from the *reported* sample rate, never
from a guessed default. `speakerId` is a model-assigned label stable only
to the extent the upstream model provides stable labels **within that audio
recording**. It does not indicate a named or persistent human identity.
Text is `null` unless the same upstream speaker turn supplies aligned
text, and confidence is omitted when absent/invalid. Overlaps and pauses
remain intact; valid turns are ordered by start/end offset. Invalid
timestamp ranges, noninteger samples or absent speaker identities are
dropped rather than silently reassigned.

Statuses are `ok` (including genuine zero detected turns),
`unsupported` (speaker_turns missing), `missing_sample_rate` (invalid
or missing time units), or `invalid_segments` (turns present, none valid).
Raw responses are not discarded even when normalization is impossible.
A standalone Sortformer result with zero text is correctly labelled
"speaker timing only": it cannot be used to synthesize per-speaker words.

## Acceptance gate and inference plan

Unit and Playwright mock tests prove *parsing and UI behavior only*.
They do not prove actual model quality or availability. Real validation
requires a compatible server build and weights on an isolated instance.
Do not restart or reconfigure existing inference services. Obtain
permission before downloading weights, launching an inference workload,
or using private conversation audio. With permission, run:
- A known two-speaker and a single-speaker WAV (mono 16 kHz) with annotated
  reference boundaries; include overlaps, silence and short turns.
- Confirm `/v1/tasks/run` emits `speaker_turns` and `sample_rate`
  using the exact pinned runtime; use its saved raw JSON as test evidence.
- Compare estimated versus ground-truth speaker turns (DER, missed and
  false speech, speaker swaps and onset/offset boundary errors).
- Record runtime build, model checksum, license, CPU/GPU backend, peak
  host RAM/VRAM, inference RTF, and model threshold settings.

Upstream reference: https://github.com/0xShug0/audio.cpp/blob/main/docs/speech_analysis.md

## Model resources and license (pre-benchmark estimates)

The NVIDIA v1 Sortformer model has about 0.1B parameters. The upstream
GGUF files are approximately 176 MB (Q8_0) and 248 MB (F16). audio.cpp
documents a default 512 MB graph arena and 128 MB weight context; those
are *settings*, not measured peak RAM/VRAM. Budget at least ~1 GiB
initially and measure actual peak memory on each device. CPU, CUDA,
Vulkan, and Metal are audio.cpp's generic backend selections; support and
reliability for the installed binary and the specific model/device must be
confirmed with a smoke test, not inferred from a backend name.

**License warning:** NVIDIA's v1 checkpoint and its GGUF conversions are
under **CC-BY-NC-4.0** (non-commercial). Do not distribute model weights
or use them commercially without reviewing license permissions. The
repo's model registry and download metadata do not redistribute weights.

Sources:
- https://huggingface.co/nvidia/diar_sortformer_4spk-v1
- https://huggingface.co/audio-cpp/audio.cpp-gguf
- https://github.com/0xShug0/audio.cpp/blob/main/docs/speech_analysis.md

## Model-free RTTM fixtures and scoring suite (draft PR #154)

Deterministic fixture WAVs/RTTMs live in
`test/fixtures/diarization/`, with a SHA-256/source-provenance
manifest and an offline builder at `scripts/build-diarization-fixtures.py`.
The four scenarios are silence, one speaker, two overlapping speaker
tracks, and four source-script speaker tracks with overlap.
They are constructed from upstream `four_speaker_short.wav` and its
independently authored four-speaker script, not from Sortformer output.

**Label integrity limitation:** The labels precisely record source-track
placement; acoustic voice identities and phonetic boundaries have not
been human-audited. These are script-attributed engineering fixtures,
**not certified human-annotated diarization ground truth**. Do not
report their DER as measured real-world model accuracy. The original source
audio's redistribution permission is also unverified; preserve draft status
until the usage rights are confirmed or the WAVs are replaced with
rights-clear recordings.

`scripts/score-diarization-rttm.mjs` compares RTTM hypothesis with RTTM
reference using one-to-one global speaker permutation, overlap-aware
misses/false alarms/confusion and zero collar. It also accepts
saved native CLI turn JSON with an explicit sample rate.
Empty-reference DER is `null`, not a false zero; false-alarm seconds
remain observable. The scorer never loads audio or runs inference.
See `test/fixtures/diarization/README.md` for provenance, limitations,
rebuild instructions and CLI examples.
