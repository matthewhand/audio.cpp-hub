#!/usr/bin/env python3
# Offline unit tests for docker/kokoro-ensure-ready.py (STDLIB ONLY).
# Run: python3 -m unittest discover -s tests -p test_kokoro_ensure_ready.py
# No real network I/O: the HTTP Client class is replaced by a fake.

import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

SCRIPT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "docker", "kokoro-ensure-ready.py")

_spec = importlib.util.spec_from_file_location("kokoro_ensure_ready", SCRIPT_PATH)
kr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(kr)

HUB = "http://127.0.0.1:18280"


def make_exe(tmp, content=b"kokoro-hub-fake-binary"):
    path = os.path.join(tmp, "audio.cpp-hub")
    with open(path, "wb") as f:
        f.write(content)
    return path


def make_weights(tmp):
    path = os.path.join(tmp, "kokoro-82m-q8_0.gguf")
    with open(path, "wb") as f:
        f.write(b"gguf-fake-weights")
    return path


def ready_instance(weights):
    return {
        "instanceName": kr.EXPECTED_INSTANCE_NAME,
        "modelId": kr.EXPECTED_MODEL_ID,
        "backend": kr.EXPECTED_BACKEND,
        "weightsPath": weights,
        "threads": kr.EXPECTED_THREADS,
        "port": kr.EXPECTED_ENGINE_PORT,
        "status": "READY",
    }


def starting_instance(weights):
    inst = ready_instance(weights)
    inst["status"] = "STARTING"
    return inst


def models_registry():
    return {"models": [{"id": kr.EXPECTED_MODEL_ID}]}


def v1_models(ids):
    return {"data": [{"id": i} for i in ids]}


class FakeClient(object):
    """Scripted queue replacement for kr.Client; records requests."""

    def __init__(self, base, responses):
        self.base = base
        self.responses = list(responses)
        self.requests = []

    def pop(self):
        if not self.responses:
            raise AssertionError("fake client ran out of scripted responses")
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def request(self, method, path, body=None):
        self.requests.append((method, path, body))
        return self.pop()


class FailCode(kr.Fail):
    """Convenience Fail with default synthetic code, for scripted errors."""
    def __init__(self, code, msg):
        super(FailCode, self).__init__(code, msg)


class EnsureReadyTestBase(unittest.TestCase):
    """Runs script's run() inside a tempdir with all seams faked."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name
        self.exe = make_exe(self.tmp)
        self.weights = make_weights(self.tmp)
        with open(self.exe, "rb") as fh:
            sha = hashlib.sha256(fh.read()).hexdigest()
        self.env = {
            kr.ENV_TEST_MODE: "1",
            kr.ENV_HUB_BASE: HUB,
            kr.ENV_EXE: self.exe,
            kr.ENV_EXE_SHA256: sha,
            kr.ENV_WEIGHTS: self.weights,
            kr.ENV_MIN_DISK: "0",
            kr.ENV_MIN_MEM: "0",
        }
        self.saved = {}
        for name in ("_sleep", "_now", "disk_free", "mem_available",
                     "proc_exe", "proc_net_tcp",
                     "proc_cgroup", "fd_links", "Client"):
            self.saved[name] = getattr(kr, name)

    def tearDown(self):
        for name, fn in self.saved.items():
            setattr(kr, name, fn)
        self._tmp.cleanup()

    def restore(self):
        # per-test seam reset hook (no-op; tearDown handles it)
        pass

    def patch_client(self, responses):
        self.fake = FakeClient(HUB, responses)
        kr.Client = lambda base: self.fake
        return self.fake

    def fake_time(self, seq):
        it = iter(seq)
        kr._now = lambda: next(it)
        kr._sleep = lambda s: next(it, None)

    def run_ok(self):
        code = kr.run(env=self.env)
        self.assertEqual(code, 0)
        return self.fake.requests


class TestEmptyPostsOnceToReady(EnsureReadyTestBase):
    def test_empty_registry_posts_once_then_ready(self):
        self.fake_time([0] * 20)
        self.patch_client([
            models_registry(),
            [],                                   # GET /api/instances -> empty
            models_registry(),                    # re-verify right before POST
            {"ok": True, "instance": "kokoro"},   # POST accepted
            [ready_instance(self.weights)],       # poll: READY
            v1_models(["kokoro"]),                # GET /v1/models
        ])
        reqs = self.run_ok()
        posts = [r for r in reqs if r[0] == "POST"]
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0][1], "/api/instances")
        payload = json.loads(posts[0][2].decode("utf-8"))
        self.assertEqual(payload["modelId"], kr.EXPECTED_MODEL_ID)
        self.assertEqual(payload["name"], kr.EXPECTED_INSTANCE_NAME)
        self.assertEqual(payload["threads"], kr.EXPECTED_THREADS)
        self.assertEqual(payload["backend"], "cpu")
        self.assertNotIn("delete", [r[0].lower() for r in reqs])


class TestReadyIdempotent(EnsureReadyTestBase):
    def test_ready_no_post(self):
        self.fake_time([0] * 20)
        self.patch_client([
            models_registry(),
            [ready_instance(self.weights)],
            v1_models(["kokoro"]),
        ])
        reqs = self.run_ok()
        self.assertNotIn("POST", [r[0] for r in reqs])


class TestStartingNoPost(EnsureReadyTestBase):
    def test_starting_transitions_without_post(self):
        self.fake_time([0] * 40)
        self.patch_client([
            models_registry(),
            [starting_instance(self.weights)],
            [starting_instance(self.weights)],
            [ready_instance(self.weights)],
            v1_models(["kokoro"]),
        ])
        reqs = self.run_ok()
        self.assertNotIn("POST", [r[0] for r in reqs])


class TestMismatchedMetadata(EnsureReadyTestBase):
    def test_wrong_model_id_fails_17(self):
        self.fake_time([0] * 5)
        inst = ready_instance(self.weights)
        inst["modelId"] = "openaudio_sft"
        self.patch_client([models_registry(), [inst]])
        with self.assertRaises(kr.Fail) as ctx:
            kr.run(env=self.env)
        self.assertEqual(ctx.exception.code, 17)

    def test_wrong_engine_port_fails_17(self):
        self.fake_time([0] * 5)
        inst = ready_instance(self.weights)
        inst["port"] = 12345
        self.patch_client([models_registry(), [inst]])
        with self.assertRaises(kr.Fail) as ctx:
            kr.run(env=self.env)
        self.assertEqual(ctx.exception.code, 17)

    def test_wrong_weights_path_fails_17(self):
        self.fake_time([0] * 5)
        inst = ready_instance(self.weights)
        inst["weightsPath"] = os.path.join(self.tmp, "other.gguf")
        self.patch_client([models_registry(), [inst]])
        with self.assertRaises(kr.Fail) as ctx:
            kr.run(env=self.env)
        self.assertEqual(ctx.exception.code, 17)


class TestForeignInstance(EnsureReadyTestBase):
    def test_two_entries_fail_17(self):
        self.fake_time([0] * 5)
        other = dict(ready_instance(self.weights))
        other["instanceName"] = "other"
        self.patch_client([models_registry(),
                           [ready_instance(self.weights), other]])
        with self.assertRaises(kr.Fail) as ctx:
            kr.run(env=self.env)
        self.assertEqual(ctx.exception.code, 17)


class TestWrongAlias(EnsureReadyTestBase):
    def test_v1_models_extra_alias_fails_21(self):
        self.fake_time([0] * 5)
        self.patch_client([
            models_registry(),
            [ready_instance(self.weights)],
            v1_models(["kokoro", "openaudio"]),
        ])
        with self.assertRaises(kr.Fail) as ctx:
            kr.run(env=self.env)
        self.assertEqual(ctx.exception.code, 21)

    def test_v1_models_missing_alias_fails_21(self):
        self.fake_time([0] * 5)
        self.patch_client([
            models_registry(),
            [ready_instance(self.weights)],
            v1_models([]),
        ])
        with self.assertRaises(kr.Fail) as ctx:
            kr.run(env=self.env)
        self.assertEqual(ctx.exception.code, 21)


class TestHttpFailures(EnsureReadyTestBase):
    def test_http_500_fails_16(self):
        self.fake_time([0] * 5)
        self.patch_client([models_registry(), FailCode(16, "HTTP 500")])
        with self.assertRaises(kr.Fail) as ctx:
            kr.run(env=self.env)
        self.assertEqual(ctx.exception.code, 16)

    def test_models_registry_500_fails_16(self):
        self.fake_time([0] * 5)
        self.patch_client([FailCode(16, "HTTP 500")])
        with self.assertRaises(kr.Fail) as ctx:
            kr.run(env=self.env)
        self.assertEqual(ctx.exception.code, 16)

    def test_unreachable_endpoint_fails_16(self):
        self.fake_time([0] * 5)
        self.patch_client([FailCode(16, "unreachable endpoint")])
        with self.assertRaises(kr.Fail) as ctx:
            kr.run(env=self.env)
        self.assertEqual(ctx.exception.code, 16)

    def test_malformed_json_fails_16(self):
        # Script the Client itself to emulate a body that is not valid JSON.
        self.fake_time([0] * 5)
        self.patch_client([FailCode(16, "malformed JSON on /api/instances")])
        with self.assertRaises(kr.Fail) as ctx:
            kr.run(env=self.env)
        self.assertEqual(ctx.exception.code, 16)

    def test_oversize_json_fails_16(self):
        self.fake_time([0] * 5)
        self.patch_client([FailCode(16, "response body oversize")])
        with self.assertRaises(kr.Fail) as ctx:
            kr.run(env=self.env)
        self.assertEqual(ctx.exception.code, 16)

    def test_unexpected_status_fails_19(self):
        self.fake_time([0] * 5)
        inst = ready_instance(self.weights)
        inst["status"] = "FAILED"
        self.patch_client([models_registry(), [inst]])
        with self.assertRaises(kr.Fail) as ctx:
            kr.run(env=self.env)
        self.assertEqual(ctx.exception.code, 19)


class TestResourcePressure(EnsureReadyTestBase):
    def test_low_disk_fails_13(self):
        self.env[kr.ENV_MIN_DISK] = str(4 * 1024 * 1024 * 1024)
        self.saved["disk_free"] = kr.disk_free
        kr.disk_free = lambda path: 0
        self.fake_time([0] * 5)
        self.patch_client([])
        with self.assertRaises(kr.Fail) as ctx:
            kr.run(env=self.env)
        self.assertEqual(ctx.exception.code, 13)

    def test_low_memory_fails_13(self):
        self.env[kr.ENV_MIN_MEM] = str(4 * 1024 * 1024 * 1024)
        self.saved["mem_available"] = kr.mem_available
        kr.mem_available = lambda: 0
        self.fake_time([0] * 5)
        self.patch_client([models_registry()])
        with self.assertRaises(kr.Fail) as ctx:
            kr.run(env=self.env)
        self.assertEqual(ctx.exception.code, 13)


class TestBadBinaryOrWeights(EnsureReadyTestBase):
    def test_missing_binary_fails_15(self):
        self.env[kr.ENV_EXE] = os.path.join(self.tmp, "nope")
        self.fake_time([0] * 5)
        self.patch_client([])
        with self.assertRaises(kr.Fail) as ctx:
            kr.run(env=self.env)
        self.assertEqual(ctx.exception.code, 15)

    def test_symlinked_weights_fails_15(self):
        link = os.path.join(self.tmp, "link.gguf")
        os.symlink(self.weights, link)
        self.env[kr.ENV_WEIGHTS] = link
        self.fake_time([0] * 5)
        self.patch_client([])
        with self.assertRaises(kr.Fail) as ctx:
            kr.run(env=self.env)
        self.assertEqual(ctx.exception.code, 15)

    def test_sha_mismatch_fails_12(self):
        self.env[kr.ENV_EXE_SHA256] = "0" * 64
        self.fake_time([0] * 5)
        self.patch_client([])
        with self.assertRaises(kr.Fail) as ctx:
            kr.run(env=self.env)
        self.assertEqual(ctx.exception.code, 12)


class TestTimeout(EnsureReadyTestBase):
    def test_time_budget_exceeded_fails_20(self):
        # first _now() makes the deadline, second exceeds it immediately
        self.fake_time([0, kr.MAX_TOTAL_SECONDS + 1])
        self.patch_client([models_registry(), []])
        with self.assertRaises(kr.Fail) as ctx:
            kr.run(env=self.env)
        self.assertEqual(ctx.exception.code, 20)


class TestBootstrapGuard(EnsureReadyTestBase):
    """Production path (TEST_MODE unset): identity guard is enforced."""

    def setUp(self):
        super(TestBootstrapGuard, self).setUp()
        for var in list(self.env):
            self.env.pop(var)
        self.saved["proc_exe"] = kr.proc_exe

    def test_missing_mainpid_fails_12(self):
        with self.assertRaises(kr.Fail) as ctx:
            kr.run(env=self.env)
        self.assertEqual(ctx.exception.code, 12)

    def test_unit_identity_mismatch_fails_12(self):
        self.env["MAINPID"] = "4242"
        self.env[kr.ENV_UNIT] = "wrong.service"
        self.env["INVOCATION_ID"] = "fictional-invocation"
        kr.proc_exe = lambda pid: self.exe
        self.saved["proc_exe"] = kr.proc_exe
        # exe bytes must match pinned sha256 for this path to be reachable
        self.patch_client([])
        with self.assertRaises(kr.Fail) as ctx:
            kr.run(env=self.env)
        self.assertEqual(ctx.exception.code, 12)

    def test_override_without_test_mode_fails_11(self):
        self.env[kr.ENV_WEIGHTS] = "/tmp/anything.gguf"
        with self.assertRaises(kr.Fail) as ctx:
            kr.run(env=self.env)
        self.assertEqual(ctx.exception.code, 11)


class TestListenerOwnerGuard(unittest.TestCase):
    """Fully synthetic, read-only: mocks /proc/net/tcp + /proc fd links.

    Deterministic fictional rows; no live service, no network access. Port
    hex for 18280 is 4768; loopback byte order hex is 0100007F.
    """

    PORT = 18280
    INODE = 5796352
    HEADER = ("  sl local_address remote_address st tx_queue:rx_queue "
              "tr:tm retrnsmt uid timeout inode\n")

    def _cfg(self):
        return {"hub_port": self.PORT}

    def _env(self):
        return {"MAINPID": "2056626", kr.ENV_UNIT: kr.EXPECTED_UNIT}

    def _row(self, local, state, inode):
        return ("   0: %s 00000000:0000 %s 00000000:00000000 "
                "00:00000000 00000000   0        0 %s\n"
                % (local, state, inode))

    def setUp(self):
        self.saved = {k: getattr(kr, k) for k in
                      ("proc_net_tcp", "proc_cgroup", "fd_links")}
        # Default realistic fixtures: exact owner owns socket:[5796352].
        kr.proc_cgroup = lambda pid: (
            "0::/system.slice/%s\n" % kr.EXPECTED_UNIT)
        kr.proc_net_tcp = lambda: self.HEADER + self._row(
            "0100007F:%04X" % self.PORT, "0A", self.INODE)
        kr.fd_links = lambda pid: ["socket:[%d]" % self.INODE]

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(kr, k, v)

    def test_exact_owner_passes(self):
        kr.check_listener_owner_guard(self._env(), self._cfg())

    def test_missing_fd_link_or_listener_fails_12(self):
        # MAINPID fd links point elsewhere: guard must fail closed.
        kr.fd_links = lambda pid: ["socket:[111]"]
        with self.assertRaises(kr.Fail) as ctx:
            kr.check_listener_owner_guard(self._env(), self._cfg())
        self.assertEqual(ctx.exception.code, 12)
        # No listener at all on the pinned loopback port: same failure.
        kr.fd_links = lambda pid: ["socket:[%d]" % self.INODE]
        kr.proc_net_tcp = lambda: self.HEADER
        with self.assertRaises(kr.Fail) as ctx:
            kr.check_listener_owner_guard(self._env(), self._cfg())
        self.assertEqual(ctx.exception.code, 12)

    def test_waits_for_candidate_bind_but_never_posts(self):
        calls = [0]
        now = [0.0]
        original = kr.proc_net_tcp
        def delayed_table():
            calls[0] += 1
            if calls[0] == 1:
                return self.HEADER
            return original()
        kr.proc_net_tcp = delayed_table
        old_now, old_sleep = kr._now, kr._sleep
        kr._now = lambda: now[0]
        kr._sleep = lambda seconds: now.__setitem__(0, now[0] + seconds)
        try:
            kr.wait_for_owned_listener(self._env(), self._cfg(), 15.0)
            self.assertEqual(calls[0], 2)
            self.assertEqual(now[0], kr.POLL_INTERVAL_SECONDS)
        finally:
            kr._now, kr._sleep = old_now, old_sleep

    def test_unbound_listener_times_out_without_post(self):
        kr.proc_net_tcp = lambda: self.HEADER
        now = [0.0]
        old_now, old_sleep = kr._now, kr._sleep
        kr._now = lambda: now[0]
        kr._sleep = lambda seconds: now.__setitem__(0, now[0] + seconds)
        try:
            with self.assertRaises(kr.Fail) as ctx:
                kr.wait_for_owned_listener(self._env(), self._cfg(), 3.0)
            self.assertEqual(ctx.exception.code, 20)
        finally:
            kr._now, kr._sleep = old_now, old_sleep

    def test_foreign_listener_rejected_without_retry(self):
        kr.proc_net_tcp = lambda: self.HEADER + self._row(
            "00000000:%04X" % self.PORT, "0A", self.INODE)
        old_sleep = kr._sleep
        kr._sleep = lambda _: self.fail("must not retry a foreign listener")
        try:
            with self.assertRaises(kr.Fail) as ctx:
                kr.wait_for_owned_listener(self._env(), self._cfg(), kr._now() + 15.0)
            self.assertEqual(ctx.exception.code, 12)
        finally:
            kr._sleep = old_sleep

    def test_foreign_listener_on_port_fails_12(self):
        kr.proc_net_tcp = lambda: self.HEADER + self._row(
            "0A00A8C0:%04X" % self.PORT, "0A", self.INODE)
        with self.assertRaises(kr.Fail) as ctx:
            kr.check_listener_owner_guard(self._env(), self._cfg())
        self.assertEqual(ctx.exception.code, 12)

    def test_wildcard_listener_fails_12(self):
        kr.proc_net_tcp = lambda: self.HEADER + self._row(
            "00000000:%04X" % self.PORT, "0A", self.INODE)
        with self.assertRaises(kr.Fail) as ctx:
            kr.check_listener_owner_guard(self._env(), self._cfg())
        self.assertEqual(ctx.exception.code, 12)

    def test_cgroup_mismatch_fails_12(self):
        # Substring/deeper-scope spoofing must not count as exact membership.
        kr.proc_cgroup = lambda pid: (
            "0::/system.slice/%s/rogue.service\n" % kr.EXPECTED_UNIT)
        with self.assertRaises(kr.Fail) as ctx:
            kr.check_listener_owner_guard(self._env(), self._cfg())
        self.assertEqual(ctx.exception.code, 12)
        kr.proc_cgroup = lambda pid: "0::/user.slice/session.slice\n"
        with self.assertRaises(kr.Fail) as ctx:
            kr.check_listener_owner_guard(self._env(), self._cfg())
        self.assertEqual(ctx.exception.code, 12)


class TestConfigValidation(EnsureReadyTestBase):
    def test_resolve_config_smoke(self):
        cfg = kr.resolve_config(self.env)
        self.assertTrue(cfg["test_mode"])
        self.assertEqual(cfg["hub"], HUB)
        self.assertEqual(cfg["hub_port"], 18280)

    def test_resolve_config_rejects_non_loopback(self):
        self.env[kr.ENV_HUB_BASE] = "http://10.1.2.3:18280"
        with self.assertRaises(kr.Fail) as ctx:
            kr.resolve_config(self.env)
        self.assertEqual(ctx.exception.code, 11)

    def test_instance_and_foreign_pure_helper(self):
        inst, foreign = kr.instances_target_and_foreign(
            [ready_instance(self.weights)],
            {"weights": self.weights})
        self.assertFalse(foreign)
        self.assertEqual(inst["status"], "READY")

    def test_build_post_payload_shape(self):
        payload = json.loads(kr.build_post_payload(
            {"weights": self.weights}).decode("utf-8"))
        self.assertEqual(payload["device"], kr.GPU_DEVICE)
        self.assertNotIn("token", payload)



class TestInstalledUnitContractSynthetic(EnsureReadyTestBase):
    """Exercise the installed-style ExecStartPost contract with mocked /proc.

    No systemd unit, network endpoint, real weights, or live hook is touched.
    """

    def setUp(self):
        super(TestInstalledUnitContractSynthetic, self).setUp()
        self.saved_constants = {}
        for name, value in (
            ("EXPECTED_EXE", self.exe),
            ("EXPECTED_EXE_SHA256", hashlib.sha256(
                open(self.exe, "rb").read()).hexdigest()),
            ("WEIGHTS_PATH", self.weights),
            ("MIN_FREE_DISK_BYTES", 0),
            ("MIN_MEM_AVAILABLE_BYTES", 0),
        ):
            self.saved_constants[name] = getattr(kr, name)
            setattr(kr, name, value)
        self.env = {
            "MAINPID": "4242",
            kr.ENV_UNIT: kr.EXPECTED_UNIT,
            "INVOCATION_ID": "fictional-systemd-invocation",
        }
        kr.proc_exe = lambda pid: self.exe if pid == "4242" else ""
        kr.proc_cgroup = lambda pid: (
            "0::/system.slice/%s\n" % kr.EXPECTED_UNIT)
        kr.proc_net_tcp = lambda: (
            " sl local_address remote_address st tx_queue:rx_queue "
            "tr:tm retrnsmt uid timeout inode\n"
            " 0: 0100007F:4768 00000000:0000 0A 00000000:00000000 "
            "00:00000000 00000000 0 0 5796352\n")
        kr.fd_links = lambda pid: ["socket:[5796352]"]
        kr._now = lambda: 0.0
        kr._sleep = lambda _: self.fail("unexpected sleep in READY path")

    def tearDown(self):
        for name, value in self.saved_constants.items():
            setattr(kr, name, value)
        super(TestInstalledUnitContractSynthetic, self).tearDown()

    def test_installed_style_ready_no_post(self):
        self.patch_client([models_registry(),
                           [ready_instance(self.weights)],
                           v1_models(["kokoro"])])
        reqs = self.run_ok()
        self.assertEqual([method for method, _, _ in reqs],
                         ["GET", "GET", "GET"])

    def test_missing_invocation_id_fails_before_http(self):
        self.env.pop("INVOCATION_ID")
        self.patch_client([])
        with self.assertRaises(kr.Fail) as ctx:
            kr.run(env=self.env)
        self.assertEqual(ctx.exception.code, 12)
        self.assertEqual(self.fake.requests, [])

    def test_wrong_socket_owner_fails_before_http(self):
        kr.fd_links = lambda pid: ["socket:[999]"]
        self.patch_client([])
        with self.assertRaises(kr.Fail) as ctx:
            kr.run(env=self.env)
        self.assertEqual(ctx.exception.code, 12)
        self.assertEqual(self.fake.requests, [])

    def test_test_mode_rejected_in_systemd_invocation(self):
        self.env[kr.ENV_TEST_MODE] = "1"
        self.patch_client([])
        with self.assertRaises(kr.Fail) as ctx:
            kr.run(env=self.env)
        self.assertEqual(ctx.exception.code, 11)
        self.assertEqual(self.fake.requests, [])

if __name__ == "__main__":
    unittest.main()
