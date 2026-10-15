#!/usr/bin/env python3
"""Metadata-only, fail-closed independent RTTM adjudication preflight.

Two independent, model-blind reviewers record half-open speech intervals in
integer milliseconds. An independent adjudicator explains every interval of
disagreement. Nothing here authenticates people, rights or audio, generates
RTTM/WAV, invokes inference, or certifies benchmark-quality ground truth.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
import stat
from pathlib import Path
import re

MAX_JSON = 128 * 1024
MAX_SEGMENTS = 256
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
CASES = {"silence_0spk", "solo_1spk", "overlap_2spk", "overlap_4spk"}
REASONS = {"boundary", "speaker_identity", "overlap", "speech_activity"}


# Import the committed rights-clear v2 schema checker WITHOUT invoking its
# separate WAV/source-opening validation path.
INTAKE_V2_PATH = Path(__file__).with_name("diarization_intake_v2.py")
INTAKE_SPEC = importlib.util.spec_from_file_location("diarization_intake_schema_only", INTAKE_V2_PATH)
INTAKE_MODULE = importlib.util.module_from_spec(INTAKE_SPEC)
INTAKE_SPEC.loader.exec_module(INTAKE_MODULE)


class AuditError(ValueError):
    pass


def require(test, message):
    if not test:
        raise AuditError(message)


def exact(obj, keys, where):
    require(type(obj) is dict and set(obj) == set(keys), where + ": invalid or missing fields")
    return obj


def identifier(text, where):
    require(type(text) is str and SAFE_ID.fullmatch(text) is not None, where + ": invalid evidence ID")
    return text


def sha(text, where):
    require(type(text) is str and SHA256.fullmatch(text) is not None, where + ": invalid SHA-256")


def unique_pairs(pairs):
    out = {}
    for key, value in pairs:
        require(key not in out, "Duplicate JSON key")
        out[key] = value
    return out


def read_json(path):
    """Bounded, immutable regular-file snapshot; reject symlink/FIFO targets."""
    require(hasattr(os, "O_NOFOLLOW"), "Secure metadata opening unsupported")
    flags = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise AuditError("Metadata file cannot be opened securely") from exc
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode), "Metadata must be a regular file")
        require(before.st_size <= MAX_JSON, "Metadata JSON exceeds size limit")
        with os.fdopen(os.dup(fd), "rb") as stream:
            data = stream.read(MAX_JSON + 1)
        after = os.fstat(fd)
        fingerprint = lambda x: (x.st_dev, x.st_ino, x.st_size, x.st_ctime_ns, x.st_mtime_ns)
        require(fingerprint(before) == fingerprint(after) and len(data) == before.st_size,
                "Metadata changed during read")
        require(len(data) <= MAX_JSON, "Metadata JSON exceeds size limit")
    finally:
        os.close(fd)
    try:
        return json.loads(
            data.decode("utf-8"), object_pairs_hook=unique_pairs,
            parse_constant=lambda _: (_ for _ in ()).throw(AuditError("Non-finite JSON value")),
        ), hashlib.sha256(data).hexdigest()
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise AuditError("Invalid UTF-8 JSON metadata") from exc


def millis(x, duration, where):
    require(type(x) is int and 0 <= x <= duration, where + ": integer milliseconds out of range")
    return x


def segments(rows, roster, duration, where):
    require(type(rows) is list and len(rows) <= MAX_SEGMENTS, where + ": too many segments")
    result = []
    previous = {}
    for i, item in enumerate(rows):
        loc = f"{where}[{i}]"
        exact(item, ("start_ms", "end_ms", "speaker_id"), loc)
        a = millis(item["start_ms"], duration, loc + ".start_ms")
        b = millis(item["end_ms"], duration, loc + ".end_ms")
        speaker = item["speaker_id"]
        require(a < b, loc + ": zero or negative segment")
        require(type(speaker) is str and speaker in roster, loc + ": speaker outside case roster")
        require((a, b, speaker) not in result, loc + ": duplicate segment")
        require(a >= previous.get(speaker, -1), loc + ": same-speaker intervals overlap or are unsorted")
        previous[speaker] = b
        result.append((a, b, speaker))
    require(result == sorted(result, key=lambda x: (x[0], x[1], x[2])),
            where + ": segments must be sorted by start, end, speaker")
    return result


def active(rows, at):
    return frozenset(s for a, b, s in rows if a <= at < b)


def disagreement_spans(first, second, final, duration):
    boundaries = sorted({0, duration, *(x for a, b, _ in first + second + final for x in (a, b))})
    disagreements = []
    overlap_ms = 0
    agreed_ms = 0
    for a, b in zip(boundaries, boundaries[1:]):
        left, right, done = (active(x, a) for x in (first, second, final))
        if len(done) >= 2:
            overlap_ms += b - a
        if left == right:
            require(done == left, f"Adjudication changed reviewer agreement at {a}-{b} ms")
            agreed_ms += b - a
        else:
            # Group consecutive differing slices; every group needs a
            # specific, human-referenced decision with exact boundaries.
            if disagreements and disagreements[-1][1] == a:
                disagreements[-1] = (disagreements[-1][0], b)
            else:
                disagreements.append((a, b))
    return disagreements, overlap_ms, agreed_ms


def validate(bundle, intake, intake_digest):
    exact(bundle, ("bundle_version", "fixture_set_id", "case_id", "rights_intake_sha256",
                   "recording_sha256", "rights_review_evidence_id", "reviewers", "adjudication"), "bundle")
    require(type(bundle["bundle_version"]) is int and bundle["bundle_version"] == 1,
            "Unsupported review bundle version")
    case = bundle["case_id"]
    require(type(case) is str and case in CASES, "Unknown case ID")
    identifier(bundle["fixture_set_id"], "fixture_set_id")
    sha(bundle["recording_sha256"], "recording_sha256")
    sha(bundle["rights_intake_sha256"], "rights_intake_sha256")
    require(bundle["rights_intake_sha256"] == intake_digest, "Pinned intake metadata digest mismatch")
    identifier(bundle["rights_review_evidence_id"], "rights_review_evidence_id")

    # Enforce the entire existing rights-clear v2 metadata schema without
    # validating/opening audio; its source-intake validator remains separate.
    try:
        schema = json.loads(INTAKE_MODULE.SCHEMA_FILE.read_text(encoding="utf-8"))
        INTAKE_MODULE._schema_check(intake, schema)
    except (INTAKE_MODULE.IntakeError, ValueError) as exc:
        raise AuditError("Rights intake v2 schema mismatch: " + str(exc)) from exc

    # Mirror the metadata-only cross-field requirements of intake v2.
    # Its full validate_intake() must not run here: that opens WAV files.
    rights_meta = intake["rights"]
    require(rights_meta["license_url"] ==
            INTAKE_MODULE.LICENSE_URLS[rights_meta["license_id"]],
            "Rights licence URL/identifier mismatch")
    sources = intake["sources"]
    require({entry["speaker_id"] for entry in sources} == INTAKE_MODULE.EXPECTED_IDS,
            "Intake must contain four distinct speakers")
    require(len({entry["sha256"] for entry in sources}) == 4,
            "Duplicate claimed source recording digest")
    require(len({entry["performer_release_evidence_id"] for entry in sources}) == 4,
            "Duplicate performer-release evidence ID")
    for case_name, (count, seconds, overlap) in INTAKE_MODULE.EXPECTED_CASES.items():
        spec_meta = intake["cases"][case_name]
        require(spec_meta["duration_seconds"] == seconds and
                len(spec_meta["speaker_ids"]) == count and
                spec_meta["overlap_required"] is overlap,
                "Case plan does not match rights intake v2 contract")
        if count == 4:
            require(set(spec_meta["speaker_ids"]) == INTAKE_MODULE.EXPECTED_IDS,
                    "Four-speaker roster must include all consented IDs")

    # The rights-clear source intake remains PENDING human annotation.
    # An adjudication bundle is a separate proposed review artifact.
    require(type(intake) is dict and intake.get("schema_version") == 2 and
            type(intake.get("fixture_set_id")) is str and
            intake["fixture_set_id"] == bundle["fixture_set_id"], "Rights intake ID/version mismatch")
    rights = intake.get("rights")
    require(type(rights) is dict and
            rights.get("rights_reviewer_evidence_id") == bundle["rights_review_evidence_id"] and
            rights.get("recording_redistribution_verified") is True and
            rights.get("derivative_mixing_verified") is True,
            "Rights intake claims or reviewer reference missing/mismatched")
    require(type(intake.get("human_annotation")) is dict and
            intake["human_annotation"].get("status") == "pending",
            "Intake must not claim human annotation completion")
    cases = intake.get("cases")
    require(type(cases) is dict and type(cases.get(case)) is dict, "Missing case in intake")
    spec = cases[case]
    duration_seconds = spec.get("duration_seconds")
    require(type(duration_seconds) in (int, float) and math.isfinite(duration_seconds) and
            0 < duration_seconds <= 120 and duration_seconds * 1000 == int(duration_seconds * 1000),
            "Invalid case duration")
    duration = int(duration_seconds * 1000)
    roster = spec.get("speaker_ids")
    require(type(roster) is list and all(type(s) is str and
            re.fullmatch(r"spk_0[1-4]", s) for s in roster) and
            len(roster) == len(set(roster)), "Invalid case roster")
    require(case != "silence_0spk" or len(roster) == 0, "Silence roster must be empty")

    reviewers = bundle["reviewers"]
    require(type(reviewers) is list and len(reviewers) == 2, "Exactly two independent reviewers required")
    reviewer_ids = set()
    reviewer_evidence = set()
    streams = []
    for n, reviewer in enumerate(reviewers):
        loc = f"reviewers[{n}]"
        exact(reviewer, ("reviewer_id", "review_evidence_id", "independent", "model_output_seen", "segments"), loc)
        rid = identifier(reviewer["reviewer_id"], loc + ".reviewer_id")
        evidence = identifier(reviewer["review_evidence_id"], loc + ".review_evidence_id")
        require(rid not in reviewer_ids and evidence not in reviewer_evidence,
                "Reviewer or evidence ID reused")
        require(reviewer["independent"] is True and reviewer["model_output_seen"] is False,
                "Review must be independent and blind to model predictions")
        reviewer_ids.add(rid)
        reviewer_evidence.add(evidence)
        streams.append(segments(reviewer["segments"], roster, duration, loc + ".segments"))

    adjudication = bundle["adjudication"]
    exact(adjudication, ("adjudicator_id", "review_evidence_id", "segments", "decisions"), "adjudication")
    adjudicator = identifier(adjudication["adjudicator_id"], "adjudicator_id")
    evidence = identifier(adjudication["review_evidence_id"], "adjudication evidence")
    require(adjudicator not in reviewer_ids and evidence not in reviewer_evidence,
            "Adjudicator must be independent of both reviewers")
    final = segments(adjudication["segments"], roster, duration, "adjudication.segments")
    spans, overlap_ms, agreed_ms = disagreement_spans(*streams, final, duration)
    require({speaker for _, _, speaker in final} == set(roster),
            "Final annotation must contain exactly the case speaker roster")
    if spec["overlap_required"]:
        require(overlap_ms > 0, "Required simultaneous-speech overlap missing from final review")
    decisions = adjudication["decisions"]
    require(type(decisions) is list and len(decisions) == len(spans),
            "Exactly one decision required for each disagreement span")
    decision_evidence = set()
    for i, (decision, span) in enumerate(zip(decisions, spans)):
        exact(decision, ("start_ms", "end_ms", "reason", "evidence_id"), f"decisions[{i}]")
        a = millis(decision["start_ms"], duration, "decision start")
        b = millis(decision["end_ms"], duration, "decision end")
        require((a, b) == span, "Decision boundaries must match detected disagreement spans")
        require(type(decision["reason"]) is str and decision["reason"] in REASONS,
                "Decision reason missing or unsupported")
        ev = identifier(decision["evidence_id"], "decision.evidence_id")
        require(ev not in decision_evidence and ev not in reviewer_evidence,
                "Decision evidence ID reused")
        decision_evidence.add(ev)

    return {
        "preflight": "metadata-consistency-only",
        "fixture_set_id": bundle["fixture_set_id"],
        "case_id": case,
        "independent_reviewers": 2,
        "disagreement_spans": len(spans),
        "disagreement_ms": sum(b - a for a, b in spans),
        "adjudicated_overlap_ms": overlap_ms,
        "agreed_ms": agreed_ms,
        "source_audio_opened": False,
        "human_rights_verified_by_tool": False,
        "human_identity_verified_by_tool": False,
        "publication_ready": False,
        "model_inference": False,
    }


def rttm_preview(case_id, rows):
    """Lossless millisecond-to-RTTM text preview, still NOT certified truth."""
    lines = ["# UNVERIFIED human review metadata; rights and identity not authenticated"]
    for start, end, speaker in rows:
        lines.append(
            f"SPEAKER {case_id} 1 {start / 1000:.3f} "
            f"{(end - start) / 1000:.3f} <NA> <NA> {speaker} <NA> <NA>"
        )
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, help="private, manually authored review metadata JSON")
    parser.add_argument("--intake-v2", required=True, help="pinned rights-clear v2 metadata JSON")
    parser.add_argument("--format", choices=("summary", "rttm"), default="summary",
                        help="stdout report or clearly unverified RTTM preview")
    args = parser.parse_args()
    try:
        bundle, _ = read_json(args.bundle)
        intake, digest = read_json(args.intake_v2)
        report = validate(bundle, intake, digest)
        if args.format == "rttm":
            roster = intake["cases"][bundle["case_id"]]["speaker_ids"]
            duration = int(intake["cases"][bundle["case_id"]]["duration_seconds"] * 1000)
            rows = segments(bundle["adjudication"]["segments"], roster, duration,
                            "adjudication.segments")
            print(rttm_preview(bundle["case_id"], rows), end="")
        else:
            print(json.dumps(report, sort_keys=True, indent=2))
    except (OSError, AuditError) as exc:
        parser.exit(1, f"Adjudication check failed: {exc}\n")


if __name__ == "__main__":
    main()
