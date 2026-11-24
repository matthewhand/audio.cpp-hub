"""Focused behavioral regressions for the independent gate review."""
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest import mock

from test_publication_gate import gate


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def runner(self, allocated=False, **kwargs):
        env = gate.offline_env(os.defpath, self.root / "run/home",
                               self.root / "modules", self.root / "browsers")
        result = gate.Gate(self.root, env, 0.000001, 0.000001,
                           output=self.root, min_output=0.000001, **kwargs)
        if allocated:
            result.root = self.root / "run"
            result.root.mkdir()
        return result

    def test_exact_headless_only_1243_layout_and_platform_override(self):
        modules, cache = self.root / "modules", self.root / "cache"
        core = modules / "playwright-core"
        core.mkdir(parents=True)
        (core / "browsers.json").write_text(json.dumps({"browsers": [
            {"name": "chromium", "revision": "9999"},
            {"name": "chromium-headless-shell", "revision": "9999",
             "revisionOverrides": {"ubuntu22.04-x64": "1243",
                                   "ubuntu24.04-x64": "8888"}},
            {"name": "ffmpeg", "revision": "1011"},
        ]}))
        shell = cache / (
            "chromium_headless_shell-1243/"
            "chrome-headless-shell-linux64/chrome-headless-shell")
        ffmpeg = cache / "ffmpeg-1011/ffmpeg-linux"
        for executable in (shell, ffmpeg):
            executable.parent.mkdir(parents=True)
            executable.write_bytes(b"fixture")
            executable.chmod(0o755)
        evidence = gate.browser_preflight(
            modules, cache, platform_key="ubuntu22.04-x64")
        self.assertEqual({x["name"] for x in evidence},
                         {"chromium-headless-shell", "ffmpeg"})
        self.assertFalse((cache / "chromium-9999").exists())
        gate.browser_preflight(modules, cache, resolved={
            "chromium-headless-shell": str(shell), "ffmpeg": str(ffmpeg)})
        shell.unlink()
        with self.assertRaisesRegex(RuntimeError, "cached executable absent"):
            gate.browser_preflight(
                modules, cache, platform_key="ubuntu22.04-x64")

    @unittest.skipUnless(sys.platform == "linux", "Linux process groups required")
    def test_preflight_timeout_cleans_descendant_without_run_allocation(self):
        runner = self.runner()
        pidfile = self.root / "child.pid"
        program = (
            "import pathlib,subprocess,sys,time\n"
            "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])\n"
            "pathlib.Path(sys.argv[1]).write_text(str(p.pid))\n"
            "print('preflight child started', flush=True)\n"
            "time.sleep(60)\n"
        )
        started = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, "timeout"):
            runner.command([sys.executable, "-B", "-c", program, pidfile], timeout=1)
        self.assertLess(time.monotonic() - started, 13)
        self.assertIsNone(runner.root)
        self.assertFalse((self.root / "run").exists())
        self.assertTrue(pidfile.exists())
        statefile = Path(f"/proc/{int(pidfile.read_text())}/stat")
        if statefile.exists():
            self.assertEqual(statefile.read_text().rsplit(")", 1)[1].split()[0], "Z")
        row = runner.receipt["commands"][-1]
        self.assertIsNotNone(row["exit_code"])
        self.assertIn("preflight child started", row["preflight_output"])
        self.assertIn("timeout", row["error"])

    def test_preflight_output_is_bounded(self):
        runner = self.runner()
        with self.assertRaisesRegex(RuntimeError, "output limit"):
            runner.command([sys.executable, "-B", "-c",
                            "import os; os.write(1, b'x' * 1000000)"], timeout=5)
        row = runner.receipt["commands"][-1]
        self.assertTrue(row["output_truncated"])
        self.assertEqual(row["captured_bytes"], gate.PREFLIGHT_OUTPUT_LIMIT)

    def test_small_run_budget_and_actual_output_capacity(self):
        (self.root / "payload").write_bytes(b"x" * 256)
        with self.assertRaisesRegex(RuntimeError, "Run-directory budget"):
            gate.resources(self.root, 0.000001, 0.000001, self.root,
                           max_run=128 / gate.GIB, min_output=0.000001)
        free = gate.shutil.disk_usage(self.root).free
        with self.assertRaisesRegex(RuntimeError, "Output filesystem"):
            gate.resources(None, 0.000001, 0.000001, self.root,
                           min_output=(free + gate.GIB) / gate.GIB)
        sample = gate.resources(None, 0.000001, 0.000001, self.root,
                                min_output=0.000001)
        self.assertGreater(sample["output_free"], 0)

    def test_limits_reject_nan_infinity_zero_and_negative(self):
        for value in (float("nan"), float("inf"), -float("inf"), 0, -1):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                gate.positive_limits(4, 6, value, 0.5)
        gate.positive_limits(4, 6, 1.25, 0.5)

    def test_rotation_removes_only_owned_scratch_cache(self):
        runner = self.runner(allocated=True, rotate=True)
        cache = runner.root / "home/gocache"
        cache.mkdir(parents=True)
        (cache / "compiled").write_bytes(b"cache bytes")
        evidence = runner.root / "evidence.log"
        evidence.write_bytes(b"retain")
        shared = self.root / "modules"
        shared.mkdir()
        (shared / "module").write_bytes(b"retain module")
        runner.rotate_cache("after-backend")
        self.assertEqual(list(cache.iterdir()), [])
        self.assertEqual(evidence.read_bytes(), b"retain")
        self.assertEqual((shared / "module").read_bytes(), b"retain module")
        self.assertEqual(runner.receipt["cache_rotations"],
                         [{"phase": "after-backend", "bytes_removed": 11}])
        cache.rmdir()
        cache.symlink_to(shared, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "Symlink"):
            runner.rotate_cache("must-refuse")
        self.assertTrue((shared / "module").exists())

    def test_copy_verification_failure_preserves_original(self):
        source, target = self.root / "source", self.root / "evidence"
        source.write_bytes(b"original")
        with mock.patch.object(gate.shutil, "copyfileobj",
                               side_effect=lambda inp, out, size: out.write(b"bad")):
            with self.assertRaisesRegex(RuntimeError, "verification"):
                gate.relocate_fresh(source, target)
        self.assertEqual(source.read_bytes(), b"original")
        self.assertEqual(target.read_bytes(), b"bad")

    def test_harvest_preserves_evidence_and_refuses_existing_destination(self):
        runner = self.runner(allocated=True)
        report = self.root / "test-results"
        report.mkdir()
        (report / "trace.zip").write_bytes(b"trace")
        gate.harvest(runner)
        self.assertFalse(report.exists())
        target = runner.root / "test-results/trace.zip"
        self.assertEqual(target.read_bytes(), b"trace")
        report.mkdir()
        (report / "trace.zip").write_bytes(b"new trace")
        with self.assertRaisesRegex(RuntimeError, "already exists"):
            gate.harvest(runner)
        self.assertEqual(target.read_bytes(), b"trace")
        self.assertEqual((report / "trace.zip").read_bytes(), b"new trace")

    def test_real_cross_filesystem_relocation_when_available(self):
        shared_memory = Path("/dev/shm")
        if not shared_memory.is_dir() or not os.access(shared_memory, os.W_OK):
            self.skipTest("No writable secondary filesystem")
        if shared_memory.stat().st_dev == self.root.stat().st_dev:
            self.skipTest("Temporary directories share a filesystem")
        with tempfile.TemporaryDirectory(dir=shared_memory) as other:
            source = self.root / "fresh"
            source.mkdir()
            (source / "synthetic.png").write_bytes(b"synthetic fixture")
            (source / "synthetic.png").chmod(0o640)
            target = Path(other) / "evidence"
            before = gate.tree_snapshot(source)
            gate.relocate_fresh(source, target)
            self.assertEqual(gate.tree_snapshot(target), before)
            self.assertFalse(source.exists())


if __name__ == "__main__":
    unittest.main()
