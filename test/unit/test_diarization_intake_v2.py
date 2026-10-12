"""Synthetic metadata-only intake tests; no audio recording or synthesis."""
import copy
import importlib.util
import hashlib
import os
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
            inspect_audio=lambda path: (sha[path.name], 10 * 16000),
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
        with self.assertRaisesRegex(intake.IntakeError, "Unsafe source path"):
            self.validate()

    def test_absolute_path_rejected(self):
        self.data["sources"][0]["relative_wav_path"] = "/tmp/elsewhere.wav"
        with self.assertRaisesRegex(intake.IntakeError, "Unsafe source path"):
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

    def test_schema_itself_is_valid_json_and_strict(self):
        schema = json.loads(intake.SCHEMA_FILE.read_text())
        self.assertEqual(schema["$schema"], "https://json-schema.org/draft/2020-12/schema")
        self.assertFalse(schema["additionalProperties"])
        self.assertIn("rights", schema["properties"])
        self.assertEqual(schema["properties"]["human_annotation"]["properties"]["status"]["const"], "pending")


if __name__ == "__main__":
    unittest.main()
