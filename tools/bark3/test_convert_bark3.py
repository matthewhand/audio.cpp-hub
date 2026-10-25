"""Offline unit tests for the Underdog Bark 3.0 -> parakeet_tdt staging converter (#186).

Synthetic tensors only: no model download, no constriction, no torch.
Run: python3 -m unittest discover -s tools/bark3 -p 'test_*.py'
"""
from __future__ import annotations

import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import convert_bark3 as cb  # noqa: E402

REF_CFG = {
    "model_type": "parakeet_tdt",
    "vocab_size": 8193,
    "blank_token_id": 8192,
    "encoder_config": {"hidden_size": 1024, "num_hidden_layers": 24, "num_mel_bins": 128},
}


def read_safetensors(path: Path):
    raw = path.read_bytes()
    n = struct.unpack("<Q", raw[:8])[0]
    head = json.loads(raw[8:8 + n])
    base = 8 + n
    out = {}
    for name, e in head.items():
        if name == "__metadata__":
            continue
        a, b = e["data_offsets"]
        out[name] = (e["dtype"], e["shape"], np.frombuffer(raw[base + a:base + b], np.float32).reshape(e["shape"]))
    return head, out


class PrepareStateDict(unittest.TestCase):
    def test_drops_vad_head_and_batchnorm_counters(self):
        sd = {
            "encoder.layers.0.w": np.ones((2, 3), np.float16),
            "vad_head.proj.weight": np.ones((1, 4), np.float16),
            "encoder.layers.0.bn.num_batches_tracked": np.array(5, np.int64),
        }
        kept, dropped = cb.prepare_state_dict(sd)
        self.assertEqual(sorted(kept), ["encoder.layers.0.w"])
        self.assertEqual(sorted(dropped), ["encoder.layers.0.bn.num_batches_tracked", "vad_head.proj.weight"])

    def test_casts_to_contiguous_float32_preserving_values(self):
        src = np.arange(6, dtype=np.float16).reshape(3, 2).T  # non-contiguous view
        kept, _ = cb.prepare_state_dict({"x": src})
        self.assertEqual(kept["x"].dtype, np.float32)
        self.assertTrue(kept["x"].flags["C_CONTIGUOUS"])
        np.testing.assert_array_equal(kept["x"], src.astype(np.float32))

    def test_rejects_non_finite_weights(self):
        with self.assertRaises(ValueError):
            cb.prepare_state_dict({"x": np.array([1.0, np.nan], np.float32)})

    def test_rejects_empty_result(self):
        with self.assertRaises(ValueError):
            cb.prepare_state_dict({"vad_head.w": np.ones(2, np.float32)})


class ValidateConfig(unittest.TestCase):
    def test_matching_config_passes(self):
        cb.validate_config(json.loads(json.dumps(REF_CFG)), REF_CFG)

    def test_mismatched_vocab_fails(self):
        bad = json.loads(json.dumps(REF_CFG))
        bad["vocab_size"] = 1025
        with self.assertRaisesRegex(ValueError, "vocab_size"):
            cb.validate_config(bad, REF_CFG)

    def test_mismatched_encoder_depth_fails(self):
        bad = json.loads(json.dumps(REF_CFG))
        bad["encoder_config"]["num_hidden_layers"] = 17
        with self.assertRaisesRegex(ValueError, "num_hidden_layers"):
            cb.validate_config(bad, REF_CFG)


class WriteSafetensors(unittest.TestCase):
    def test_round_trip_and_alignment(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "model.safetensors"
            t = {"b": np.arange(3, dtype=np.float32), "a": np.full((2, 2), 0.5, np.float32)}
            cb.write_safetensors(p, t, metadata={"source": "test"})
            head, got = read_safetensors(p)
            self.assertEqual(head["__metadata__"], {"source": "test"})
            self.assertEqual(sorted(got), ["a", "b"])
            for k in t:
                self.assertEqual(got[k][0], "F32")
                np.testing.assert_array_equal(got[k][2], t[k])
            n = struct.unpack("<Q", p.read_bytes()[:8])[0]
            self.assertEqual((8 + n) % 8, 0, "data section must be 8-byte aligned")


class Stage(unittest.TestCase):
    def _meta(self, d: Path):
        d.mkdir()
        (d / "config.json").write_text(json.dumps(REF_CFG))
        for f in cb.SIDECARS[1:]:
            (d / f).write_text("{}")
        return d

    def test_stage_writes_weights_sidecars_and_provenance(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            meta = self._meta(root / "meta")
            out = root / "out"
            sd = {"w": np.ones((2, 2), np.float16), "vad_head.b": np.ones(2, np.float16)}
            info = cb.stage(sd, json.loads(json.dumps(REF_CFG)), meta, out,
                            provenance={"bark_revision": "abc"})
            for f in ("model.safetensors", *cb.SIDECARS, "provenance.json"):
                self.assertTrue((out / f).is_file(), f)
            prov = json.loads((out / "provenance.json").read_text())
            self.assertEqual(prov["bark_revision"], "abc")
            self.assertEqual(prov["dropped"], ["vad_head.b"])
            self.assertEqual(prov["tensors"], 1)
            self.assertEqual(info["tensors"], 1)

    def test_missing_sidecar_is_an_error(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            meta = self._meta(root / "meta")
            (meta / "tokenizer.json").unlink()
            with self.assertRaisesRegex(FileNotFoundError, "tokenizer.json"):
                cb.stage({"w": np.ones(2, np.float32)}, REF_CFG, meta, root / "out")


class GgufCommand(unittest.TestCase):
    def test_command_targets_parakeet_tdt(self):
        cmd = cb.gguf_command(Path("/b/audiocpp_gguf"), Path("/s"), Path("/o/x.gguf"),
                              "q8_0", Path("/spec/parakeet_tdt.json"))
        self.assertEqual(cmd[0], "/b/audiocpp_gguf")
        joined = " ".join(cmd)
        for frag in ("--family parakeet_tdt", "--type q8_0", "--input /s/model.safetensors",
                     "--root /s", "--output /o/x.gguf", "--model-spec /spec/parakeet_tdt.json"):
            self.assertIn(frag, joined)

    def test_rejects_unknown_type(self):
        with self.assertRaises(ValueError):
            cb.gguf_command(Path("g"), Path("s"), Path("o"), "q3_xs", None)


class FailureCleanup(unittest.TestCase):
    def test_failed_write_leaves_no_partial_file(self):
        class Boom(np.ndarray):
            def astype(self, *a, **k):
                raise OSError("disk full")
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "model.safetensors"
            t = np.zeros((2,), np.float32).view(Boom)
            with self.assertRaises(OSError):
                cb.write_safetensors(out, {"w": t})
            self.assertEqual(list(Path(d).iterdir()), [])

    def test_missing_loader_is_a_clear_error(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(FileNotFoundError, "bark_loader.py"):
                cb.load_bark(Path(d))


if __name__ == "__main__":
    unittest.main()
