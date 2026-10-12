"""Synthetic-only human diarization adjudication validation (no WAV/audio)."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/validate-diarization-adjudication.py"
SPEC = importlib.util.spec_from_file_location("diar_adjudication", SCRIPT)
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


def review(start=0, end=3000):
    return [
        {"start_ms": start, "end_ms": end, "speaker_id": "spk_01"},
        {"start_ms": 2000, "end_ms": 4000, "speaker_id": "spk_02"},
    ]


def fixture():
    intake = {
        "schema_version": 2,
        "fixture_set_id": "set_synthetic_01",
        "rights": {
            "license_id": "CC-BY-4.0",
            "license_url": "https://creativecommons.org/licenses/by/4.0/",
            "public_attribution": "Synthetic metadata only; no recordings or rights verified",
            "recording_redistribution_verified": True,
            "derivative_mixing_verified": True,
            "rights_reviewer_evidence_id": "rights_review_01",
        },
        "sources": [
            {
                "speaker_id": f"spk_0{n}",
                "relative_wav_path": f"speaker_0{n}.wav",
                "sha256": f"{n}" * 64,
                "recording_rights_evidence_id": f"rights_0{n}",
                "performer_release_evidence_id": f"release_0{n}",
                "recording_rights_verified": True,
                "performer_release_verified": True,
                "recording_type": "original-human-recording",
                "recording_origin_evidence_id": f"origin_0{n}",
            } for n in range(1, 5)
        ],
        "human_annotation": {
            "status": "pending", "independent_annotators": [],
            "speaker_identity_verified": False, "speech_boundaries_adjudicated": False,
        },
        "cases": {
            "silence_0spk": {
                "duration_seconds": 6, "speaker_ids": [], "overlap_required": False,
            },
            "solo_1spk": {
                "duration_seconds": 8.5, "speaker_ids": ["spk_01"], "overlap_required": False,
            },
            "overlap_2spk": {
                "duration_seconds": 12,
                "speaker_ids": ["spk_01", "spk_02"],
                "overlap_required": True,
            },
            "overlap_4spk": {
                "duration_seconds": 19,
                "speaker_ids": ["spk_01", "spk_02", "spk_03", "spk_04"],
                "overlap_required": True,
            },
        },
    }
    digest = hashlib.sha256(json.dumps(intake, sort_keys=True).encode()).hexdigest()
    bundle = {
        "bundle_version": 1,
        "fixture_set_id": "set_synthetic_01",
        "case_id": "overlap_2spk",
        "rights_intake_sha256": digest,
        "recording_sha256": "b" * 64,
        "rights_review_evidence_id": "rights_review_01",
        "reviewers": [
            {
                "reviewer_id": "reviewer_alpha",
                "review_evidence_id": "review_log_a",
                "independent": True,
                "model_output_seen": False,
                "segments": review(),
            },
            {
                "reviewer_id": "reviewer_beta",
                "review_evidence_id": "review_log_b",
                "independent": True,
                "model_output_seen": False,
                "segments": review(end=2900),
            },
        ],
        "adjudication": {
            "adjudicator_id": "reviewer_gamma",
            "review_evidence_id": "review_log_c",
            "segments": review(),
            "decisions": [
                {"start_ms": 2900, "end_ms": 3000, "reason": "boundary",
                 "evidence_id": "decision_001"}
            ],
        },
    }
    return bundle, intake, digest


class HumanAdjudicationTests(unittest.TestCase):
    def setUp(self):
        self.bundle, self.intake, self.digest = fixture()

    def check(self):
        return audit.validate(self.bundle, self.intake, self.digest)

    def fails(self, expression):
        with self.assertRaisesRegex(audit.AuditError, expression):
            self.check()

    def test_valid_synthetic_boundary_disagreement_preserves_overlap(self):
        out = self.check()
        self.assertEqual(out["disagreement_spans"], 1)
        self.assertEqual(out["disagreement_ms"], 100)
        self.assertEqual(out["adjudicated_overlap_ms"], 1000)
        self.assertEqual(out["agreed_ms"], 11900)
        self.assertFalse(out["publication_ready"])
        self.assertFalse(out["source_audio_opened"])

    def test_no_decision_for_disagreement_rejected(self):
        self.bundle["adjudication"]["decisions"] = []
        self.fails("one decision required")

    def test_wrong_decision_span_rejected(self):
        self.bundle["adjudication"]["decisions"][0]["start_ms"] = 0
        self.fails("Decision boundaries")

    def test_adjudicator_cannot_change_consensus(self):
        self.bundle["adjudication"]["segments"][1]["end_ms"] = 3800
        self.fails("reviewer agreement")

    def test_reviewer_reuse_rejected(self):
        self.bundle["reviewers"][1]["reviewer_id"] = "reviewer_alpha"
        self.fails("reused")

    def test_review_evidence_reuse_rejected(self):
        self.bundle["reviewers"][1]["review_evidence_id"] = "review_log_a"
        self.fails("reused")

    def test_non_blind_review_rejected(self):
        self.bundle["reviewers"][1]["model_output_seen"] = True
        self.fails("model predictions")

    def test_independence_rejected(self):
        self.bundle["reviewers"][1]["independent"] = False
        self.fails("independent")

    def test_adjudicator_must_be_separate(self):
        self.bundle["adjudication"]["adjudicator_id"] = "reviewer_alpha"
        self.fails("independent")

    def test_evidence_collision_rejected(self):
        self.bundle["adjudication"]["decisions"][0]["evidence_id"] = "review_log_a"
        self.fails("reused")

    def test_unauthorised_speaker_rejected(self):
        self.bundle["reviewers"][0]["segments"][0]["speaker_id"] = "spk_04"
        self.fails("roster")

    def test_same_speaker_overlap_rejected(self):
        self.bundle["reviewers"][0]["segments"].append(
            {"start_ms": 2400, "end_ms": 3200, "speaker_id": "spk_01"}
        )
        self.fails("overlap or are unsorted")

    def test_duplicate_and_extra_review_fields_rejected(self):
        self.bundle["reviewers"][0]["self_reported_quality"] = "excellent"
        self.fails("invalid or missing fields")

    def test_malformed_interval_rejected(self):
        self.bundle["reviewers"][0]["segments"][0]["end_ms"] = 12001
        self.fails("out of range")

    def test_boolean_timestamp_rejected(self):
        self.bundle["reviewers"][0]["segments"][0]["start_ms"] = False
        self.fails("integer milliseconds")

    def test_nonfinite_case_duration_rejected(self):
        self.intake["cases"]["overlap_2spk"]["duration_seconds"] = float("nan")
        self.fails("schema mismatch")

    def test_digest_mismatch_rejected(self):
        self.bundle["rights_intake_sha256"] = "0" * 64
        self.fails("digest mismatch")

    def test_rights_attestation_absent_rejected(self):
        self.intake["rights"]["recording_redistribution_verified"] = False
        self.fails("schema mismatch")

    def test_review_not_authenticated_by_tool(self):
        out = self.check()
        self.assertFalse(out["human_rights_verified_by_tool"])
        self.assertFalse(out["human_identity_verified_by_tool"])

    def test_finished_annotation_flag_does_not_override_pending_intake(self):
        self.intake["human_annotation"]["status"] = "complete"
        self.fails("schema mismatch")

    def test_silence_case_without_speakers_has_null_review_conflicts(self):
        self.bundle["case_id"] = "silence_0spk"
        for reviewer in self.bundle["reviewers"]:
            reviewer["segments"] = []
        self.bundle["adjudication"]["segments"] = []
        self.bundle["adjudication"]["decisions"] = []
        out = self.check()
        self.assertEqual(out["disagreement_spans"], 0)
        self.assertEqual(out["adjudicated_overlap_ms"], 0)
        self.assertFalse(out["publication_ready"])

    def test_duplicate_json_keys_fail_closed(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "duplicate.json"
            p.write_text('{"case_id":"x","case_id":"y"}', encoding="utf-8")
            with self.assertRaisesRegex(audit.AuditError, "Duplicate JSON key"):
                audit.read_json(p)

    def test_rights_license_url_mismatch_rejected(self):
        self.intake["rights"]["license_url"] = (
            "https://creativecommons.org/publicdomain/zero/1.0/"
        )
        self.fails("licence URL/identifier")

    def test_duplicate_source_digest_rejected(self):
        self.intake["sources"][1]["sha256"] = self.intake["sources"][0]["sha256"]
        self.fails("Duplicate claimed source")

    def test_duplicate_release_reference_rejected(self):
        self.intake["sources"][1]["performer_release_evidence_id"] = (
            self.intake["sources"][0]["performer_release_evidence_id"]
        )
        self.fails("Duplicate performer-release")

    def test_case_overlap_policy_cannot_be_weakened(self):
        self.intake["cases"]["overlap_2spk"]["overlap_required"] = False
        self.fails("schema mismatch")

    def test_incomplete_rights_intake_schema_rejected(self):
        del self.intake["rights"]["license_id"]
        self.fails("schema mismatch")

    def test_rights_intake_extra_private_field_rejected(self):
        self.intake["sources"][0]["legal_name"] = "Do not include identities"
        self.fails("schema mismatch")

    def test_rttm_preview_preserves_concurrent_speakers_without_certification(self):
        valid = self.check()
        self.assertFalse(valid["publication_ready"])
        rows = audit.segments(self.bundle["adjudication"]["segments"],
                              ["spk_01", "spk_02"], 12000, "final")
        preview = audit.rttm_preview("overlap_2spk", rows)
        self.assertIn("# UNVERIFIED", preview)
        self.assertEqual(len(preview.splitlines()), 3)
        self.assertIn("SPEAKER overlap_2spk 1 0.000 3.000", preview)
        self.assertIn("SPEAKER overlap_2spk 1 2.000 2.000", preview)

    def test_cli_reads_only_private_metadata_json(self):
        with tempfile.TemporaryDirectory() as td:
            directory = Path(td)
            i = directory / "intake.json"
            b = directory / "review.json"
            raw_intake = json.dumps(self.intake, sort_keys=True).encode()
            i.write_bytes(raw_intake)
            self.bundle["rights_intake_sha256"] = hashlib.sha256(raw_intake).hexdigest()
            b.write_text(json.dumps(self.bundle), encoding="utf-8")
            proc = subprocess.run(
                [sys.executable, "-B", str(SCRIPT), "--bundle", str(b),
                 "--intake-v2", str(i)],
                capture_output=True, text=True, timeout=5,
                env={"PYTHONDONTWRITEBYTECODE": "1"},
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            report = json.loads(proc.stdout)
            self.assertEqual(report["disagreement_ms"], 100)
            self.assertFalse(report["source_audio_opened"])
            preview = subprocess.run(
                [sys.executable, "-B", str(SCRIPT), "--bundle", str(b),
                 "--intake-v2", str(i), "--format", "rttm"],
                capture_output=True, text=True, timeout=5,
                env={"PYTHONDONTWRITEBYTECODE": "1"},
            )
            self.assertEqual(preview.returncode, 0, preview.stderr)
            self.assertIn("# UNVERIFIED", preview.stdout)
            self.assertIn("SPEAKER overlap_2spk 1 2.000 2.000", preview.stdout)
            self.assertEqual(len(preview.stdout.splitlines()), 3)


if __name__ == "__main__":
    unittest.main()
