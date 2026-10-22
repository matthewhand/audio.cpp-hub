# Diarization validation contracts (source-only)

This source change contains **validator/generator source, JSON Schemas and pure RTTM scoring only**. It intentionally contains **no recorded voice samples**, no human-authored ground truth, no RTTM completion manifests, and no proof of source-audio rights. This is not a release of a diarization benchmark or evidence of model accuracy.

## Pipeline

~~~mermaid
flowchart LR
    A[Rights-cleared source intake] --> B[Independent blind reviewer A/B]
    B --> C[Adjudication & consensus RTTM]
    C --> D[Independent structural QA]
    D --> E[Optional offline RTTM scoring]
~~~

- `scripts/build-diarization-fixtures.py` is generator source only; no media is bundled. Its turn boundaries are engineering placeholders, and production use requires independently authorised, rights-cleared input.
- `scripts/diarization_intake_v2.py` and `test/fixtures/diarization/intake-v2.schema.json` define a strict, evidence-linked intake contract. All real-person recordings and rights documents stay outside Git.
- `scripts/validate-diarization-adjudication.py` verifies declared reviewer and adjudication metadata against the frozen source artifacts; it cannot establish that listening actually occurred.
- `scripts/validate-human-rttm.py` and `human-rttm-completion-v1.schema.json` validate a completed, independently approved annotation set. Metadata claims are not a substitute for human consent or adjudication.
- `scripts/score-diarization-rttm.mjs` scores **supplied** reference and hypothesis RTTM with zero collar and overlap accounting. It cannot certify the references as ground truth. A silence reference yields undefined DER rather than claiming perfection.

Validation is offline and read-only; the separate generator writes to an explicitly requested output directory and must only use approved input media. They cannot download models or register new hub instances.

## Offline tests (no speech audio)

~~~sh
python3 -B test/unit/test_diarization_fixture_builder.py -q
python3 -B test/unit/test_diarization_intake_v2.py -q
python3 -B test/unit/test_diarization_adjudication.py -q
python3 -B test/unit/test_human_rttm_qa.py -q
node --test test/unit/diarization-adjudication-scoring.test.mjs
~~~

## Source-only follow-up to draft #154

The rights-clear v2 identifier and WAV-relative-path schema patterns use strict
end-of-input checks across Python and JavaScript, rejecting trailing newlines.
The public-attribution rule rejects blank, whitespace-only, and enumerated
invisible-only strings (including soft hyphens, combining joiners, variation
selectors, Hangul fillers, Unicode tag characters, and supplementary-plane
Egyptian, shorthand, and musical formatting controls) while retaining valid
international names and supplementary-plane characters. Lone UTF-16 surrogate
code units are invalid, including when mixed with visible characters; actual
valid supplementary characters remain accepted in both JavaScript modes.
The schema also rejects supplementary invisible controls presented as explicit
UTF-16 surrogate pairs in Python in-memory strings, while the project intake
validator canonicalizes well-formed surrogate pairs before length and pattern
validation; malformed pairs are rejected. Canonical JSON-file intake decodes
escaped pairs to Unicode scalar characters. This is an explicit denylist, not
proof against every possible invisible
Unicode string. Python and both default/Unicode-mode JavaScript regexes are
exercised by the cross-engine synthetic intake tests.

The four Python commands above are wired into the existing CI quality workflow
for future authorised integration; **no hosted CI was run or authorised for
this follow-up**. Successful metadata tests do not establish consent, listening,
verified ground truth, or permission to distribute any original recordings.

## Explicit outstanding gates

Draft [PR #154](https://github.com/matthewhand/audio.cpp-hub/pull/154) contains separate generated WAV fixtures derived from upstream recorded voices. Their *underlying voices' recording and redistribution rights are not independently verified*. Those files, their source-derived manifest and any unverified accuracy claims must **not** be merged, published or deployed. Keep #154 draft until written rights-clear provenance and independent listener-reviewed reference turns are obtained, or replace its media entirely with independently rights-cleared material.

The hub's registered Sortformer model / timeline UI is separate from the annotation validators. Live inference, timing accuracy, permissions and performance remain unverified and require separately approved deployment/QA under issues #136 and #128.
