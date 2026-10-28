import json
import os
import sys
import threading
import tempfile
import unittest
from http.server import HTTPServer, BaseHTTPRequestHandler

# Add clients/ to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "clients"))
import audiocpp_client as client


class MockHubHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # suppress console logging

    def do_GET(self):
        if self.path == "/v1/models":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"data": [{"id": "breeze"}, {"id": "sanotts"}]}).encode())
        elif self.path == "/api/instances":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps([
                {"id": "inst-1", "instanceName": "citrinet", "status": "READY"},
                {"id": "inst-2", "instanceName": "breeze", "status": "READY"},
            ]).encode())
        elif self.path == "/farm/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "hubs": []}).encode())
        elif self.path == "/api/voices":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps([{"vid": "v1", "name": "Alice"}]).encode())
        elif self.path == "/api/history/breeze":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps([{"taskId": "t1", "text": "hello"}]).encode())
        elif self.path == "/api/history/breeze/t1":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"taskId": "t1", "text": "hello", "request": {}}).encode())
        elif self.path == "/api/tasks/task-123":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"id": "task-123", "status": "DONE"}).encode())
        elif self.path == "/api/tasks/task-123/result":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"text": "transcribed speech"}).encode())
        elif self.path == "/api/tasks/task-failed":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"id": "task-failed", "status": "FAILED", "error": "inference error"}).encode())
        else:
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": {"message": "not found"}}).encode())

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        data = self.rfile.read(length) if length > 0 else b""

        if self.path == "/v1/audio/speech":
            body = json.loads(data.decode()) if data else {}
            if body.get("input") == "fail":
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": {"message": "invalid input"}}).encode())
                return
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("X-Fanout-Hub", "http://127.0.0.1:18080")
            self.send_header("X-Fanout-Instance", "breeze")
            self.end_headers()
            self.wfile.write(b"RIFFmockwavdata")
        elif self.path == "/api/audio/upload":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"id": "upload-999", "path": "/data/uploads/upload-999.wav"}).encode())
        elif self.path == "/api/tasks":
            body = json.loads(data.decode()) if data else {}
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            inst = body.get("instanceId", "")
            if inst == "inst-fail":
                self.wfile.write(json.dumps({"id": "task-failed", "status": "QUEUED"}).encode())
            else:
                self.wfile.write(json.dumps({"id": "task-123", "status": "QUEUED"}).encode())
        else:
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": {"message": "not found"}}).encode())


class TestAudioCppClient(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), MockHubHandler)
        cls.port = cls.server.server_port
        cls.base_url = f"http://127.0.0.1:{cls.port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever)
        cls.thread.daemon = True
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def test_hub_error_str(self):
        err = client.HubError(404, "missing resource")
        self.assertEqual(err.status, 404)
        self.assertIn("HTTP 404: missing resource", str(err))

    def test_discovery(self):
        # models
        m = client.models(hub=self.base_url)
        self.assertEqual(m, ["breeze", "sanotts"])

        # instances
        insts = client.instances(hub=self.base_url)
        self.assertEqual(len(insts), 2)
        self.assertEqual(insts[0]["instanceName"], "citrinet")

        # instance_id
        iid = client.instance_id("citrinet", hub=self.base_url)
        self.assertEqual(iid, "inst-1")

        with self.assertRaises(client.HubError) as ctx:
            client.instance_id("unknown_service", hub=self.base_url)
        self.assertEqual(ctx.exception.status, 404)

        # farm_health
        health = client.farm_health(hub=self.base_url)
        self.assertEqual(health.get("status"), "ok")

    def test_speech_and_speak(self):
        # speech_with_origin
        wav, headers = client.speech_with_origin(
            "Hello world",
            model="breeze",
            instruction="clear voice",
            seed=42,
            temperature=0.7,
            voice_ref="/path/to/ref.wav",
            reference_text="hello ref",
            extra_options={"speed": 1.0},
            hub=self.base_url,
        )
        self.assertEqual(wav, b"RIFFmockwavdata")
        self.assertEqual(headers.get("X-Fanout-Instance"), "breeze")

        # speech helper
        wav2 = client.speech("Hello world", model="breeze", hub=self.base_url)
        self.assertEqual(wav2, b"RIFFmockwavdata")

        # speech error
        with self.assertRaises(client.HubError) as ctx:
            client.speech("fail", model="breeze", hub=self.base_url)
        self.assertEqual(ctx.exception.status, 400)
        self.assertIn("invalid input", str(ctx.exception))

        # speak to file
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            tmp_path = f.name
        try:
            client.speak(tmp_path, "Hello", model="breeze", hub=self.base_url)
            with open(tmp_path, "rb") as f:
                content = f.read()
            self.assertEqual(content, b"RIFFmockwavdata")
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

    def test_voice_sweep(self):
        instructions = ["dry", "warm"]
        seeds = [1, 2]
        with tempfile.TemporaryDirectory() as tmp_dir:
            results = client.voice_sweep("Test", instructions, seeds=seeds, outdir=tmp_dir, hub=self.base_url)
            self.assertEqual(len(results), 4)
            for item in results:
                self.assertIn(item["instruction"], instructions)
                self.assertIn(item["seed"], seeds)
                self.assertTrue(os.path.exists(item["path"]))

    def test_upload_and_transcribe(self):
        # upload
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(b"RIFFtest")
            tmp_path = f.name
        try:
            res = client.upload_wav(tmp_path, hub=self.base_url)
            self.assertEqual(res.get("id"), "upload-999")

            # transcribe with upload
            old_interval = client.POLL_INTERVAL
            client.POLL_INTERVAL = 0.05
            try:
                task = client.transcribe(tmp_path, service="citrinet", hub=self.base_url, upload=True)
                self.assertEqual(task.get("status"), "DONE")
                self.assertEqual(task.get("id"), "task-123")
            finally:
                client.POLL_INTERVAL = old_interval
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

    def test_transcribe_failure(self):
        old_interval = client.POLL_INTERVAL
        client.POLL_INTERVAL = 0.05
        try:
            task = client.transcribe(
                "/remote/audio.wav",
                service="citrinet",
                hub=self.base_url,
                upload=False,
            )
            self.assertEqual(task.get("status"), "DONE")
        finally:
            client.POLL_INTERVAL = old_interval

    def test_voices_and_history(self):
        # voices
        v = client.voices(hub=self.base_url)
        self.assertEqual(len(v), 1)
        self.assertEqual(v[0]["name"], "Alice")

        # history list
        h = client.history(model="breeze", hub=self.base_url)
        self.assertEqual(len(h), 1)
        self.assertEqual(h[0]["taskId"], "t1")

        # history record
        rec = client.history_record("t1", model="breeze", hub=self.base_url)
        self.assertEqual(rec["taskId"], "t1")


if __name__ == "__main__":
    unittest.main()
