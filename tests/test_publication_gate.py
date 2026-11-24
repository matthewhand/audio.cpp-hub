"""Behavioral regression tests for the external local publication gate."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile

DRIVER = Path(__file__).resolve().parents[1] / "scripts/publication-gate.py"
SPEC = importlib.util.spec_from_file_location("publication_gate", DRIVER)
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        (self.source / "README.md").write_text("fixture\n")
        self.git("add", "README.md")
        self.git("commit", "-qm", "fixture")
        self.sha = self.git("rev-parse", "HEAD").strip()
        self.env = gate.offline_env(
            os.defpath, self.root / "home", self.root / "modules",
            self.root / "browsers")
        self.runner = gate.Gate(self.source, self.env, 0.000001, 0.000001)

    def git(self, *args):
        result = subprocess.run(
            ["git", *args], cwd=self.source, capture_output=True,
            text=True, check=True,
            env={**os.environ, "GIT_CONFIG_NOSYSTEM": "1",
                 "GIT_CONFIG_GLOBAL": "/dev/null"})
        return result.stdout

    def test_correct_sha_and_clean_tree(self):
        gate.clean(self.runner, self.sha)

    def test_wrong_sha(self):
        with self.assertRaisesRegex(RuntimeError, "Wrong HEAD"):
            gate.clean(self.runner, "0" * 40)
        with self.assertRaisesRegex(RuntimeError, "40 hex"):
            gate.clean(self.runner, "abc")

    def test_dirty_tracked_source(self):
        (self.source / "README.md").write_text("changed\n")
        with self.assertRaises(RuntimeError):
            gate.clean(self.runner, self.sha)

    def test_staged_change(self):
        (self.source / "README.md").write_text("changed\n")
        self.git("add", "README.md")
        with self.assertRaises(RuntimeError):
            gate.clean(self.runner, self.sha)

    def test_untracked_and_ignored_files(self):
        extra = self.source / "unexpected"
        extra.write_text("private")
        with self.assertRaisesRegex(RuntimeError, "Untracked/ignored"):
            gate.clean(self.runner, self.sha)
        extra.unlink()
        (self.source / ".git/info/exclude").write_text("ignored-runtime\n")
        (self.source / "ignored-runtime").mkdir()
        (self.source / "ignored-runtime/private").write_text("private")
        with self.assertRaisesRegex(RuntimeError, "Untracked/ignored"):
            gate.clean(self.runner, self.sha)

    def test_controlled_dependency_symlink(self):
        modules = self.root / "modules"
        modules.mkdir()
        (modules / "dependency").write_text("external")
        (self.source / "node_modules").symlink_to(modules, target_is_directory=True)
        gate.clean(self.runner, self.sha, modules)
        self.assertEqual(self.runner.receipt["controlled_exception"]["target"],
                         str(modules))
        with self.assertRaises(RuntimeError):
            gate.clean(self.runner, self.sha, self.root / "different")
        (self.source / "other").write_text("untracked")
        with self.assertRaises(RuntimeError):
            gate.clean(self.runner, self.sha, modules)

    def test_output_inside_source_including_symlink_alias(self):
        self.assertFalse(gate.outside(self.source / "output", self.source))
        alias = self.root / "alias"
        alias.symlink_to(self.source, target_is_directory=True)
        self.assertFalse(gate.outside(alias / "output", self.source))
        self.assertTrue(gate.outside(self.root / "evidence", self.source))

    def test_packaging_rejects_source_symlink(self):
        (self.root / "secret").write_text("secret")
        (self.source / "link").symlink_to(self.root / "secret")
        with self.assertRaisesRegex(RuntimeError, "Symlink"):
            gate.regular_bytes(self.source, "link")
        with self.assertRaises(RuntimeError):
            gate.regular_bytes(self.source, "../secret")

    def test_blob_check_and_config_inclusion(self):
        for name in ("LICENSE", "THIRD_PARTY_NOTICES", "hub.config.example.json"):
            (self.source / name).write_text("{}\n")
        (self.source / "web").mkdir()
        (self.source / "web/index.html").write_text("<title>Fixture</title>")
        self.git("add", ".")
        self.git("commit", "-qm", "package fixture")
        files = gate.package_sources(self.runner)
        self.assertIn("hub.config.example.json", files)
        self.assertIn("web/index.html", files)
        (self.source / "web/index.html").write_text("tampered")
        with self.assertRaisesRegex(RuntimeError, "Git blob"):
            gate.package_sources(self.runner)


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.files = {
            "release/audio.cpp-hub": (b"binary fixture", 0o755),
            "release/web/index.html": (b"<title>Fixture</title>\n", 0o644),
        }
        self.epoch = 1700000000
        moment = gate.dt.datetime.fromtimestamp(self.epoch, gate.dt.timezone.utc)
        self.timestamp = (moment.year, moment.month, moment.day, moment.hour,
                          moment.minute, moment.second // 2 * 2)

    def test_deterministic_zip_and_existing_output_preserved(self):
        first, second = self.root / "one.zip", self.root / "two.zip"
        gate.deterministic_zip(first, self.files, self.epoch)
        gate.deterministic_zip(second, dict(reversed(list(self.files.items()))),
                               self.epoch)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        original = first.read_bytes()
        with self.assertRaises(FileExistsError):
            gate.deterministic_zip(first, self.files, self.epoch)
        self.assertEqual(first.read_bytes(), original)

    def test_malicious_paths(self):
        for name in ("../secret", "/absolute", "a/../../b", "a\\b", "C:/x",
                     "a//b", "a/./b", "a/"):
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                gate.deterministic_zip(self.root / "bad.zip",
                                       {name: (b"bad", 0o644)}, self.epoch)
        self.assertFalse((self.root / "bad.zip").exists())

    def test_extra_member_rejected(self):
        archive = self.root / "extra.zip"
        gate.deterministic_zip(archive, self.files, self.epoch)
        with zipfile.ZipFile(archive, "a") as output:
            output.writestr("release/private.txt", b"private")
        with self.assertRaisesRegex(RuntimeError, "member set"):
            gate.verify_zip(archive, self.files, self.timestamp)

    def test_archive_symlink_rejected(self):
        archive = self.root / "link.zip"
        info = zipfile.ZipInfo("release/link", self.timestamp)
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(archive, "w") as output:
            output.writestr(info, b"/private")
        with self.assertRaisesRegex(RuntimeError, "permissions/type"):
            gate.verify_zip(archive, {"release/link": (b"/private", 0o777)},
                            self.timestamp)

    def test_content_tampering_rejected(self):
        archive = self.root / "different.zip"
        altered = dict(self.files)
        altered["release/audio.cpp-hub"] = (b"different", 0o755)
        gate.deterministic_zip(archive, altered, self.epoch)
        with self.assertRaisesRegex(RuntimeError, "digest"):
            gate.verify_zip(archive, self.files, self.timestamp)


class EnvironmentAndProcessTests(unittest.TestCase):
    def test_offline_values_override_inherited_settings(self):
        old = os.environ.copy()
        try:
            os.environ.update(
                GOPROXY="https://example.invalid", GOTOOLCHAIN="auto",
                npm_config_offline="false", HTTPS_PROXY="http://example.invalid",
                PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="0", NODE_OPTIONS="--inspect")
            env = gate.offline_env("/tools:/usr/bin:/bin", Path("/run/home"),
                                   Path("/cache/go"), Path("/cache/browser"))
            self.assertEqual(env["GOPROXY"], "off")
            self.assertEqual(env["GOTOOLCHAIN"], "local")
            self.assertEqual(env["npm_config_offline"], "true")
            self.assertEqual(env["PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"], "1")
            self.assertNotIn("HTTPS_PROXY", env)
            self.assertNotIn("NODE_OPTIONS", env)
            self.assertEqual(env["GOCACHE"], "/run/home/gocache")
        finally:
            os.environ.clear()
            os.environ.update(old)

    @unittest.skipUnless(sys.platform == "linux", "Linux process-group regression")
    def test_timeout_cleans_child_and_saves_failed_command(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / "run"
            run.mkdir()
            env = gate.offline_env(os.defpath, run / "home",
                                   root / "modules", root / "browsers")
            runner = gate.Gate(root, env, 0.000001, 0.000001)
            runner.root = run
            child_pid_file = run / "child.pid"
            program = (
                "import pathlib,subprocess,sys,time\n"
                "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])\n"
                "pathlib.Path(sys.argv[1]).write_text(str(p.pid))\n"
                "time.sleep(60)\n"
            )
            started = time.monotonic()
            with self.assertRaisesRegex(RuntimeError, "timeout"):
                runner.command([sys.executable, "-B", "-c", program, child_pid_file],
                               timeout=1)
            self.assertLess(time.monotonic() - started, 13)
            self.assertTrue(child_pid_file.exists())
            pid = int(child_pid_file.read_text())
            proc = Path(f"/proc/{pid}/stat")
            # A reparented zombie has terminated and cannot hold sockets or run.
            if proc.exists():
                state = proc.read_text().rsplit(")", 1)[1].split()[0]
                self.assertEqual(state, "Z")
            receipt = json.loads((run / "receipt.json").read_text())
            command = receipt["commands"][-1]
            self.assertIn("timeout", command["error"])
            self.assertIsNotNone(command["exit_code"])
            self.assertEqual(command["log_sha256"],
                             gate.digest((run / command["log"]).read_bytes()))

    def test_owned_size_does_not_follow_cache_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run, cache = root / "run", root / "cache"
            run.mkdir()
            cache.mkdir()
            (cache / "large").write_bytes(b"x" * 10000)
            (run / "cache-link").symlink_to(cache, target_is_directory=True)
            (run / "own").write_bytes(b"abc")
            self.assertEqual(gate.owned_size(run), 3)


if __name__ == "__main__":
    unittest.main()
