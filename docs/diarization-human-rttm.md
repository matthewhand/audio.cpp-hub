# Human RTTM completion manifest v1 — independent technical QA

This is an **additive, approval-gated, source-only** contract for draft PR
#154. It does **not** alter `intake-v2.schema.json`, its mandatory
`human_annotation.status = pending`, or the existing WAVs, RTTMs and v1
manifest. Existing rights and human speech labels are **unverified**. Do not
merge/publish unverified recordings.

## Artifacts

- `test/fixtures/diarization/human-rttm-completion-v1.schema.json`:
  strict JSON Schema Draft 2020-12. A separate `adjudicated_pending_qa`
  record, **never** a change to the intake manifest.
- `scripts/validate-human-rttm.py`: fail-closed **read-only** structural
  check. Reads explicitly supplied future approved local artifacts only;
  never runs an ASR/diarization model, records, synthesizes, downloads,
  modifies media, or publishes anything.
- `test/unit/test_human_rttm_qa.py`: **synthetic metadata and RTTM-only**
  tests. Fake audio inputs are deliberately *not WAVs*; the audio inspector
  is stubbed. No WAV generation or access to existing fixture audio.

### Proposed separate approval for future use

After an independent rights review and permitted future audio preparation,
run (only with separately authorized source inputs):

```bash
python3 scripts/validate-human-rttm.py \
  --completion /secure/completion.json \
  --intake /secure/intake-v2.json \
  --artifact-root /secure/approved-rttm-and-audio
```

Paths must be confined beneath an access-controlled artifact root; POSIX
descriptor-relative no-symlink reads are required and unsupported systems
fail closed. Audio snapshot ≤16 MiB each; RTTM ≤64 KiB each; manifest/log
≤64 KiB. Only metadata/RTTM/audio **structure and hashes** are inspected,
not model speech interpretation. Keep signing records, reviewer identities,
performer releases and consent documents in restricted storage, never in
public JSON or GitHub.

## Completion contract

A canonical completion record identifies the exact v2 intake manifest
SHA-256, fixture set ID, rights-evidence reference, four anonymous distinct
role IDs (reviewers A/B, adjudicator C, independent QA), a frozen RTTM from
each reviewer, an adjudicated RTTM, a decision log, and their checksums.
Each recording has an approved roster and an exact duration of 6, 8.5,
12, or 19 seconds at 16 kHz.

Reviewers A/B must listen independently and submit frozen annotations before
adjudication, without seeing model output or each other's answers.
Software verifies **claims of distinct roles and frozen references**, not
that listening genuinely occurred; human audit is mandatory. All reviewer
identifiers must be opaque tokens, never real names or emails.

The adjudication JSON for each case must be:

```json
{
  "schema_version": 1,
  "case_id": "solo_1spk",
  "decisions": [
    {
      "dispute_id": "D001",
      "start_sample": 8000,
      "end_sample": 9600,
      "category": "boundary",
      "status": "resolved",
      "rationale": "Example only; review the audible onset",
      "adjudicator_id": "ANONADJUDICATOR"
    }
  ]
}
```

This example is **not** a completed reviewer record. Accepted categories:
`identity`, `boundary`, `speech_presence`, `overlap`, `other`.
All differences between reviewer speaker-activity sets, **and between each
reviewer and the adjudicated final reference**, must be fully covered by
resolved adjudication intervals. Adjacent reviewer disagreements are
combined into contiguous regions; declared counts must match computed
regions and decision-log entries. The 50 ms review / 100 ms escalation
thresholds are procedural human-QA triggers, **not exemptions** from
machine-validated disagreement coverage.

## Canonical reference acceptance

- Strict ten-field, ordered RTTM `SPEAKER` rows with channel `1`,
  recording ID equal to case key, approved `spk_01..spk_04` IDs,
  no non-finite times, zero/negative durations, out-of-bounds spans or
  same-speaker self-overlap. Boundaries snap to the 16 kHz sample grid with
  ≤0.01 sample tolerance for six-decimal export.
- `silence_0spk`: zero-valued signed-16-bit PCM samples and **zero-byte**
  reviewer/final RTTM.
- `solo_1spk`: exactly one active approved voice in final RTTM.
- `overlap_2spk`: exactly two approved voices, at least 3200 sample
  positions (200 ms) of simultaneous voices in the final RTTM.
- `overlap_4spk`: all four approved voices present, at least 3200 sample
  positions (200 ms) of any cross-speaker overlap.
- Validate final RTTM SHA-256, both reviewer RTTM hashes, decision log,
  sample count and audio SHA-256 from the exact supplied bytes; reject
  missing/duplicate artifact paths, path traversal, symlinks and changed
  file metadata on read.
- `review_summary.unresolved_disputes` must be **zero**. The validator
  does not decide who is actually audible; a human QA reviewer separately
  verifies speaker identity, pauses, backchannels, unclear vocalizations
  and overlaps by listening.

This validator uses its own annotation structural checks. The existing
`score-diarization-rttm.mjs` remains **unchanged**; its zero-collar,
overlap-inclusive DER is not proof of ground-truth annotation accuracy.

## Output and release gate

Passing validation prints a small JSON object with
`status: technical_qa_passed`, four cases validated and
`provenance_hashes_match: true`. The fields
`human_attestations_authenticated`, `redistribution_authorized` and
`release_authorized` remain **false**. This intentionally cannot act as
a self-attested publication certificate. Independent rights, consent,
human-listening and final release approval all remain separate gates.
