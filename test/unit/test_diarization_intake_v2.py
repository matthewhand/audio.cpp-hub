"""Synthetic metadata-only intake tests; no audio recording or synthesis."""
import copy
import importlib.util
import hashlib
import os
import stat
import struct
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
MODULE = ROOT / "scripts" / "diarization_intake_v2.py"
SPEC = importlib.util.spec_from_file_location("diarization_intake_v2", MODULE)
intake = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(intake)

IDS = [f"spk_0{i}" for i in range(1, 5)]


def draft():
    return {
        "schema_version": 2,
        "fixture_set_id": "human-voices-v1",
        "rights": {
            "license_id": "CC-BY-4.0",
            "license_url": "https://creativecommons.org/licenses/by/4.0/",
            "public_attribution": "Rights and attribution to be independently reviewed",
            "recording_redistribution_verified": True,
            "derivative_mixing_verified": True,
            "rights_reviewer_evidence_id": "REVIEW-0001",
        },
        "sources": [
            {
                "speaker_id": speaker,
                "relative_wav_path": f"{speaker}.wav",
                "recording_type": "original-human-recording",
                "recording_origin_evidence_id": f"ORIGIN-{i:04d}",
                "sha256": f"{i:064x}",
                "recording_rights_evidence_id": f"RIGHTS-{i:04d}",
                "performer_release_evidence_id": f"CONSENT-{i:04d}",
                "recording_rights_verified": True,
                "performer_release_verified": True,
            }
            for i, speaker in enumerate(IDS, start=1)
        ],
        "cases": {
            "silence_0spk": {"duration_seconds": 6, "speaker_ids": [], "overlap_required": False},
            "solo_1spk": {"duration_seconds": 8.5, "speaker_ids": IDS[:1], "overlap_required": False},
            "overlap_2spk": {"duration_seconds": 12, "speaker_ids": IDS[:2], "overlap_required": True},
            "overlap_4spk": {"duration_seconds": 19, "speaker_ids": IDS, "overlap_required": True},
        },
        "human_annotation": {
            "status": "pending",
            "independent_annotators": [],
            "speaker_identity_verified": False,
            "speech_boundaries_adjudicated": False,
        },
    }


class IntakeOnlyValidation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.data = draft()
        # Zero-byte SENTINELS ONLY, not WAV files or synthesized audio.
        for source in self.data["sources"]:
            (self.root / source["relative_wav_path"]).touch()

    def validate(self, data=None):
        data = data if data is not None else self.data
        sha = {source["relative_wav_path"]: source["sha256"] for source in data["sources"]}
        return intake.validate_intake(
            data, self.root,
            inspect_audio=lambda path: (sha[path.relative_to(self.root).as_posix()], 10 * 16000),
        )

    def test_valid_attested_intake_does_not_claim_legal_or_human_verification(self):
        outcome = self.validate()
        self.assertEqual(outcome["sources_checked"], 4)
        self.assertEqual(outcome["cases_checked"], 4)
        self.assertEqual(outcome["human_annotation"], "pending")
        self.assertEqual(outcome["rights_evidence"], "references-present-not-authenticated")
        self.assertFalse(outcome["audio_generated"])

    def test_no_fixtures_were_generated_by_validation(self):
        before = sorted(p.name for p in self.root.iterdir())
        self.validate()
        self.assertEqual(before, sorted(p.name for p in self.root.iterdir()))

    def test_missing_recording_rights_rejected(self):
        self.data["rights"]["recording_redistribution_verified"] = False
        with self.assertRaisesRegex(intake.IntakeError, "unexpected value"):
            self.validate()

    def test_missing_performer_release_rejected(self):
        self.data["sources"][1]["performer_release_verified"] = False
        with self.assertRaisesRegex(intake.IntakeError, "unexpected value"):
            self.validate()

    def test_unverified_derivative_mixing_rejected(self):
        self.data["rights"]["derivative_mixing_verified"] = False
        with self.assertRaises(intake.IntakeError):
            self.validate()

    def test_empty_evidence_id_rejected(self):
        self.data["sources"][0]["performer_release_evidence_id"] = ""
        with self.assertRaisesRegex(intake.IntakeError, "invalid format"):
            self.validate()

    def test_unapproved_pii_field_rejected(self):
        self.data["sources"][0]["performer_email"] = "personal@example.invalid"
        with self.assertRaisesRegex(intake.IntakeError, "unrecognized field"):
            self.validate()

    def test_license_url_mismatch_rejected(self):
        self.data["rights"]["license_id"] = "CC0-1.0"
        with self.assertRaisesRegex(intake.IntakeError, "License URL"):
            self.validate()

    def test_nonhuman_or_unattributed_source_origin_rejected(self):
        self.data["sources"][0]["recording_type"] = "unverified-generated-voice"
        with self.assertRaisesRegex(intake.IntakeError, "unexpected value"):
            self.validate()
        self.data["sources"][0]["recording_type"] = "original-human-recording"
        self.data["sources"][0]["recording_origin_evidence_id"] = ""
        with self.assertRaisesRegex(intake.IntakeError, "invalid format"):
            self.validate()

    def test_duplicate_speaker_ids_rejected(self):
        self.data["sources"][1]["speaker_id"] = "spk_01"
        with self.assertRaisesRegex(intake.IntakeError, "Duplicate speaker"):
            self.validate()

    def test_duplicate_release_evidence_rejected(self):
        self.data["sources"][1]["performer_release_evidence_id"] = self.data["sources"][0]["performer_release_evidence_id"]
        with self.assertRaisesRegex(intake.IntakeError, "Duplicate performer"):
            self.validate()

    def test_duplicate_recording_hash_rejected(self):
        self.data["sources"][1]["sha256"] = self.data["sources"][0]["sha256"]
        with self.assertRaisesRegex(intake.IntakeError, "Duplicate source recording"):
            self.validate()

    def test_hash_mismatch_rejected(self):
        with self.assertRaisesRegex(intake.IntakeError, "checksum mismatch"):
            intake.validate_intake(self.data, self.root, inspect_audio=lambda path: ("0" * 64, 160000))

    def test_missing_source_rejected(self):
        (self.root / "spk_02.wav").unlink()
        with self.assertRaisesRegex(intake.IntakeError, "Source WAV is missing"):
            self.validate()

    def test_relative_parent_traversal_rejected(self):
        self.data["sources"][0]["relative_wav_path"] = "../outside.wav"
        with self.assertRaisesRegex(intake.IntakeError, "relative_wav_path: invalid format"):
            self.validate()

    def test_absolute_path_rejected(self):
        self.data["sources"][0]["relative_wav_path"] = "/tmp/elsewhere.wav"
        with self.assertRaisesRegex(intake.IntakeError, "relative_wav_path: invalid format"):
            self.validate()

    def test_symlinked_source_rejected(self):
        (self.root / "spk_02.wav").unlink()
        (self.root / "spk_02.wav").symlink_to(self.root / "spk_01.wav")
        with self.assertRaisesRegex(intake.IntakeError, "Symlinked source path"):
            self.validate()

    def test_wrong_4_speaker_roster_rejected(self):
        self.data["cases"]["overlap_4spk"]["speaker_ids"] = ["spk_01", "spk_02", "spk_03", "spk_03"]
        with self.assertRaisesRegex(intake.IntakeError, "duplicate items"):
            self.validate()

    def test_forged_human_review_completion_rejected_in_intake(self):
        self.data["human_annotation"]["speaker_identity_verified"] = True
        with self.assertRaisesRegex(intake.IntakeError, "unexpected value"):
            self.validate()

    def test_wrong_wav_format_and_empty_placeholder_fails_real_inspection(self):
        with self.assertRaisesRegex(intake.IntakeError, "WAV header or file is invalid"):
            self.validate_real()

    def validate_real(self):
        return intake.validate_intake(self.data, self.root)

    def test_duplicate_json_keys_rejected(self):
        item = self.root / "dup.json"
        item.write_text('{"schema_version":2,"schema_version":2}', encoding="utf-8")
        with self.assertRaisesRegex(intake.IntakeError, "Duplicate JSON key"):
            intake.validate_intake_file(item, self.root)

    def test_standalone_schema_rejects_unsafe_relative_wav_paths(self):
        schema = json.loads(intake.SCHEMA_FILE.read_text())
        for path in (
            "../outside.wav", "/tmp/voice.wav", "folder/../voice.wav",
            "folder/./voice.wav", "voice\\outside.wav", "a//voice.wav",
            "a/voice.mp3", ".private.wav", "name with spaces.wav",
            "folder/voice.wav/..",
        ):
            with self.subTest(path=path):
                data = draft()
                data["sources"][0]["relative_wav_path"] = path
                with self.assertRaisesRegex(intake.IntakeError, "invalid format"):
                    intake._schema_check(data, schema)

    def test_standalone_schema_rejects_terminal_newline_after_wav_suffix(self):
        schema = json.loads(intake.SCHEMA_FILE.read_text())
        for path in ("spk_01.wav\n", "sessions/spk_01.wav\n"):
            with self.subTest(path=repr(path)):
                data = draft()
                data["sources"][0]["relative_wav_path"] = path
                with self.assertRaisesRegex(intake.IntakeError, "invalid format"):
                    intake._schema_check(data, schema)

    def test_standalone_schema_accepts_valid_nested_relative_wav_path(self):
        schema = json.loads(intake.SCHEMA_FILE.read_text())
        self.data["sources"][0]["relative_wav_path"] = "sessions/day_1/spk_01.wav"
        intake._schema_check(self.data, schema)
        nested = self.root / "sessions" / "day_1"
        nested.mkdir(parents=True)
        (nested / "spk_01.wav").touch()
        self.assertEqual(self.validate()["sources_checked"], 4)

    def test_manifest_symlink_target_rejected(self):
        source = self.root / "actual.json"
        source.write_text('{"ok":true}')
        alias = self.root / "alias.json"
        alias.symlink_to(source)
        with self.assertRaisesRegex(intake.IntakeError, "opened securely"):
            intake._load_json(alias)

    def test_manifest_symlink_parent_rejected(self):
        directory = self.root / "original"
        directory.mkdir()
        (directory / "intake.json").write_text('{"ok":true}')
        alias = self.root / "linked"
        alias.symlink_to(directory, target_is_directory=True)
        with self.assertRaisesRegex(intake.IntakeError, "opened securely"):
            intake._load_json(alias / "intake.json")

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO only available on POSIX")
    def test_manifest_fifo_rejected_without_blocking(self):
        fifo = self.root / "input.fifo"
        os.mkfifo(fifo)
        with self.assertRaisesRegex(intake.IntakeError, "regular file"):
            intake._load_json(fifo)

    def test_manifest_missing_file_rejected(self):
        with self.assertRaisesRegex(intake.IntakeError, "opened securely"):
            intake._load_json(self.root / "missing.json")

    def test_manifest_oversized_file_rejected(self):
        item = self.root / "large.json"
        item.write_bytes(b"x" * (intake.MAX_JSON_BYTES + 1))
        with self.assertRaisesRegex(intake.IntakeError, "too large"):
            intake._load_json(item)

    def test_manifest_exact_size_limit_accepted(self):
        item = self.root / "limit.json"
        data = b'{"ok": true}'
        item.write_bytes(data + b" " * (intake.MAX_JSON_BYTES - len(data)))
        self.assertEqual(intake._load_json(item), {"ok": True})

    def test_manifest_swap_after_open_uses_original_descriptor(self):
        source = self.root / "swapped.json"
        source.write_text('{"version": "original"}')
        alternate = self.root / "alternate.json"
        alternate.write_text('{"version": "replacement"}')
        original_open = os.open
        replaced = [False]

        def swap_after_open(path, flags, *args, **kwargs):
            fd = original_open(path, flags, *args, **kwargs)
            if path == "swapped.json" and not replaced[0]:
                replaced[0] = True
                source.unlink()
                source.symlink_to(alternate)
            return fd

        with mock.patch.object(intake.os, "open", side_effect=swap_after_open):
            self.assertEqual(intake._load_json(source), {"version": "original"})
        self.assertTrue(replaced[0])
        with self.assertRaisesRegex(intake.IntakeError, "opened securely"):
            intake._load_json(source)

    def test_manifest_mutation_during_read_rejected(self):
        source = self.root / "mutated.json"
        source.write_text('{"content": 1}')
        original_fstat = os.fstat
        mutated = [False]

        def mutate_after_initial_fstat(fd):
            status = original_fstat(fd)
            if stat.S_ISREG(status.st_mode) and not mutated[0]:
                mutated[0] = True
                source.write_text('{"content": 11111111111}')
            return status

        with mock.patch.object(intake.os, "fstat", side_effect=mutate_after_initial_fstat):
            with self.assertRaisesRegex(intake.IntakeError, "changed during inspection"):
                intake._load_json(source)
        self.assertTrue(mutated[0])

    def test_builder_v2_rejects_output_and_never_creates_a_target_directory(self):
        manifest = self.root / "source.json"
        manifest.write_text(json.dumps(self.data), encoding="utf-8")
        output = self.root / "must-not-be-created"
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts" / "build-diarization-fixtures.py"),
                "--validate-intake", str(manifest),
                "--source-root", str(self.root),
                "--output", str(output),
            ],
            capture_output=True, text=True, timeout=5,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("forbids --output", result.stderr)
        self.assertFalse(output.exists())

    def test_builder_v2_accepts_no_v1_source_or_legacy_build(self):
        manifest = self.root / "source.json"
        manifest.write_text(json.dumps(self.data), encoding="utf-8")
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts" / "build-diarization-fixtures.py"),
                "--validate-intake", str(manifest),
                "--source", "anything.wav",
                "--source-root", str(self.root),
            ],
            capture_output=True, text=True, timeout=5,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not allowed with argument", result.stderr)

    def test_header_only_wav_claiming_three_seconds_fails_closed(self):
        # A 44-byte synthetically packed RIFF header, not generated audio.
        size = 3 * 16000 * 2
        fmt = struct.pack("<HHIIHH", 1, 1, 16000, 32000, 2, 16)
        header = (b"RIFF" + struct.pack("<I", 36 + size)
                  + b"WAVEfmt " + struct.pack("<I", 16) + fmt
                  + b"data" + struct.pack("<I", size))
        self.assertEqual(len(header), 44)
        with self.assertRaisesRegex(intake.IntakeError, "Truncated WAV sample payload"):
            intake.inspect_wav(header)

    def test_full_synthetic_in_memory_pcm_structure_passes(self):
        # Synthetic zero samples exist only in memory for structural testing.
        count = 3 * 16000
        size = count * 2
        fmt = struct.pack("<HHIIHH", 1, 1, 16000, 32000, 2, 16)
        header = (b"RIFF" + struct.pack("<I", 36 + size)
                  + b"WAVEfmt " + struct.pack("<I", 16) + fmt
                  + b"data" + struct.pack("<I", size))
        blob = header + bytes(size)
        sha, frames = intake.inspect_wav(blob)
        self.assertEqual(frames, count)
        self.assertEqual(sha, hashlib.sha256(blob).hexdigest())

    def test_directory_swap_after_fd_open_keeps_original_snapshot(self):
        # Only ordinary text sentinels are used; no WAV files are generated.
        original = self.root / "spk_01.wav"
        original.write_bytes(b"original-content")
        unrelated = self.root / "unrelated.bin"
        unrelated.write_bytes(b"wrong-content")
        old_open = os.open
        replaced = [False]

        def swap_after_open(path, flags, *args, **kwargs):
            fd = old_open(path, flags, *args, **kwargs)
            if path == "spk_01.wav" and not replaced[0]:
                replaced[0] = True
                original.unlink()
                original.symlink_to(unrelated)
            return fd

        with mock.patch.object(intake.os, "open", side_effect=swap_after_open):
            data = intake._read_source_snapshot(self.root, "spk_01.wav")
        self.assertTrue(replaced[0])
        self.assertEqual(data, b"original-content")
        with self.assertRaisesRegex(intake.IntakeError, "Secure source open rejected"):
            intake._read_source_snapshot(self.root, "spk_01.wav")

    def test_nested_symlink_denied_by_secure_open(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "voice.wav").touch()
        (self.root / "nested").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(intake.IntakeError, "Secure source open rejected"):
            intake._read_source_snapshot(self.root, "nested/voice.wav")

    def test_blank_public_attribution_rejected_and_padded_real_name_accepted(self):
        self.data["rights"]["public_attribution"] = "   "
        with self.assertRaisesRegex(intake.IntakeError, "invalid format"):
            self.validate()
        self.data["rights"]["public_attribution"] = "  Public rights holder  "
        self.assertEqual(self.validate()["sources_checked"], 4)

    def test_json_schema_numeric_const_consistency_not_bool(self):
        self.data["cases"]["silence_0spk"]["duration_seconds"] = 6.0
        self.data["schema_version"] = 2.0
        self.assertEqual(self.validate()["schema_version"], 2)
        self.data["schema_version"] = True
        with self.assertRaisesRegex(intake.IntakeError, "unexpected value"):
            self.validate()

    def test_nonstandard_nan_json_is_rejected(self):
        malformed = self.root / "nan.json"
        malformed.write_text('{"schema_version": NaN}', encoding="utf-8")
        with self.assertRaisesRegex(intake.IntakeError, "Non-finite JSON number"):
            intake.validate_intake_file(malformed, self.root)

    def test_invisible_only_attribution_rejected_in_full_preflight(self):
        for hidden in ("\u00ad", "\u034f", "\ufe0f",
                       "\U000E0001", "\U000E0020",
                       "\U000E0100", "\u2800"):
            with self.subTest(hidden=repr(hidden)):
                self.data["rights"]["public_attribution"] = hidden * 3
                with self.assertRaisesRegex(intake.IntakeError, "invalid format"):
                    self.validate()
        for visible in ("Jos\u00e9 Garc\u00eda",
                        "\u5c71\u7530\u592a\u90ce",
                        "\U00020BB7\u91ce\u82b1"):
            with self.subTest(visible=repr(visible)):
                self.data["rights"]["public_attribution"] = visible
                self.assertEqual(self.validate()["sources_checked"], 4)

    def test_javascript_python_metadata_regex_parity(self):
        schema = json.loads(intake.SCHEMA_FILE.read_text())
        def fields(node, path=()):
            if isinstance(node, dict):
                if "pattern" in node:
                    yield path, node
                for key, value in node.items():
                    yield from fields(value, path + (key,))
            elif isinstance(node, list):
                for i, value in enumerate(node):
                    yield from fields(value, path + (str(i),))
        vectors = []
        for path, spec in fields(schema):
            name = ".".join(path)
            if "speaker_id" in name:
                valid = "spk_01"
            elif "relative_wav_path" in name:
                valid = "folder/voice.wav"
            elif "sha256" in name:
                valid = "a" * 64
            elif "public_attribution" in name:
                valid = "Jane Doe"
            else:
                valid = "ABC-123"
            cases = [(valid, True)]
            if "public_attribution" in name:
                cases += [(x, True) for x in ("山田 太郎", "José García", "Jane\u00a0Doe")]
                cases += [(x * 3, False) for x in (
                    " ", "\u0085", "\ufeff", "\u00a0", "\u1680",
                    "\u180e", "\u2000", "\u200a", "\u200b", "\u200d",
                    "\u200f", "\u2028", "\u2029", "\u202f", "\u205f",
                    "\u2060", "\u3000", "\u001c", "\x00",
                )]
                # Invisible-only text must not satisfy rights attribution.
                cases += [(x * 3, False) for x in (
                    "\u00ad", "\u034f", "\ufe0f", "\u115f", "\u1160",
                    "\u3164", "\uffa0", "\U000E0001", "\U000E0020",
                    "\U000E007F", "\U000E007E",
                    "\U000E0100", "\U000E01EF", "\u2800",
                )]
                cases += [("  \u00ad  \u034f", False),
                          ("  \u00ad\U000E0001\ufe0f\u034f", False)]
                cases += [(x, True) for x in (
                    "Jos\u00e9 \u00ad Garc\u00eda",
                    "Jane \U000E0001 Doe",
                    "\u5409\u91ce\u82b1", "\U00020BB7\u91ce\u82b1",
                    "\u0928\u093e\u092e", "\u0623\u062d\u0645\u062f",
                )]
                cases += [("AB", False)]
            else:
                cases += [(valid + x, False) for x in ("\n", "\r", "\u2028", "\u2029", "\ufeff", "\u0085")]
            for val, expected in cases:
                vectors.append({"path": name, "spec": spec, "val": val, "expected": expected})
        script = """const fs=require('node:fs');
const cases=JSON.parse(fs.readFileSync(0,'utf8'));
process.stdout.write(JSON.stringify(cases.map(({spec,val})=>{
  const withinBounds = [...val].length >= (spec.minLength ?? 0) &&
    [...val].length <= (spec.maxLength ?? Infinity);
  return [new RegExp(spec.pattern).test(val),
    new RegExp(spec.pattern, "u").test(val)].map(matches=>withinBounds && matches);
})));"""
        results = subprocess.run(["node", "-e", script], input=json.dumps(vectors),
                                 capture_output=True, text=True, check=True, timeout=5)
        javascript = json.loads(results.stdout)
        self.assertEqual(len(vectors), len(javascript))
        for case, js_modes in zip(vectors, javascript):
            try:
                intake._schema_check(case["val"], case["spec"])
                py_ok = True
            except intake.IntakeError:
                py_ok = False
            with self.subTest(field=case["path"], value=repr(case["val"])):
                self.assertEqual(len(js_modes), 2)
                self.assertEqual(js_modes[0], js_modes[1], "JS default versus Unicode-mode mismatch")
                self.assertEqual(py_ok, js_modes[0], "Python/JavaScript mismatch")
                self.assertEqual(py_ok, case["expected"], "Unexpected acceptance")

    def test_schema_itself_is_valid_json_and_strict(self):
        schema = json.loads(intake.SCHEMA_FILE.read_text())
        self.assertEqual(schema["$schema"], "https://json-schema.org/draft/2020-12/schema")
        self.assertFalse(schema["additionalProperties"])
        self.assertIn("rights", schema["properties"])
        self.assertEqual(schema["properties"]["human_annotation"]["properties"]["status"]["const"], "pending")


if __name__ == "__main__":
    unittest.main()
