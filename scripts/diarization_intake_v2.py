"""Fail-closed, read-only preflight for rights-clear diarization fixture intake v2.

This validates JSON against the committed constrained JSON Schema, checks
cross-file identities, safely inspects local WAV headers and SHA-256, and
checks asserted evidence references. It CANNOT authenticate legal consents.
It never records, converts, generates, downloads, or mixes audio.
"""
import hashlib
import io
import math
import os
import stat
import json
import pathlib
import re
import wave

SCHEMA_FILE = pathlib.Path(__file__).resolve().parents[1] / "test/fixtures/diarization/intake-v2.schema.json"
MAX_JSON_BYTES = 65536
MAX_WAV_BYTES = 16 * 1024 * 1024
SECURE_OPEN_SUPPORTED = (
    os.open in os.supports_dir_fd and
    hasattr(os, "O_NOFOLLOW") and hasattr(os, "O_DIRECTORY")
)
EXPECTED_IDS = {f"spk_0{i}" for i in range(1, 5)}
EXPECTED_CASES = {
    "silence_0spk": (0, 6, False),
    "solo_1spk": (1, 8.5, False),
    "overlap_2spk": (2, 12, True),
    "overlap_4spk": (4, 19, True),
}
SAFE_PATH = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*")
LICENSE_URLS = {
    "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/",
    "CC0-1.0": "https://creativecommons.org/publicdomain/zero/1.0/",
}


class IntakeError(ValueError):
    """Non-sensitive error message for metadata and audio-format failures."""


def _require(ok, msg):
    if not ok:
        raise IntakeError(msg)


def _unique_keys(pairs):
    obj = {}
    for key, value in pairs:
        _require(key not in obj, "Duplicate JSON key rejected")
        obj[key] = value
    return obj


def _load_json(path):
    path = pathlib.Path(path)
    _require(path.is_file(), "Manifest file is missing")
    _require(path.stat().st_size <= MAX_JSON_BYTES, "Manifest is too large")
    try:
        # Bound the actual read, not just a potentially stale stat() result.
        with path.open("rb") as stream:
            raw = stream.read(MAX_JSON_BYTES + 1)
        _require(len(raw) <= MAX_JSON_BYTES, "Manifest is too large")
        return json.loads(
            raw.decode("utf-8"), object_pairs_hook=_unique_keys,
            parse_constant=lambda _: (_ for _ in ()).throw(IntakeError("Non-finite JSON number rejected")),
        )
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise IntakeError("Invalid JSON manifest") from exc


def _schema_check(value, spec, location="$"):
    """Strict subset used by this schema; stdlib only, no pip requirements."""
    if "const" in spec:
        const = spec["const"]
        if type(const) in (int, float):
            # JSON Schema equates 6 and 6.0; Python bool is not a JSON number.
            ok = type(value) in (int, float) and math.isfinite(value) and value == const
        else:
            ok = type(value) is type(const) and value == const
        _require(ok, f"{location}: unexpected value")
    if "enum" in spec:
        _require(value in spec["enum"], f"{location}: unsupported value")
    typ = spec.get("type")
    if typ == "object":
        _require(type(value) is dict, f"{location}: expected object")
        required = spec.get("required", [])
        _require(all(k in value for k in required), f"{location}: required fields missing")
        props = spec.get("properties", {})
        if spec.get("additionalProperties") is False:
            _require(not (set(value) - set(props)), f"{location}: unrecognized field")
        for k, v in value.items():
            if k in props:
                _schema_check(v, props[k], f"{location}.{k}")
    elif typ == "array":
        _require(type(value) is list, f"{location}: expected array")
        _require(len(value) >= spec.get("minItems", 0), f"{location}: too few items")
        _require(len(value) <= spec.get("maxItems", float("inf")), f"{location}: too many items")
        if spec.get("uniqueItems"):
            _require(len({json.dumps(v, sort_keys=True) for v in value}) == len(value), f"{location}: duplicate items")
        for item in value:
            _schema_check(item, spec["items"], location + "[]")
    elif typ == "string":
        _require(type(value) is str, f"{location}: expected string")
        _require(len(value) >= spec.get("minLength", 0), f"{location}: string too short")
        _require(len(value) <= spec.get("maxLength", float("inf")), f"{location}: string too long")
        if "pattern" in spec:
            # JSON Schema regex "pattern" searches; unlike Python fullmatch it
            # does not implicitly anchor the expression.
            _require(re.search(spec["pattern"], value) is not None, f"{location}: invalid format")
    elif typ is not None:
        raise IntakeError(f"{location}: schema uses unsupported validation feature")


def _resolve_source(root, relative):
    _require(type(relative) is str and len(relative) <= 160, "Unsafe source path")
    _require(relative.endswith(".wav") and "\\" not in relative, "Source filename must be .wav")
    parts = relative.split("/")
    _require(all(p not in (".", "..") and SAFE_PATH.fullmatch(p) for p in parts), "Unsafe source path")
    parent = root
    for part in parts:
        parent = parent / part
        _require(not parent.is_symlink(), "Symlinked source path is prohibited")
    candidate = parent.resolve()
    _require(candidate.is_relative_to(root), "Source path escapes permitted root")
    _require(candidate.is_file(), "Source WAV is missing")
    _require(candidate.stat().st_size <= MAX_WAV_BYTES, "Source WAV exceeds size limit")
    return candidate


def _read_source_snapshot(root, relative):
    """A single bounded snapshot from one safely opened regular-file descriptor.

    POSIX openat with O_NOFOLLOW is intentionally required: unsupported
    platforms fail closed instead of falling back to a path-based open.
    """
    _require(SECURE_OPEN_SUPPORTED, "Secure source opening unsupported on this platform")
    names = relative.split("/")
    flags_dir = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    flags_file = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_CLOEXEC", 0)
    fds = []
    try:
        fd = os.open(root, flags_dir)
        fds.append(fd)
        for name in names[:-1]:
            fd = os.open(name, flags_dir, dir_fd=fd)
            fds.append(fd)
        fd = os.open(names[-1], flags_file, dir_fd=fd)
        fds.append(fd)
        before = os.fstat(fd)
        _require(stat.S_ISREG(before.st_mode), "Source must be a regular file")
        _require(before.st_size <= MAX_WAV_BYTES, "Source WAV exceeds size limit")
        # One snapshot ties format inspection and SHA-256 to exactly the
        # same bytes even if a directory entry changes after open().
        with os.fdopen(os.dup(fd), "rb") as source:
            snapshot = source.read(MAX_WAV_BYTES + 1)
        after = os.fstat(fd)
        fingerprint = lambda x: (x.st_dev, x.st_ino, x.st_size, x.st_mtime_ns, x.st_ctime_ns)
        _require(fingerprint(before) == fingerprint(after), "Source changed during inspection")
        _require(len(snapshot) <= MAX_WAV_BYTES, "Source WAV exceeds size limit")
        _require(len(snapshot) == before.st_size, "Source size changed during inspection")
        return snapshot
    except OSError as exc:
        raise IntakeError("Secure source open rejected: missing, symlinked, or inaccessible source") from exc
    finally:
        for fd in reversed(fds):
            os.close(fd)


def inspect_wav(snapshot):
    """Inspect an immutable bounded byte snapshot; no audio inference."""
    try:
        with wave.open(io.BytesIO(snapshot), "rb") as wav:
            _require(wav.getnchannels() == 1, "Source WAV must be mono")
            _require(wav.getframerate() == 16000, "Source WAV must be 16 kHz")
            _require(wav.getsampwidth() == 2 and wav.getcomptype() == "NONE", "Source WAV must be PCM signed 16-bit")
            frames = wav.getnframes()
            _require(3 * 16000 <= frames <= 120 * 16000, "Source WAV duration outside 3-120 seconds")
            # getnframes reads a *claimed* header count, not actual payload.
            # A truncated WAV must never pass merely by declaring 10s.
            _require(len(wav.readframes(frames)) == frames * 2, "Truncated WAV sample payload")
        return hashlib.sha256(snapshot).hexdigest(), frames
    except (wave.Error, EOFError, OSError) as exc:
        raise IntakeError("Source WAV header or file is invalid") from exc


def validate_intake(manifest, source_root, inspect_audio=None):
    """No audio writes. Does not prove consent documents or human annotations."""
    _schema_check(manifest, _load_json(SCHEMA_FILE))
    rights = manifest["rights"]
    _require(rights["license_url"] == LICENSE_URLS[rights["license_id"]], "License URL does not match license ID")
    source_root = pathlib.Path(source_root)
    _require(source_root.is_dir(), "Approved source root is not a directory")
    root = source_root.resolve(strict=True)
    checker = inspect_audio or inspect_wav
    ids = set()
    hashes = set()
    releases = set()
    for source in manifest["sources"]:
        speaker = source["speaker_id"]
        _require(speaker not in ids, "Duplicate speaker ID")
        ids.add(speaker)
        _require(source["performer_release_evidence_id"] not in releases, "Duplicate performer-release evidence ID")
        releases.add(source["performer_release_evidence_id"])
        candidate = _resolve_source(root, source["relative_wav_path"])
        if inspect_audio is None:
            actual_sha, frames = inspect_wav(_read_source_snapshot(root, source["relative_wav_path"]))
        else:
            # Injectable seam is only for synthetic metadata tests. Production
            # always uses a single anchored descriptor and immutable snapshot.
            actual_sha, frames = checker(candidate)
        _require(actual_sha == source["sha256"], f"Source {speaker}: checksum mismatch")
        _require(type(frames) is int and 3 * 16000 <= frames <= 120 * 16000, f"Source {speaker}: invalid sample duration")
        _require(actual_sha not in hashes, "Duplicate source recording detected")
        hashes.add(actual_sha)
    _require(ids == EXPECTED_IDS, "Four distinct speaker IDs spk_01..spk_04 are required")
    for case, (count, seconds, overlap) in EXPECTED_CASES.items():
        plan = manifest["cases"][case]
        _require(plan["duration_seconds"] == seconds, f"{case}: incorrect duration")
        _require(len(plan["speaker_ids"]) == count and set(plan["speaker_ids"]) <= ids, f"{case}: invalid speaker roster")
        _require(plan["overlap_required"] is overlap, f"{case}: incorrect overlap policy")
        if count == 4:
            _require(set(plan["speaker_ids"]) == ids, "4-speaker case must include all voices")
    # The human-annotation record is deliberately pending in intake v2.
    return {
        "schema_version": 2,
        "preflight": "metadata-and-local-audio-checks-passed",
        "sources_checked": 4,
        "cases_checked": 4,
        "rights_evidence": "references-present-not-authenticated",
        "human_annotation": "pending",
        "audio_generated": False,
    }


def validate_intake_file(manifest_path, source_root, inspect_audio=None):
    return validate_intake(_load_json(manifest_path), source_root, inspect_audio=inspect_audio)
