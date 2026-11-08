"""AMD Vulkan transcription worker for audio.cpp-hub."""
import argparse
import audioop
from array import array
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, HTTPServer
import io
import json
import os
from pathlib import Path
import sys
import time
import wave

MAX_BODY = 50 * 1024 * 1024
MAX_AUDIO_SECONDS = 120
FAMILIES = {"superwhisper_lite", "superwhisper_cohere"}


def load_runtime():
    library = os.environ.get("TRANSCRIBE_LIBRARY")
    if os.name == "nt" and library:
        with os.add_dll_directory(str(Path(library).resolve().parent)):
            import transcribe_cpp
    else:
        import transcribe_cpp
    return transcribe_cpp


def amd_devices(runtime):
    return {
        int(device.name.removeprefix("Vulkan")): device
        for device in runtime.backends()
        if device.kind == "vulkan"
        and device.name.removeprefix("Vulkan").isdigit()
        and any(vendor in device.description.lower() for vendor in ("amd", "radeon"))
    }


def read_pcm(source):
    with wave.open(source, "rb") as wav:
        rate = wav.getframerate()
        frames = wav.getnframes()
        channels = wav.getnchannels()
        if wav.getsampwidth() != 2 or channels not in (1, 2):
            raise ValueError("需要单声道或立体声 PCM16 WAV")
        if not 8000 <= rate <= 192000 or not 0 < frames <= MAX_AUDIO_SECONDS * rate:
            raise ValueError("音频采样率或时长超出限制")
        raw = wav.readframes(frames)
        if len(raw) != frames * channels * 2:
            raise ValueError("WAV 数据不完整")
    if channels == 2:
        raw = audioop.tomono(raw, 2, 0.5, 0.5)
    if rate != 16000:
        raw, _ = audioop.ratecv(raw, 2, 1, rate, 16000, None)
    samples = array("h", raw)
    if sys.byteorder == "big":
        samples.byteswap()
    return array("f", (sample / 32768 for sample in samples))


def multipart_audio(content_type, body):
    envelope = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("ascii")
    message = BytesParser(policy=policy.default).parsebytes(envelope + body)
    if not message.is_multipart():
        raise ValueError("需要 multipart/form-data")
    parts = {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if name not in ("file", "model", "language"):
            continue
        if name in parts:
            raise ValueError("表单字段重复")
        parts[name] = part.get_payload(decode=True)
    return parts["model"].decode(), parts["file"], parts.get("language", b"").decode()


def make_handler(session, name, device, uploads):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            self.request.settimeout(15)
            super().setup()

        def send_json(self, status, result):
            body = json.dumps(result, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/health":
                self.send_json(200, {"status": "ok", "backend": "vulkan", "device": device.description})
            else:
                self.send_json(404, {"error": {"message": "未知端点"}})

        def do_POST(self):
            if self.path not in ("/v1/tasks/run", "/v1/audio/transcriptions"):
                return self.send_json(404, {"error": {"message": "未知端点"}})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_BODY:
                    return self.send_json(413, {"error": {"message": "请求体超出限制"}})
                body = self.rfile.read(length)
                if len(body) != length:
                    raise ValueError("请求体不完整")
                if self.path == "/v1/tasks/run":
                    payload = json.loads(body)
                    model = payload["model"]
                    request = payload["request"]
                    path = Path(request["audio"]).resolve()
                    if not path.is_relative_to(uploads) or not path.is_file() or path.stat().st_size > MAX_BODY:
                        raise ValueError("请先通过 Hub 上传 WAV")
                    source = str(path)
                    language = request.get("language")
                else:
                    model, wav, language = multipart_audio(self.headers.get("Content-Type", ""), body)
                    source = io.BytesIO(wav)
                if model != name:
                    raise ValueError("模型实例名称不匹配")
                if language is not None and not isinstance(language, str):
                    raise ValueError("language 必须为字符串")
                pcm = read_pcm(source)
            except (ValueError, KeyError, TypeError, AttributeError, EOFError, OSError, wave.Error) as error:
                return self.send_json(400, {"error": {"message": str(error)}})
            started = time.perf_counter()
            try:
                result = session.run(pcm, **({"language": language} if language not in (None, "", "auto") else {}))
            except RuntimeError as error:
                print(f"Transcription failed: {error}", file=sys.stderr, flush=True)
                return self.send_json(502, {"error": {"message": "AMD Vulkan 转写失败"}})
            self.send_json(200, {"text": result.text, "timing": {"inference_ms": round((time.perf_counter() - started) * 1000, 2)}})

    return Handler


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--config", type=Path)
    mode.add_argument("--list-devices", action="store_true")
    args = parser.parse_args()
    runtime = load_runtime()
    devices = amd_devices(runtime)
    if args.list_devices:
        for index, device in devices.items():
            description = device.description.replace('"', "'").replace("\n", " ")
            print(f'vulkan:{index} "{description}" [{device.device_type}]')
        return

    config = json.loads(args.config.read_text(encoding="utf-8"))
    model_config, = config["models"]
    if config.get("backend") != "vulkan" or model_config["family"] not in FAMILIES:
        parser.error("Superwhisper requires AMD Vulkan")
    # The Windows AMD flash path can repeat unknown tokens in Cohere.
    # Use the regular Vulkan attention kernels for this worker process.
    if os.name == "nt" and model_config["family"] == "superwhisper_cohere":
        os.environ["TRANSCRIBE_NO_FLASH"] = "1"
    index = config.get("device")
    if index is None and len(devices) == 1:
        index = next(iter(devices))
    if index not in devices:
        parser.error("Select an available AMD Vulkan device")
    device = devices[index]
    minimum = config.get("min_free_memory_mb", 0) * 1024 * 1024
    if minimum and device.memory_free < minimum:
        parser.error("Insufficient free AMD GPU memory")
    uploads = (Path.cwd() / "data" / "uploads").resolve()
    with runtime.Model(model_config["path"], device=device) as model:
        if model.device != device:
            raise RuntimeError("Runtime did not select the requested AMD Vulkan device")
        print(f"Superwhisper using {device.name} {device.description}", flush=True)
        with model.session(n_threads=config.get("threads", 1)) as session:
            with HTTPServer(("127.0.0.1", config["port"]), make_handler(session, model_config["id"], device, uploads)) as server:
                server.serve_forever()


if __name__ == "__main__":
    main()
