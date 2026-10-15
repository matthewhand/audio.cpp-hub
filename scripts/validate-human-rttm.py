#!/usr/bin/env python3
"""Read-only, independent QA of HUMAN adjudicated RTTM evidence.

No inference, model, audio synthesis, editing or downloading. Passing means
structural QA only, never authenticated consent or human listening.
"""
import argparse
import hashlib
import io
import json
import math
import os
import pathlib
import re
import stat
import wave
from collections import defaultdict
from decimal import Decimal, InvalidOperation, ROUND_HALF_EVEN

BASE = pathlib.Path(__file__).resolve().parents[1]
SCHEMA = BASE / "test/fixtures/diarization/human-rttm-completion-v1.schema.json"
INTAKE_SCHEMA = BASE / "test/fixtures/diarization/intake-v2.schema.json"
JSON_MAX = 65536
RTTM_MAX = 65536
WAV_MAX = 16 * 1024 * 1024
SAMPLE_RATE = 16000
CASE_SAMPLES = {"silence_0spk": 96000, "solo_1spk": 136000,
                "overlap_2spk": 192000, "overlap_4spk": 304000}
CASE_COUNTS = {"silence_0spk": 0, "solo_1spk": 1,
               "overlap_2spk": 2, "overlap_4spk": 4}
SUPPORTED = (os.open in os.supports_dir_fd and hasattr(os, "O_NOFOLLOW")
             and hasattr(os, "O_DIRECTORY"))
PART = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
SPEAKER = re.compile(r"^spk_0[1-4]$")
SHA = re.compile(r"^[0-9a-f]{64}$")
CATEGORIES = {"identity", "boundary", "speech_presence", "overlap", "other"}


class QAError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise QAError(message)


def unique_object(pairs):
    obj = {}
    for key, val in pairs:
        require(key not in obj, "Duplicate JSON key")
        obj[key] = val
    return obj


def json_data(raw, context):
    require(len(raw) <= JSON_MAX, f"{context}: exceeds JSON byte limit")
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object,
                          parse_constant=lambda value: (_ for _ in ()).throw(QAError("Nonfinite JSON value")))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise QAError(f"{context}: invalid JSON") from error


def read_manifest(path):
    """Read one consistent bounded, no-follow file snapshot."""
    require(SUPPORTED, "Secure manifest opening unsupported on this platform")
    flags = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(path, flags)
    except OSError as error:
        raise QAError("Manifest cannot be opened securely") from error
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode), "Manifest must be a regular file")
        require(before.st_size <= JSON_MAX, "Manifest exceeds JSON byte limit")
        with os.fdopen(os.dup(fd), "rb") as stream:
            raw = stream.read(JSON_MAX + 1)
        after = os.fstat(fd)
        footprint = lambda info: (info.st_dev, info.st_ino, info.st_size,
                                  info.st_mtime_ns, info.st_ctime_ns)
        require(footprint(before) == footprint(after) and len(raw) == before.st_size,
                "Manifest changed during read")
    finally:
        os.close(fd)
    return json_data(raw, "manifest"), hashlib.sha256(raw).hexdigest()


def schema_check(value, spec, loc="$"):
    """Explicitly limited JSON Schema subset; unknown keywords fail closed."""
    permitted = {"type","const","enum","required","properties","additionalProperties",
                 "items","minItems","maxItems","minLength","maxLength","pattern",
                 "uniqueItems","minimum","maximum","$schema","title"}
    require(not (set(spec) - permitted), f"{loc}: unsupported schema keyword")
    if "const" in spec:
        target = spec["const"]
        equal = (type(value) in (int, float) and math.isfinite(value) and value == target) \
            if type(target) in (int, float) else (type(value) is type(target) and value == target)
        require(equal, f"{loc}: unexpected constant")
    if "enum" in spec:
        require(any(type(value) is type(item) and value == item for item in spec["enum"]),
                f"{loc}: unsupported enum")
    typ = spec.get("type")
    if typ == "object":
        require(type(value) is dict, f"{loc}: object expected")
        require(all(k in value for k in spec.get("required", ())), f"{loc}: required fields missing")
        props = spec.get("properties", {})
        if spec.get("additionalProperties") is False:
            require(not (set(value) - set(props)), f"{loc}: unrecognized field")
        for k, v in value.items():
            if k in props:
                schema_check(v, props[k], f"{loc}.{k}")
    elif typ == "array":
        require(type(value) is list, f"{loc}: array expected")
        require(spec.get("minItems", 0) <= len(value) <= spec.get("maxItems", float("inf")),
                f"{loc}: array length")
        if spec.get("uniqueItems"):
            require(len({json.dumps(x, sort_keys=True) for x in value}) == len(value),
                    f"{loc}: duplicate array items")
        for item in value:
            schema_check(item, spec["items"], loc + "[]")
    elif typ == "string":
        require(type(value) is str, f"{loc}: string expected")
        require(spec.get("minLength", 0) <= len(value) <= spec.get("maxLength", float("inf")),
                f"{loc}: string length")
        if "pattern" in spec:
            require(re.search(spec["pattern"], value) is not None, f"{loc}: invalid string")
    elif typ == "integer":
        require(type(value) is int or
                (type(value) is float and math.isfinite(value) and value.is_integer()),
                f"{loc}: integer expected")
    elif typ is not None:
        raise QAError(f"{loc}: unsupported schema type")
    if "minimum" in spec:
        require(type(value) in (int, float) and value >= spec["minimum"], f"{loc}: below minimum")
    if "maximum" in spec:
        require(type(value) in (int, float) and value <= spec["maximum"], f"{loc}: above maximum")


def safe_parts(relative):
    require(type(relative) is str and len(relative) <= 160 and "\\" not in relative,
            "Unsafe artifact path")
    pieces = relative.split("/")
    require(bool(pieces) and all(p not in (".", "..") and PART.fullmatch(p) for p in pieces),
            "Unsafe artifact path")
    return pieces


def read_artifact(root, relative, limit):
    pieces = safe_parts(relative)
    require(SUPPORTED, "Secure artifact opening unsupported on this platform")
    directories = []
    flags_dir = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0)
    flags_file = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(root, flags_dir)
        directories.append(fd)
        for part in pieces[:-1]:
            fd = os.open(part, flags_dir, dir_fd=fd)
            directories.append(fd)
        fd = os.open(pieces[-1], flags_file, dir_fd=fd)
        directories.append(fd)
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode), "Artifact is not a regular file")
        require(before.st_size <= limit, "Artifact exceeds byte limit")
        with os.fdopen(os.dup(fd), "rb") as reader:
            snapshot = reader.read(limit + 1)
        after = os.fstat(fd)
        info = lambda v: (v.st_dev, v.st_ino, v.st_size, v.st_ctime_ns, v.st_mtime_ns)
        require(info(before) == info(after) and len(snapshot) == before.st_size,
                "Artifact changed during reading")
        require(len(snapshot) <= limit, "Artifact exceeds byte limit")
        return snapshot
    except OSError as error:
        raise QAError("Secure artifact open rejected") from error
    finally:
        for fd in reversed(directories):
            os.close(fd)


def audio_metadata(raw, case):
    try:
        with wave.open(io.BytesIO(raw), "rb") as wav:
            require((wav.getframerate(), wav.getnchannels(), wav.getsampwidth(), wav.getcomptype())
                    == (SAMPLE_RATE, 1, 2, "NONE"), "WAV format mismatch")
            frames = wav.getnframes()
            require(frames == CASE_SAMPLES[case], "WAV duration mismatch")
            samples = wav.readframes(frames)
            require(len(samples) == 2 * frames, "WAV truncated payload")
            if case == "silence_0spk":
                require(not any(samples), "Silence fixture contains nonzero samples")
        return frames
    except (wave.Error, EOFError, OSError) as error:
        raise QAError("Invalid WAV structure") from error


def _sample(token, context):
    try:
        number = Decimal(token)
        require(number.is_finite() and 0 <= number <= 120,
                f"{context}: invalid timestamp")
        sample = number * SAMPLE_RATE
        rounded = int(sample.to_integral_value(rounding=ROUND_HALF_EVEN))
        # Accept standard six-decimal RTTM export: rounding error <=0.008 samples.
        require(abs(sample - rounded) <= Decimal("0.01"), f"{context}: not sample aligned")
        return rounded
    except (InvalidOperation, OverflowError) as error:
        raise QAError(f"{context}: invalid timestamp") from error


def parse_rttm(raw, case, duration, allowed):
    require(len(raw) <= RTTM_MAX, "RTTM too large")
    try:
        text = raw.decode("utf-8")
    except UnicodeError as error:
        raise QAError("RTTM not UTF-8") from error
    if case == "silence_0spk":
        require(not raw, "Silence RTTM must be zero bytes")
        return []
    rows = []
    for line in text.splitlines():
        require(len(rows) < 512, "RTTM segment count exceeded")
        require(line.strip() and not line.startswith("#"), "Unexpected blank or commented RTTM row")
        x = line.split()
        require(len(x) == 10 and x[0] == "SPEAKER" and x[1] == case and x[2] == "1",
                "Invalid RTTM record or channel")
        require([x[i] for i in (5, 6, 8, 9)] == ["<NA>"] * 4, "Invalid RTTM placeholder")
        require(SPEAKER.fullmatch(x[7]) is not None and x[7] in allowed, "Unapproved speaker")
        start = _sample(x[3], "start")
        span = _sample(x[4], "duration")
        require(span > 0 and start + span <= duration, "RTTM interval outside clip")
        rows.append((start, start + span, x[7]))
    require(rows == sorted(rows), "RTTM rows not in canonical order")
    by_speaker = defaultdict(list)
    for start, end, spk in rows:
        if by_speaker[spk]:
            require(by_speaker[spk][-1] <= start, "Same-speaker self overlap")
        by_speaker[spk].append(end)
    return rows


def overlap_samples(rows):
    events = defaultdict(list)
    for a, b, s in rows:
        events[a].append((s, 1))
        events[b].append((s, -1))
    active = set()
    last = None
    total = 0
    for t in sorted(events):
        if last is not None and len(active) >= 2:
            total += t - last
        for speaker, direction in sorted(events[t], key=lambda e: e[1]):
            if direction < 0:
                active.discard(speaker)
            else:
                active.add(speaker)
        last = t
    return total


def disagreements(a, b, duration):
    """Contiguous sample ranges where reviewer speaker-activity sets differ."""
    events = defaultdict(lambda: [[], []])
    for index, rows in enumerate((a, b)):
        for start, end, speaker in rows:
            events[start][index].append((speaker, 1))
            events[end][index].append((speaker, -1))
    active = [set(), set()]
    regions = []
    times = sorted(set(events) | {0, duration})
    for index, t in enumerate(times[:-1]):
        for source in (0, 1):
            for speaker, sign in sorted(events[t][source], key=lambda z: z[1]):
                if sign < 0:
                    active[source].discard(speaker)
                else:
                    active[source].add(speaker)
        nxt = times[index + 1]
        if active[0] != active[1] and t < nxt:
            if regions and regions[-1][1] == t:
                regions[-1] = (regions[-1][0], nxt)
            else:
                regions.append((t, nxt))
    return regions


def validate_decisions(raw, case, adjudicator, duration):
    val = json_data(raw, "adjudication log")
    require(type(val) is dict and set(val) == {"schema_version", "case_id", "decisions"},
            "Adjudication log fields invalid")
    require(type(val["schema_version"]) is int and val["schema_version"] == 1
            and val["case_id"] == case and type(val["decisions"]) is list,
            "Adjudication log header invalid")
    require(len(val["decisions"]) <= 512, "Too many decisions")
    ids = set()
    spans = []
    for row in val["decisions"]:
        require(type(row) is dict and set(row) ==
                {"dispute_id", "start_sample", "end_sample", "category", "status", "rationale", "adjudicator_id"},
                "Decision fields invalid")
        ident = row["dispute_id"]
        require(type(ident) is str and PART.fullmatch(ident) and ident not in ids,
                "Duplicate or invalid dispute ID")
        ids.add(ident)
        start, end = row["start_sample"], row["end_sample"]
        require(type(start) is int and type(end) is int and 0 <= start < end <= duration,
                "Invalid decision interval")
        require(type(row["category"]) is str and row["category"] in CATEGORIES
                and row["status"] == "resolved" and row["adjudicator_id"] == adjudicator,
                "Unresolved or unauthorized decision")
        require(type(row["rationale"]) is str and 8 <= len(row["rationale"]) <= 400
                and row["rationale"].strip(), "Missing decision rationale")
        spans.append((start, end))
    return spans


def covered(region, spans):
    end = region[0]
    for a, b in sorted(spans):
        if a <= end < b:
            end = b
        if end >= region[1]:
            return True
    return False


def validate(completion, intake, intake_hash, read_asset, inspect_audio=None):
    schema_check(completion, json_data(SCHEMA.read_bytes(), "completion schema"))
    schema_check(intake, json_data(INTAKE_SCHEMA.read_bytes(), "intake schema"))
    require(completion["intake"]["manifest_sha256"] == intake_hash, "Intake SHA-256 mismatch")
    require(completion["fixture_set_id"] == intake["fixture_set_id"], "Fixture set ID mismatch")
    require(completion["intake"]["rights_evidence_id"] == intake["rights"]["rights_reviewer_evidence_id"],
            "Rights evidence reference mismatch")
    require(intake["human_annotation"]["status"] == "pending", "Original intake must remain pending")
    licenses = {"CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/",
                "CC0-1.0": "https://creativecommons.org/publicdomain/zero/1.0/"}
    require(intake["rights"]["license_url"] == licenses[intake["rights"]["license_id"]],
            "Intake licence ID/URL mismatch")
    ids = [completion["reviewers"][role]["reviewer_id"] for role in ("a", "b", "adjudicator", "qa")]
    require(len(set(ids)) == 4, "Reviewers, adjudicator and QA must be distinct")
    source_ids = {source["speaker_id"] for source in intake["sources"]}
    require(source_ids == {"spk_01", "spk_02", "spk_03", "spk_04"}, "Source roster incorrect")
    all_paths = set()
    disputes = 0
    for case, count in CASE_COUNTS.items():
        spec = completion["cases"][case]
        expected = set(intake["cases"][case]["speaker_ids"])
        approved = set(spec["speaker_ids"])
        require(len(spec["speaker_ids"]) == count and approved == expected, f"{case}: wrong roster")
        audio = spec["audio"]
        entries = [
            ("audio", audio, WAV_MAX),
            ("reviewer A", spec["reviewer_a"]["rttm"], RTTM_MAX),
            ("reviewer B", spec["reviewer_b"]["rttm"], RTTM_MAX),
            ("adjudicated", spec["adjudicated_rttm"], RTTM_MAX),
            ("adjudication log", spec["adjudication_log"], JSON_MAX),
        ]
        bytes_by_role = {}
        for label, artifact, limit in entries:
            path = artifact["relative_path"]
            safe_parts(path)
            require(path not in all_paths, "Artifact path reused")
            all_paths.add(path)
            raw = read_asset(path, limit)
            require(type(raw) is bytes and len(raw) <= limit, "Invalid artifact contents")
            require(hashlib.sha256(raw).hexdigest() == artifact["sha256"],
                    f"{case}: {label} SHA-256 mismatch")
            bytes_by_role[label] = raw
        frames = (inspect_audio or audio_metadata)(bytes_by_role["audio"], case)
        require(frames == CASE_SAMPLES[case], f"{case}: audio duration mismatch")
        a = parse_rttm(bytes_by_role["reviewer A"], case, frames, source_ids)
        b = parse_rttm(bytes_by_role["reviewer B"], case, frames, source_ids)
        final = parse_rttm(bytes_by_role["adjudicated"], case, frames, approved)
        require({row[2] for row in final} == approved, f"{case}: missing final speaker")
        if count >= 2:
            require(overlap_samples(final) >= 3200, f"{case}: insufficient overlap")
        else:
            require(overlap_samples(final) == 0, f"{case}: unexpected overlap")
        mismatches = disagreements(a, b, frames)
        decisions = validate_decisions(bytes_by_role["adjudication log"], case, ids[2], frames)
        all_changes = (mismatches + disagreements(a, final, frames)
                       + disagreements(b, final, frames))
        require(all(covered(region, decisions) for region in all_changes),
                f"{case}: unadjudicated reviewer/final disagreement")
        summary = spec["review_summary"]
        require(summary["disagreement_regions"] == len(mismatches)
                and summary["recorded_disputes"] == len(decisions)
                and summary["unresolved_disputes"] == 0,
                f"{case}: review summary inconsistent")
        disputes += len(decisions)
    return {
        "status": "technical_qa_passed",
        "schema_version": 1,
        "cases_validated": 4,
        "independent_reviewer_ids": 2,
        "adjudication_decisions": disputes,
        "unresolved_disputes": 0,
        "provenance_hashes_match": True,
        "human_attestations_authenticated": False,
        "redistribution_authorized": False,
        "release_authorized": False,
    }


def main():
    parser = argparse.ArgumentParser(description="Read-only technical QA; never verifies legal consents")
    parser.add_argument("--completion", type=pathlib.Path, required=True)
    parser.add_argument("--intake", type=pathlib.Path, required=True)
    parser.add_argument("--artifact-root", type=pathlib.Path, required=True)
    args = parser.parse_args()
    completion, _ = read_manifest(args.completion)
    intake, intake_hash = read_manifest(args.intake)
    require(args.artifact_root.is_dir(), "Artifact root does not exist")
    report = validate(completion, intake, intake_hash,
                      lambda relative, size: read_artifact(args.artifact_root, relative, size))
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, QAError, ValueError) as error:
        raise SystemExit(f"Human RTTM QA failed: {error}") from None
