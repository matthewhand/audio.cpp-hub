"""Offline synthetic tests for GTX startup policy; fake curl prevents model/network work."""
from __future__ import annotations
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BREEZE = ROOT / "docker" / "start-instance.sh"
SANO = ROOT / "start-sanotts-instance.sh"

FAKE_CURL = r"""#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$FAKE_CURL_LOG"
case " $* " in
  *"/api/models"*) printf '[]\n'; exit 0 ;;
  *"/api/instances"*)
    if [[ " $* " == *" -X POST "* ]]; then
      previous=""
      for arg in "$@"; do
        if [[ "$previous" == "--data-raw" ]]; then
          printf '%s\n' "$arg" > "$FAKE_START_PAYLOAD"
          printf '{"id":"test"}\n'
          exit 0
        fi
        previous="$arg"
      done
      exit 79
    fi
    if [[ "${FAKE_CREATE_INSTANCE:-0}" == 1 && ! -f "$FAKE_START_PAYLOAD" ]]; then
      printf '[]\n'
      exit 0
    fi
    printf '[{"id":"test","instanceName":"breeze-tts","status":"%s","port":18090}]\n' "${FAKE_INSTANCE_STATUS:-READY}"
    exit 0 ;;
  *"/v1/audio/speech"*)
    out=""
    previous=""
    for arg in "$@"; do
      if [[ "$previous" == "-o" ]]; then out="$arg"; fi
      previous="$arg"
    done
    [[ -n "$out" ]] || exit 76
    case "$FAKE_WARMUP_RESULT" in
      fail) exit 22 ;;
      good) printf 'RIFFsynthetic-wav' > "$out" ;;
      empty) : > "$out" ;;
      invalid) printf 'NOT_A_WAV' > "$out" ;;
      *) exit 77 ;;
    esac
    exit 0 ;;
esac
echo "unexpected synthetic curl: $*" >&2
exit 78
"""


class StartupWarmupPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="audio-startup-synthetic-")
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        bin_dir = self.dir / "bin"
        bin_dir.mkdir()
        curl = bin_dir / "curl"
        curl.write_text(FAKE_CURL)
        curl.chmod(0o755)
        fake_engine = self.dir / "audiocpp_server"
        fake_engine.write_text("#!/bin/sh\nexit 99\n")
        fake_engine.chmod(0o755)
        weights = self.dir / "dummy.gguf"
        weights.write_bytes(b"FAKE_NOT_A_MODEL")
        # Run the exact draft script with only its fixed warm-up WAV path
        # rewritten inside this temporary test copy. The production interface
        # must not accept an arbitrary path for rm -f.
        source = BREEZE.read_text()
        marker = 'WARMUP_WAV="/tmp/audio-cpp-hub-warmup.wav"'
        self.assertEqual(source.count(marker), 1)
        self.breeze_script = self.dir / "start-instance.sh"
        response_marker = '>/tmp/audio-cpp-hub-start.json'
        self.assertEqual(source.count(response_marker), 1)
        self.breeze_script.write_text(
            source.replace(marker, f'WARMUP_WAV="{self.dir / "warmup.wav"}"').replace(
                response_marker, f'>"{self.dir / "start-response.json"}"'
            )
        )
        self.start_payload = self.dir / "start-payload.json"
        self.calls = self.dir / "curl.log"
        # Do not inherit model/service aliases from a developer's terminal or
        # CI runner: synthetic instance IDs/status must be deterministic.
        aliases = {
            "MODEL_ID", "SERVICE_NAME", "WEIGHTS", "BACKEND", "DEVICE",
            "THREADS", "IDLE_UNLOAD_MS", "MIN_FREE_MEMORY_MB", "VOICE_REF", "EXECUTABLE_ID",
            "SERVER_BIN", "HUB_URL", "WARMUP_TEXT",
            "START_INSTANCE_WAIT_SECONDS", "FAKE_WARMUP_RESULT",
            "FAKE_INSTANCE_STATUS", "FAKE_CURL_LOG", "FAKE_CREATE_INSTANCE", "FAKE_START_PAYLOAD",
        }
        clean_env = {
            name: value for name, value in os.environ.items()
            if not name.startswith("AUDIOCPP_") and name not in aliases
        }
        self.env = {
            **clean_env,
            "PATH": str(bin_dir) + os.pathsep + os.environ.get("PATH", ""),
            "HUB_URL": "http://127.0.0.1:1",
            "AUDIOCPP_SERVER_BIN": str(fake_engine),
            "AUDIOCPP_WEIGHTS": str(weights),
            "FAKE_CURL_LOG": str(self.calls),
            "FAKE_START_PAYLOAD": str(self.start_payload),
            "FAKE_WARMUP_RESULT": "fail",
            "START_INSTANCE_WAIT_SECONDS": "1",
        }

    def run_script(self, script: Path | None = None, **overrides: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["bash", str(script or self.breeze_script)], env={**self.env, **overrides},
                              cwd=self.dir, capture_output=True, text=True, timeout=6)

    def call_log(self) -> str:
        return self.calls.read_text() if self.calls.exists() else ""

    def test_both_scripts_parse(self) -> None:
        for path in (BREEZE, SANO):
            with self.subTest(path=path):
                p = subprocess.run(["bash", "-n", str(path)], capture_output=True, text=True, timeout=3)
                self.assertEqual(p.returncode, 0, p.stderr)

    def test_default_remains_required(self) -> None:
        p = self.run_script()
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("Warm-up request failed", p.stderr)
        self.assertIn("/v1/audio/speech", self.call_log())
        self.assertIn("--max-time 300", self.call_log())

    def test_best_effort_does_not_hide_failed_instance(self) -> None:
        p = self.run_script(AUDIOCPP_WARMUP_POLICY="best-effort",
                            FAKE_INSTANCE_STATUS="FAILED")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("unexpected status", p.stderr)
        self.assertNotIn("/v1/audio/speech", self.call_log())

    def test_best_effort_failure_does_not_restart(self) -> None:
        p = self.run_script(AUDIOCPP_WARMUP_POLICY="best-effort")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("WARNING:", p.stderr)
        self.assertIn("--max-time 15", self.call_log())

    def test_best_effort_custom_bounded_timeout(self) -> None:
        p = self.run_script(AUDIOCPP_WARMUP_POLICY="best-effort", AUDIOCPP_WARMUP_MAX_SECONDS="5")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("--max-time 5", self.call_log())

    def test_invalid_best_effort_timeout_fails_before_network(self) -> None:
        for bad in ("0", "31", "abc", "1.5", "-1"):
            with self.subTest(bad=bad):
                self.calls.unlink(missing_ok=True)
                p = self.run_script(AUDIOCPP_WARMUP_POLICY="best-effort", AUDIOCPP_WARMUP_MAX_SECONDS=bad)
                self.assertNotEqual(p.returncode, 0)
                self.assertEqual(self.call_log(), "")
                self.assertIn("AUDIOCPP_WARMUP_MAX_SECONDS", p.stderr)

    def test_best_effort_empty_or_invalid_wav_nonfatal(self) -> None:
        for mode in ("empty", "invalid"):
            with self.subTest(mode=mode):
                p = self.run_script(AUDIOCPP_WARMUP_POLICY="best-effort", FAKE_WARMUP_RESULT=mode)
                self.assertEqual(p.returncode, 0, p.stderr)
                self.assertIn("WARNING:", p.stderr)

    def test_required_malformed_wav_fails(self) -> None:
        p = self.run_script(FAKE_WARMUP_RESULT="invalid")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("not a valid WAV", p.stderr)

    def test_required_valid_synthetic_wav_passes(self) -> None:
        p = self.run_script(FAKE_WARMUP_RESULT="good")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("Warm-up OK:", p.stderr)

    def test_skip_warmup_never_calls_speech(self) -> None:
        p = self.run_script(AUDIOCPP_WARMUP_POLICY="skip")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("warm-up skipped", p.stderr.lower())
        self.assertNotIn("/v1/audio/speech", self.call_log())

    def test_memory_guard_is_optional_numeric_and_honors_alias_precedence(self) -> None:
        cases = (
            ({}, None),
            ({"MIN_FREE_MEMORY_MB": ""}, None),
            ({"MIN_FREE_MEMORY_MB": "4096"}, 4096),
            ({"MIN_FREE_MEMORY_MB": "0"}, 0),
            ({"MIN_FREE_MEMORY_MB": "4096", "AUDIOCPP_MIN_FREE_MEMORY_MB": "8192"}, 8192),
            ({"MIN_FREE_MEMORY_MB": "4096", "AUDIOCPP_MIN_FREE_MEMORY_MB": ""}, 4096),
        )
        for settings, expected in cases:
            with self.subTest(settings=settings):
                self.start_payload.unlink(missing_ok=True)
                p = self.run_script(AUDIOCPP_WARMUP_POLICY="skip", FAKE_CREATE_INSTANCE="1", **settings)
                self.assertEqual(p.returncode, 0, p.stderr)
                body = json.loads(self.start_payload.read_text())
                self.assertEqual(body["modelId"], "breeze-tts")
                if expected is None:
                    self.assertNotIn("minFreeMemoryMb", body)
                else:
                    self.assertIs(type(body["minFreeMemoryMb"]), int)
                    self.assertEqual(body["minFreeMemoryMb"], expected)

    def test_invalid_memory_guard_fails_before_api_call(self) -> None:
        for bad in ("-1", "1.5", "01", "1e3", "4,\"name\":\"other\""):
            with self.subTest(bad=bad):
                self.calls.unlink(missing_ok=True)
                p = self.run_script(AUDIOCPP_WARMUP_POLICY="skip", MIN_FREE_MEMORY_MB=bad)
                self.assertNotEqual(p.returncode, 0)
                self.assertIn("MIN_FREE_MEMORY_MB", p.stderr)
                self.assertEqual(self.call_log(), "")

    def test_hub_only_skips_both_helpers_and_all_network(self) -> None:
        for path in (self.breeze_script, SANO):
            with self.subTest(path=path):
                self.calls.unlink(missing_ok=True)
                p = self.run_script(path, AUDIOCPP_STARTUP_MODE="hub-only",
                                    AUDIOCPP_WEIGHTS="", AUDIOCPP_SERVER_BIN="/missing/bin")
                self.assertEqual(p.returncode, 0, p.stderr)
                self.assertIn("Hub-only", p.stderr)
                self.assertEqual(self.call_log(), "")

    def test_invalid_startup_mode_fails_sano_before_network(self) -> None:
        p = self.run_script(SANO, AUDIOCPP_STARTUP_MODE="mistyped")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("Invalid AUDIOCPP_STARTUP_MODE", p.stderr)
        self.assertEqual(self.call_log(), "")

    def test_source_does_not_accept_arbitrary_warmup_delete_path(self) -> None:
        self.assertNotIn("AUDIOCPP_WARMUP_WAV", BREEZE.read_text())
        self.assertIn('WARMUP_WAV="/tmp/audio-cpp-hub-warmup.wav"', BREEZE.read_text())

    def test_invalid_startup_mode_fails_breeze_before_network(self) -> None:
        p = self.run_script(AUDIOCPP_STARTUP_MODE="anything-else")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("Invalid AUDIOCPP_STARTUP_MODE", p.stderr)
        self.assertEqual(self.call_log(), "")


if __name__ == "__main__":
    unittest.main()
