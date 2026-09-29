#!/usr/bin/env python3
"""audiocpp_client.py — stdlib-only client for the audio.cpp-hub LAN service.

Zero dependencies (uses urllib). Provides:
  - speech():        text -> WAV bytes (voice design via `instruction`/`seed`)
  - speak():         speech() + write to file
  - transcribe():    audio file -> text (upload if needed, async task API)
  - voice_sweep():   generate a variety of voice designs (instruction x seed grid)
  - voices():        list registered voice-library entries (usable as voice_ref)
  - history():       browse archived generations (with exact request params)
  - CLI:             say / stt / sweep / voices / history subcommands

Service base URL defaults to http://127.0.0.1:18080; override with
AUDIOCPP_HUB_URL or --hub (LAN host example: http://10.0.0.36:18080).

The hub is a LAN-only, unauthenticated service — keep it off the public internet.
"""

from __future__ import annotations

import argparse
import base64  # noqa: F401  (kept for parity with docs; STT uses server-side paths)
import json
import sys
import time
import urllib.error
import urllib.request
import uuid
import wave

DEFAULT_HUB = "http://127.0.0.1:18080"
POLL_INTERVAL = 0.5
POLL_TIMEOUT = 600


class HubError(RuntimeError):
    """API/proxy error returned by the hub."""

    def __init__(self, status: int, message: str):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status


def _request(hub: str, path: str, body=None, raw: bytes | None = None,
             method: str | None = None, ctype: str = "application/json",
             timeout: int = 60):
    url = hub.rstrip("/") + path
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"),
                                 headers={"Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        try:
            detail = json.loads(detail).get("error", {})
            detail = detail.get("message") or json.dumps(detail)
        except Exception:
            pass
        raise HubError(e.code, detail) from None
    return payload


def _json(hub: str, path: str, body=None, method: str | None = None, timeout: int = 60):
    payload = _request(hub, path, body=body, method=method, timeout=timeout)
    return json.loads(payload or b"null")


# --------------------------------------------------------------------------- #
# Discovery
# --------------------------------------------------------------------------- #

def instances(hub: str = DEFAULT_HUB) -> list[dict]:
    return _json(hub, "/api/instances")


def instance_id(name: str, hub: str = DEFAULT_HUB) -> str:
    for inst in instances(hub):
        if inst.get("instanceName") == name:
            return inst["id"]
    raise HubError(404, f"no instance with service name {name!r} (is it READY?)")


def models(hub: str = DEFAULT_HUB) -> list[str]:
    out = _json(hub, "/v1/models")
    return [m["id"] for m in out.get("data", [])]


# --------------------------------------------------------------------------- #
# TTS — voice design
# --------------------------------------------------------------------------- #

def speech(text: str, model: str = "breeze", *, instruction: str | None = None,
           seed: int | None = None, temperature: float | None = None,
           voice_ref: str | None = None, reference_text: str | None = None,
           extra_options: dict | None = None, hub: str = DEFAULT_HUB,
           timeout: int = 600) -> bytes:
    """Generate speech; returns raw WAV bytes (synchronous /v1/audio/speech).

    voice_ref/reference_text are TOP-LEVEL body fields (engine contract), not
    options entries — the engine rejects unknown keys inside options.
    """
    options = dict(extra_options or {})
    if instruction is not None:
        options["instruction"] = instruction
    if temperature is not None:
        options["temperature"] = temperature
    body = {"model": model, "input": text, "response_format": "wav"}
    if seed is not None:
        body["seed"] = seed
    if voice_ref is not None:
        body["voice_ref"] = voice_ref
    if reference_text is not None:
        body["reference_text"] = reference_text
    if options:
        body["options"] = options
    return _request(hub, "/v1/audio/speech", body=body, timeout=timeout)


def speak(path: str, text: str, **kwargs) -> str:
    """Generate speech and write it to `path`; returns the path."""
    wav = speech(text, **kwargs)
    with open(path, "wb") as f:
        f.write(wav)
    return path


def upload_wav(path_or_bytes, hub: str = DEFAULT_HUB) -> dict:
    """Upload WAV bytes (or a file path) for server-side use; returns info with 'path'."""
    raw = open(path_or_bytes, "rb").read() if isinstance(path_or_bytes, str) else path_or_bytes
    return json.loads(_request(hub, "/api/audio/upload", raw=raw, ctype="audio/wav"))


# --------------------------------------------------------------------------- #
# STT — speech to text (async task API; `audio` = server-side path, NOT base64)
# --------------------------------------------------------------------------- #

def transcribe(audio: str, *, hub: str = DEFAULT_HUB, service: str = "citrinet",
               upload: bool = False, wait: bool = True,
               timeout: int = POLL_TIMEOUT) -> dict:
    """Transcribe audio.

    `audio` is a server-side WAV path, or a local file path when upload=True
    (uploaded via /api/audio/upload first). Returns the final task dict
    (`text` holds the transcript) when wait=True, else the submitted task.
    """
    path = audio
    if upload:
        path = upload_wav(audio, hub)["path"]
    t = _json(hub, "/api/tasks", {"instanceId": instance_id(service, hub),
                                  "request": {"audio": path}})
    if not wait:
        return t
    deadline = time.time() + timeout
    while time.time() < deadline:
        s = _json(hub, f"/api/tasks/{t['id']}")
        if s["status"] in ("DONE", "FAILED", "CANCELLED"):
            return s
        time.sleep(POLL_INTERVAL)
    raise TimeoutError(f"task {t['id']} did not finish in {timeout}s")


# --------------------------------------------------------------------------- #
# Voice-design variety sweep
# --------------------------------------------------------------------------- #

def voice_sweep(text: str, instructions: list[str], seeds=(0, 1, 2),
                model: str = "breeze", outdir: str = ".", *,
                temperatures=(0.9,), hub: str = DEFAULT_HUB, **speech_kw) -> list[dict]:
    """Generate a grid of voice designs: instruction x temperature x seed.

    Filenames: <outdir>/sweep_<slug>_t<temp>_s<seed>.wav
    Returns [{path, instruction, temperature, seed}] for downstream scoring.
    """
    results = []
    slug_base = uuid.uuid4().hex[:6]
    for i, instr in enumerate(instructions):
        slug = f"{i:02d}_{''.join(c if c.isalnum() else '_' for c in instr.lower())[:24]}"
        for temp in temperatures:
            for seed in seeds:
                path = f"{outdir.rstrip('/')}/sweep_{slug_base}_{slug}_t{temp}_s{seed}.wav"
                speak(path, text, model=model, instruction=instr, seed=seed,
                      temperature=temp, hub=hub, **speech_kw)
                results.append({"path": path, "instruction": instr,
                                "temperature": temp, "seed": seed})
                print(f"[sweep] {path}")
    return results


def wav_duration(path: str) -> float:
    with wave.open(path) as w:
        return w.getnframes() / w.getframerate()


# --------------------------------------------------------------------------- #
# Voice library + history (provenance)
# --------------------------------------------------------------------------- #

def voices(hub: str = DEFAULT_HUB) -> list[dict]:
    """Registered reference voices (use entries' paths as voice_ref for cloning)."""
    return _json(hub, "/api/voices")


def history(model: str = "breeze", hub: str = DEFAULT_HUB) -> list[dict]:
    """Archived generations, newest first (ids + truncated text)."""
    return _json(hub, f"/api/history/{model}")


def history_record(task_id: str, model: str = "breeze", hub: str = DEFAULT_HUB) -> dict:
    """Full record of one generation, incl. the exact request (instruction, seed...)."""
    return _json(hub, f"/api/history/{model}/{task_id}")


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def _main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--hub", default=None, help="hub base URL (default $AUDIOCPP_HUB_URL or 127.0.0.1:18080)")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("say", help="generate speech to a file")
    s.add_argument("text")
    s.add_argument("-o", "--out", default="out.wav")
    s.add_argument("-m", "--model", default="breeze")
    s.add_argument("--instruction")
    s.add_argument("--seed", type=int)
    s.add_argument("--temperature", type=float)
    s.add_argument("--voice-ref", help="server-side WAV path for voice cloning")
    s.add_argument("--reference-text", help="transcript of the reference clip (required when cloning)")

    t = sub.add_parser("stt", help="transcribe a WAV")
    t.add_argument("audio", help="local or server-side WAV path")
    t.add_argument("--upload", action="store_true", help="audio is a local file; upload it first")

    w = sub.add_parser("sweep", help="generate a variety of voice designs")
    w.add_argument("text")
    w.add_argument("--instructions", nargs="+", required=True)
    w.add_argument("--seeds", type=int, nargs="+", default=[0, 1, 2])
    w.add_argument("--temperatures", type=float, nargs="+", default=[0.9])
    w.add_argument("-d", "--outdir", default=".")
    w.add_argument("-m", "--model", default="breeze")

    sub.add_parser("voices", help="list voice-library entries")
    h = sub.add_parser("history", help="list archived generations")
    h.add_argument("-m", "--model", default="breeze")

    a = p.parse_args(argv)
    hub = a.hub or __import__("os").environ.get("AUDIOCPP_HUB_URL", DEFAULT_HUB)

    if a.cmd == "say":
        path = speak(a.out, a.text, model=a.model, instruction=a.instruction,
                     seed=a.seed, temperature=a.temperature, voice_ref=a.voice_ref,
                     reference_text=a.reference_text, hub=hub)
        print(f"{path} ({wav_duration(path):.2f}s)")
    elif a.cmd == "stt":
        task = transcribe(a.audio, hub=hub, upload=a.upload)
        if task["status"] != "DONE":
            sys.exit(f"task {task['id']} ended as {task['status']}: {task.get('error')}")
        print(task.get("text", ""))
    elif a.cmd == "sweep":
        for r in voice_sweep(a.text, a.instructions, seeds=a.seeds,
                             temperatures=a.temperatures, outdir=a.outdir,
                             model=a.model, hub=hub):
            print(json.dumps(r, ensure_ascii=False))
    elif a.cmd == "voices":
        for v in voices(hub):
            print(f"{v['id']}: {v['name']}" + (f"  [{v.get('text','')}]" if v.get("text") else ""))
    elif a.cmd == "history":
        for r in history(a.model, hub):
            print(f"{r.get('id')}: {r.get('text','')}")


if __name__ == "__main__":
    _main()
