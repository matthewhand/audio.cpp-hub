"""Synthetic metadata/RTTM only. No actual audio files or consent materials."""
import copy
import hashlib
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "scripts/validate-human-rttm.py"
SPEC = importlib.util.spec_from_file_location("human_rttm_qa", SRC)
qa = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(qa)

def encoded(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def utterance(case, spk, start, stop):
    return f"SPEAKER {case} 1 {start:.6f} {stop-start:.6f} <NA> <NA> {spk} <NA> <NA>\n"

def synthetic_set():
    ids = ["spk_01", "spk_02", "spk_03", "spk_04"]
    rosters = {"silence_0spk": [], "solo_1spk": ids[:1],
               "overlap_2spk": ids[:2], "overlap_4spk": ids}
    intake = {
        "schema_version": 2, "fixture_set_id": "safe-human-speech",
        "rights": {"license_id": "CC-BY-4.0",
                   "license_url": "https://creativecommons.org/licenses/by/4.0/",
                   "public_attribution": "Placeholder only, not a real licence",
                   "recording_redistribution_verified": True,
                   "derivative_mixing_verified": True,
                   "rights_reviewer_evidence_id": "UNVERIFIED123"},
        "sources": [{"speaker_id": sid, "relative_wav_path": sid+".wav",
                     "sha256": f"{i:064x}",
                     "recording_rights_evidence_id": f"RECORDING{i}",
                     "performer_release_evidence_id": f"CONSENT{i}",
                     "recording_rights_verified": True, "performer_release_verified": True,
                     "recording_type": "original-human-recording",
                     "recording_origin_evidence_id": f"ORIGIN{i}"}
                    for i, sid in enumerate(ids, 1)],
        "cases": {case: {"duration_seconds": qa.CASE_SAMPLES[case]/16000,
                         "speaker_ids": roster,
                         "overlap_required": len(roster) >= 2}
                  for case, roster in rosters.items()},
        "human_annotation": {"status":"pending", "independent_annotators":[],
                             "speaker_identity_verified":False,
                             "speech_boundaries_adjudicated":False}
    }
    completion = {
        "schema_version": 1, "kind":"human-rttm-completion",
        "fixture_set_id": "safe-human-speech", "state":"adjudicated_pending_qa",
        "intake": {"schema_version":2, "manifest_sha256":sha(encoded(intake)),
                   "rights_evidence_id":"UNVERIFIED123"},
        "policy":{"sample_rate":16000,"boundary_review_ms":50,
                  "boundary_escalation_ms":100,"overlap_included":True,"scoring_collar_ms":0},
        "reviewers":{role:{"reviewer_id": "ANON"+role.upper()}
                     for role in ("a","b","adjudicator","qa")},
        "cases":{}
    }
    raw = {}
    for case, roster in rosters.items():
        # Text records only. Audio bytes are deliberately NOT WAV.
        fake_audio = ("synthetic-NOT-audio-"+case).encode()
        speech = []
        for i, spk in enumerate(roster):
            start, stop = [(0.5,1.7),(1.2,2.1),(2.5,3.5),(3.7,4.5)][i]
            speech.append(utterance(case,spk,start,stop))
        transcript = "".join(speech).encode()
        log = encoded({"schema_version":1,"case_id":case,"decisions":[]})
        paths = {
            "audio":f"planned/{case}.wav",
            "a":f"review-a/{case}.rttm",
            "b":f"review-b/{case}.rttm",
            "final":f"final/{case}.rttm",
            "log":f"log/{case}.json"}
        raw.update({paths["audio"]:fake_audio,paths["a"]:transcript,paths["b"]:transcript,
                    paths["final"]:transcript,paths["log"]:log})
        artifact = lambda name: {"relative_path":paths[name],"sha256":sha(raw[paths[name]])}
        completion["cases"][case] = {
            "audio":{**artifact("audio"),"duration_samples":qa.CASE_SAMPLES[case]},
            "speaker_ids":roster,
            "reviewer_a":{"rttm":artifact("a"),"frozen":True},
            "reviewer_b":{"rttm":artifact("b"),"frozen":True},
            "adjudicated_rttm":artifact("final"),
            "adjudication_log":artifact("log"),
            "review_summary":{"disagreement_regions":0,"recorded_disputes":0,"unresolved_disputes":0}
        }
    return completion, intake, raw


class AnnotationQASyntheticTests(unittest.TestCase):
    def setUp(self):
        self.complete, self.intake, self.raw = synthetic_set()

    def validate(self):
        def get(name, limit):
            self.assertLessEqual(len(self.raw[name]),limit)
            return self.raw[name]
        return qa.validate(self.complete,self.intake,sha(encoded(self.intake)),get,
                           inspect_audio=lambda raw,case:qa.CASE_SAMPLES[case])

    def replace(self, case, typ, data):
        spec=self.complete["cases"][case]
        path=spec[typ]["relative_path"]
        self.raw[path]=data
        spec[typ]["sha256"]=sha(data)

    def test_happy_path_returns_technical_only_not_release(self):
        result=self.validate()
        self.assertEqual(result["status"],"technical_qa_passed")
        self.assertEqual(result["cases_validated"],4)
        for forbidden in ("human_attestations_authenticated","redistribution_authorized","release_authorized"):
            self.assertIs(result[forbidden],False)

    def test_reject_intake_hash_change(self):
        self.complete["intake"]["manifest_sha256"]="0"*64
        with self.assertRaisesRegex(qa.QAError,"Intake SHA"):
            self.validate()

    def test_reject_wrong_fixture_set(self):
        self.complete["fixture_set_id"]="other-fixture"
        with self.assertRaisesRegex(qa.QAError,"Fixture set"):
            self.validate()

    def test_reject_missing_or_same_reviewer(self):
        self.complete["reviewers"]["b"]["reviewer_id"]=self.complete["reviewers"]["a"]["reviewer_id"]
        with self.assertRaisesRegex(qa.QAError,"must be distinct"):
            self.validate()

    def test_reject_false_frozen_submission(self):
        self.complete["cases"]["solo_1spk"]["reviewer_a"]["frozen"]=False
        with self.assertRaisesRegex(qa.QAError,"unexpected constant"):
            self.validate()

    def test_reject_mismatched_hash(self):
        target=self.complete["cases"]["solo_1spk"]["adjudicated_rttm"]["relative_path"]
        self.raw[target]+=b"x"
        with self.assertRaisesRegex(qa.QAError,"SHA-256 mismatch"):
            self.validate()

    def test_reject_private_field(self):
        self.complete["reviewers"]["a"]["email"]="privacy@invalid.test"
        with self.assertRaisesRegex(qa.QAError,"unrecognized field"):
            self.validate()

    def test_reject_wrong_speaker(self):
        case="solo_1spk"
        self.replace(case,"adjudicated_rttm",utterance(case,"spk_02",0.5,1.5).encode())
        with self.assertRaisesRegex(qa.QAError,"Unapproved speaker"):
            self.validate()

    def test_reject_missing_required_voice(self):
        self.replace("overlap_4spk","adjudicated_rttm",
                     self.raw["final/overlap_4spk.rttm"].replace(b"spk_04",b"spk_03"))
        with self.assertRaisesRegex(qa.QAError,"Same-speaker self overlap|missing final speaker"):
            self.validate()

    def test_reject_declared_without_real_overlap(self):
        case="overlap_2spk"
        data=utterance(case,"spk_01",0.5,1.0)+utterance(case,"spk_02",1.1,2.1)
        self.replace(case,"adjudicated_rttm",data.encode())
        with self.assertRaisesRegex(qa.QAError,"insufficient overlap"):
            self.validate()

    def test_reject_nonempty_silence_rttm(self):
        self.replace("silence_0spk","adjudicated_rttm",b"\n")
        with self.assertRaisesRegex(qa.QAError,"zero bytes"):
            self.validate()

    def test_reject_nonfinite_rttm(self):
        raw=b"SPEAKER solo_1spk 1 NaN 1 <NA> <NA> spk_01 <NA> <NA>\n"
        self.replace("solo_1spk","adjudicated_rttm",raw)
        with self.assertRaisesRegex(qa.QAError,"invalid timestamp"):
            self.validate()

    def test_reject_not_sample_aligned(self):
        raw=b"SPEAKER solo_1spk 1 0.500001 1.000000 <NA> <NA> spk_01 <NA> <NA>\n"
        self.replace("solo_1spk","adjudicated_rttm",raw)
        with self.assertRaisesRegex(qa.QAError,"not sample aligned"):
            self.validate()

    def test_reject_clip_overrun(self):
        self.replace("solo_1spk","adjudicated_rttm",
                     utterance("solo_1spk","spk_01",8.0,10.0).encode())
        with self.assertRaisesRegex(qa.QAError,"outside clip"):
            self.validate()


    def test_reject_unadjudicated_reviewer_difference(self):
        case="solo_1spk"
        spec=self.complete["cases"][case]
        path=spec["reviewer_b"]["rttm"]["relative_path"]
        self.raw[path]=utterance(case,"spk_01",0.6,1.7).encode()
        spec["reviewer_b"]["rttm"]["sha256"]=sha(self.raw[path])
        with self.assertRaisesRegex(qa.QAError,"unadjudicated reviewer/final disagreement"):
            self.validate()

    def test_resolved_logged_disagreement_can_pass(self):
        case="solo_1spk"
        spec=self.complete["cases"][case]
        path=spec["reviewer_b"]["rttm"]["relative_path"]
        self.raw[path]=utterance(case,"spk_01",0.6,1.7).encode()
        spec["reviewer_b"]["rttm"]["sha256"]=sha(self.raw[path])
        log=encoded({"schema_version":1,"case_id":case,"decisions":[{
            "dispute_id":"DECISION1","start_sample":8000,"end_sample":9600,
            "category":"boundary","status":"resolved",
            "rationale":"Manually adjudicated onset based on independent listening",
            "adjudicator_id":"ANONADJUDICATOR"
        }]})
        self.replace(case,"adjudication_log",log)
        spec["review_summary"]["disagreement_regions"]=1
        spec["review_summary"]["recorded_disputes"]=1
        self.assertEqual(self.validate()["adjudication_decisions"],1)

    def test_reject_unresolved_adjudication(self):
        case="solo_1spk"
        log=encoded({"schema_version":1,"case_id":case,"decisions":[{
            "dispute_id":"D1","start_sample":8000,"end_sample":10000,
            "category":"boundary","status":"unresolved",
            "rationale":"Unresolved boundary disagreement","adjudicator_id":"ANONADJUDICATOR"
        }]})
        self.replace(case,"adjudication_log",log)
        with self.assertRaisesRegex(qa.QAError,"Unresolved"):
            self.validate()

    def test_reject_unlogged_final_drift_even_when_reviewers_agree(self):
        case="solo_1spk"
        self.replace(case,"adjudicated_rttm",utterance(case,"spk_01",0.6,1.7).encode())
        with self.assertRaisesRegex(qa.QAError,"unadjudicated reviewer/final disagreement"):
            self.validate()

    def test_reject_inconsistent_intake_licence_pair(self):
        self.intake["rights"]["license_id"]="CC0-1.0"
        self.complete["intake"]["manifest_sha256"]=sha(encoded(self.intake))
        with self.assertRaisesRegex(qa.QAError,"Intake licence ID/URL mismatch"):
            self.validate()

    def test_very_large_timestamp_rejected_before_arithmetic(self):
        case="solo_1spk"
        raw=b"SPEAKER solo_1spk 1 1e999999 1 <NA> <NA> spk_01 <NA> <NA>\n"
        self.replace(case,"adjudicated_rttm",raw)
        with self.assertRaisesRegex(qa.QAError,"invalid timestamp"):
            self.validate()

    def test_reject_inflated_dispute_counts(self):
        self.complete["cases"]["solo_1spk"]["review_summary"]["recorded_disputes"]=1
        with self.assertRaisesRegex(qa.QAError,"summary inconsistent"):
            self.validate()

    def test_reject_unsafe_path_without_io(self):
        self.complete["cases"]["solo_1spk"]["adjudicated_rttm"]["relative_path"]="../outside.rttm"
        with self.assertRaisesRegex(qa.QAError,"Unsafe artifact path"):
            self.validate()

    def test_secure_read_rejects_symlink_and_allows_text_snapshot(self):
        with tempfile.TemporaryDirectory() as t:
            p=pathlib.Path(t)
            (p/"text.txt").write_bytes(b"synthetic text fixture")
            self.assertEqual(qa.read_artifact(p,"text.txt",1024),b"synthetic text fixture")
            (p/"alias.txt").symlink_to(p/"text.txt")
            with self.assertRaisesRegex(qa.QAError,"Secure artifact open rejected"):
                qa.read_artifact(p,"alias.txt",1024)

    def test_secure_read_enforces_limit(self):
        with tempfile.TemporaryDirectory() as t:
            p=pathlib.Path(t)
            (p/"text.txt").write_bytes(b"metadata too large")
            with self.assertRaisesRegex(qa.QAError,"exceeds byte limit"):
                qa.read_artifact(p,"text.txt",4)

    def test_manifest_snapshot_rejects_symlink_without_audio(self):
        with tempfile.TemporaryDirectory() as t:
            p=pathlib.Path(t)
            (p/"synthetic.json").write_bytes(b'{"demo": 1}')
            (p/"alias.json").symlink_to(p/"synthetic.json")
            self.assertEqual(qa.read_manifest(p/"synthetic.json")[0],{"demo":1})
            with self.assertRaisesRegex(qa.QAError,"Manifest cannot be opened securely"):
                qa.read_manifest(p/"alias.json")

    def test_duplicate_json_key_rejected(self):
        with self.assertRaisesRegex(qa.QAError,"Duplicate JSON key"):
            qa.json_data(b'{"id": 1, "id": 2}', "synthetic")

    def test_nan_json_rejected(self):
        with self.assertRaisesRegex(qa.QAError,"Nonfinite JSON"):
            qa.json_data(b'{"id": NaN}', "synthetic")

    def test_rttm_duplicate_same_speaker_overlap(self):
        case="solo_1spk"
        data=utterance(case,"spk_01",0.5,1.5)+utterance(case,"spk_01",1.0,2.0)
        self.replace(case,"adjudicated_rttm",data.encode())
        with self.assertRaisesRegex(qa.QAError,"Same-speaker self overlap"):
            self.validate()

    def test_schema_document_is_parseable(self):
        schema=json.loads(qa.SCHEMA.read_text())
        self.assertEqual(schema["$schema"],"https://json-schema.org/draft/2020-12/schema")
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(set(schema["properties"]["cases"]["properties"]),set(qa.CASE_SAMPLES))

    def test_permitted_numeric_const_semantics(self):
        self.complete["schema_version"]=1.0
        self.assertEqual(self.validate()["schema_version"],1)
        self.complete["schema_version"]=True
        with self.assertRaisesRegex(qa.QAError,"unexpected constant"):
            self.validate()


if __name__ == "__main__":
    unittest.main()
