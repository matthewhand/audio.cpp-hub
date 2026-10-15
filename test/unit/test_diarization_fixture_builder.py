"""Fast model-free failure-path tests for the diarization fixture builder."""
import importlib.util
import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock

BUILDER = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "build-diarization-fixtures.py"
SPEC = importlib.util.spec_from_file_location("diarization_fixture_builder", BUILDER)
BUILDER_MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER_MODULE)


class FixtureBuilderErrors(unittest.TestCase):
    def test_missing_source_is_actionable_and_does_not_create_destination(self):
        with tempfile.TemporaryDirectory() as root:
            directory = pathlib.Path(root)
            output = directory / "outputs"
            with self.assertRaisesRegex(FileNotFoundError, "Source WAV does not exist"):
                BUILDER_MODULE.build(directory / "missing.wav", output)
            self.assertFalse(output.exists())

    def test_ffmpeg_absent_is_actionable(self):
        with mock.patch.object(BUILDER_MODULE.subprocess, "run", side_effect=FileNotFoundError()):
            with self.assertRaisesRegex(RuntimeError, "ffmpeg is not installed"):
                BUILDER_MODULE.audio_bytes(pathlib.Path("/unused.wav"))

    def test_ffmpeg_failure_contains_safe_bounded_diagnostic(self):
        error = subprocess.CalledProcessError(1, ["ffmpeg"], stderr=b"Invalid input data")
        with mock.patch.object(BUILDER_MODULE.subprocess, "run", side_effect=error):
            with self.assertRaisesRegex(RuntimeError, "ffmpeg exited 1.*Invalid input data"):
                BUILDER_MODULE.audio_bytes(pathlib.Path("/unused.wav"))

    def test_ffmpeg_timeout_is_actionable(self):
        with mock.patch.object(
            BUILDER_MODULE.subprocess, "run",
            side_effect=subprocess.TimeoutExpired(["ffmpeg"], 15),
        ):
            with self.assertRaisesRegex(RuntimeError, "15-second conversion limit"):
                BUILDER_MODULE.audio_bytes(pathlib.Path("/unused.wav"))

    def test_empty_pcm_output_rejected(self):
        with mock.patch.object(
            BUILDER_MODULE.subprocess, "run",
            return_value=subprocess.CompletedProcess(["ffmpeg"], 0, stdout=b"", stderr=b""),
        ):
            with self.assertRaisesRegex(RuntimeError, "no valid 16-bit PCM"):
                BUILDER_MODULE.audio_bytes(pathlib.Path("/unused.wav"))


if __name__ == "__main__":
    unittest.main()
