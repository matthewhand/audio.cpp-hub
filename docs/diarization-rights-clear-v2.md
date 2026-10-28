# Rights-clear source-intake v2 (no audio generation)

The separate **future human RTTM QA completion** contract is documented in
[`diarization-human-rttm.md`](diarization-human-rttm.md); it never overrides
the `pending` state in this v2 source-intake schema.

This is an **approval-gated, source-only** companion to the existing v1
Sortformer engineering fixtures under PR #154. The original upstream-derived
WAV, RTTM and `manifest.json` remain untouched and **continue to be
explicitly unverified for redistribution**. This v2 preflight does not replace
them, revoke their exposure in Git history, or establish legal permission.

## Files and entrypoint

- `test/fixtures/diarization/intake-v2.schema.json` — strict JSON Schema
  Draft 2020-12 metadata contract, with `additionalProperties: false`.
- `scripts/diarization_intake_v2.py` — dependency-free,
  fail-closed validator using that contract, local source checks and
  cross-field requirements.
- `scripts/build-diarization-fixtures.py --validate-intake` — **validation
  only**. This mode has no output directory, never launches FFmpeg, never
  writes WAV/RTTM, and never loads a model.

After privately obtaining four original voice recordings and source-rights
evidence in a separately approved step, the intended preflight command is:

```bash
python3 scripts/build-diarization-fixtures.py \
  --validate-intake /secure/intake-v2.json \
  --source-root /secure/consented-voice-sources
```

Do **not** place private recordings or identifying consent documents in the
repository. The JSON manifest should contain only opaque evidence IDs and
approved public attribution text, with confidential evidence stored elsewhere.

The v2 CLI is intentionally **not a replacement audio builder**. There is no
`--output` accepted in v2 mode. The pre-existing v1
`--source <path> --output <dir>` option remains available for historical
reproducibility; it must not be used to regenerate or publish unverified
audio without separate permission.

## Contract and scope

The v2 JSON declares:

- `schema_version: 2`, non-identifying fixture-set ID;
- exact allowed open-content license identifier and canonical URL
  (`CC-BY-4.0` or `CC0-1.0`), public attribution, a private rights review
  reference, and affirmative verified recording redistribution and derivative
  mixing attestations;
- exactly four distinct `spk_01` … `spk_04` records, with local
  **relative** WAV paths, SHA-256, original-human-recording origin evidence,
  recording-rights references, separate performer-release references, and
  explicit approval booleans;
- planned `silence_0spk` (6s), `solo_1spk` (8.5s),
  `overlap_2spk` (12s), and `overlap_4spk` (19s) cases, with speaker
  rosters and required overlap policy;
- an explicit **pending** independent human-annotation section.
  Speaker identity and boundaries must be marked unverified. An actual
  adjudicated RTTM requires a distinct future review/approval step.

All four voice sources must be distinct local 16-kHz mono 16-bit PCM WAVs,
each 3–120 seconds long and at most 16 MiB. Sources must be inside the
explicit source root, with no traversal, absolute path or symlink.
The preflight securely opens each source beneath the approved root using
POSIX descriptor-relative opening with no-follow flags (including parent
directories); unsupported platforms **fail closed**, rather than falling
back to a race-prone path open. It reads at most 16 MiB + one sentinel
byte into a bounded, immutable in-memory snapshot, checks file metadata
for changes during that read, and evaluates the WAV structure, actual
PCM frame payload length (not just the declared header duration) and
SHA-256 against the **same bytes**.

Manifest reads are likewise bounded to 64 KiB, using descriptor-relative
no-follow opens for parent directories and final regular file. A stable
file snapshot is verified against its initial metadata. Symlink parents,
symlink targets, FIFOs, oversized files and concurrent mutations are
rejected rather than processed. Secure POSIX opening is required; other
platforms fail closed.

The standalone JSON Schema restricts WAV source paths to relative,
slash-separated, alphanumeric-leading segments ending in `.wav`; it
rejects `..`, absolute paths, backslashes, empty segments and trailing line breaks.
Cross-field checks (such as unique speakers and recording hashes,
release references, case rosters) and actual source-root containment
still require the **Python preflight**; JSON Schema alone is not a
rights-clear or file-admission decision. This is designed for a trusted,
access-controlled source root, and the pinned digest remains the
critical integrity control if a malicious actor can alter its files.

Metadata identifiers, speaker IDs and SHA-256 patterns have a strict end-of-input
check in both Python and JavaScript, including terminal newlines. Public
attribution must contain at least one character outside an explicitly
enumerated set of whitespace, control and invisible-format characters,
including soft hyphen, combining marks, Hangul fillers, variation selectors
and supplementary-plane Unicode tag characters. These characters may still
appear alongside visible attribution text, including non-Latin names.
Cross-engine synthetic tests use both default and Unicode-mode Node.js
regular expressions and Python's stdlib regex engine. Supplementary-plane
tag and variation-selector ranges are enumerated explicitly so the schema
remains compatible with default JavaScript regex mode. This is a targeted
denylist, not a Unicode-wide proof that every non-rendering code point
has been identified.

JSON Schema numeric equality (for example, 6 and 6.0) is respected in
the Python validator, while booleans remain distinct. The validator
does not transcribe, listen, infer, mix, download, resample or rewrite
any audio. These format constraints are **intentional input gates**,
not a conversion facility.

Passing the check returns only a non-sensitive metadata summary:

```json
{
  "schema_version": 2,
  "preflight": "metadata-and-local-audio-checks-passed",
  "sources_checked": 4,
  "cases_checked": 4,
  "rights_evidence": "references-present-not-authenticated",
  "human_annotation": "pending",
  "audio_generated": false
}
```

The check establishes only the **presence and consistency of claimed
rights/evidence references**, not the legitimacy of signatures, licences,
performer identities or permission scope. A human rights reviewer must
authenticate the release forms independently before any publication.
The current code does **not** inspect or store releases.

## Human ground-truth audit — workflow gate, not yet performed

A separate **synthetic-only, metadata-first** adjudication validator and
RTTM preview are described in
[`diarization-human-adjudication.md`](diarization-human-adjudication.md).
It checks two blind reviewers, reviewer/adjudicator separation, overlap,
evidence references, agreement/disagreement and the entire committed v2
intake schema. **No real annotators, listening, consent authentication, or
actual human ground truth have been supplied.** All such steps remain gated.

1. Confirm four distinct consented speakers and verify public redistribution
   and derivative-mixing permission for each recording and voice.
2. Two independent humans listen to and annotate speech-active intervals,
   pauses, speaker IDs, backchannels and every concurrent voice. Do not show
   either annotator model predictions or source-track placements as the
   authoritative speech-boundary truth.
3. Adjudicate all speaker-identity disagreements. Review onset/offset
   differences over **50 ms**; escalate over **100 ms** (proposed
   operational tolerances, not proven annotator accuracy).
4. Maintain separate raw reviewer RTTMs, adjudication decisions, final
   canonical RTTM, approved public speaker pseudonyms, hashes and evidence
   references. Exclude real names and consent signatures from public files.
5. Use sample-accurate placement references **separately** from final
   human-audited speech RTTMs. Split internal silence; preserve overlap as
   distinct simultaneous `SPEAKER` rows. Treat zero-speech reference DER
   as undefined (null), not 0.
6. Obtain independent licence and annotation audit plus separate permission
   to actually produce replacement WAVs and update this draft. Retain any
   historical Git blobs until a distinct history-remediation approval.

## Safety, tests, and release gate

Run the offline metadata-only tests (the Python suite uses zero-byte
placeholders with mocked WAV inspection and **does not generate audio**):

```bash
python3 test/unit/test_diarization_intake_v2.py
python3 test/unit/test_diarization_fixture_builder.py
```

In PR #154, existing WAVs, RTTMs, v1 hashes and Git history are preserved
verbatim. The real v2 audio builder, actual human annotation/listening, content
downloads, Sortformer inference, deployment and merge remain **out of scope**.
