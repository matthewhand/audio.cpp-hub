#!/usr/bin/env python3
"""audiocpp_client.py — stdlib-only client for the audio.cpp-hub LAN service.

Zero dependencies (uses urllib). Provides:
  - speech():        text -> WAV bytes (voice design via `instruction`/`seed`)
  - speak():         speech() + write to file
  - transcribe():    audio file -> text (upload if needed, async task API)
  - voice_sweep():   generate a variety of voice designs (instruction x seed grid)
  - voices():        list registered voice-library entries (usable as voice_ref)
  - history():       browse archived generations (with exact request params)
  - models():        list ready fan-out aliases (or hub service names)
  - farm_health():   per-hub up/down + which backend each alias resolved to
  - CLI:             say / stt / sweep / voices / history / health / models

TWO base URLs, because the LAN fan-out proxy (docs/farm.md) does not proxy
everything. Both default to the farm on 10.0.0.36:

  1. DEFAULT_HUB = http://10.0.0.36:18082 — the fan-out. One URL for the whole
     farm with automatic failover; serve TTS and discovery through it.
       GET  /v1/models, POST /v1/audio/speech, GET /api/instances,
       GET  /farm/health
     `model` is a farm alias, not a host service name: `breeze`/`expressive`,
     `qwen3-vd`/`voice-design-fast`, `sanotts`/`instant`, `citrinet`/`stt`.
     Override with AUDIOCPP_HUB_URL or --hub.

  2. DEFAULT_DIRECT_HUB = http://10.0.0.36:18080 — a real hub, for the endpoints
     the fan-out does not proxy (/api/audio/upload, /api/voices, /api/history/*):
     every hub keeps its own state, so these always talk to one host.
     STT is sent here too, on purpose: it keeps upload + task on one host, and
     the fan-out's /api/tasks needs a per-read ?hub= pin anyway (see
     docs/agent-api.md §2 for the fan-out STT shape).
     Override with AUDIOCPP_DIRECT_HUB_URL or --direct-hub.

Local development: a hub running on this machine serves both roles, so point
both URLs at it —
  --hub http://127.0.0.1:18080 --direct-hub http://127.0.0.1:18080
— or export AUDIOCPP_HUB_URL / AUDIOCPP_DIRECT_HUB_URL to the same value. The
two are independent on purpose: a fan-out URL is never a valid --direct-hub.

Examples:
  # TTS through the fan-out, printing which hub actually served the take
  ./audiocpp_client.py say "Oh, brilliant." -m expressive \
      --instruction "dry sarcastic female" -o out.wav
  # 12.4s -> out.wav; [fanout] http://10.0.0.36:18080 (stderr)

  from audiocpp_client import speech_with_origin, history_record
  wav, headers = speech_with_origin("...", model="instant")
  origin = headers.get("X-Fanout-Hub", "http://10.0.0.36:18080")
  takes = history_record(task_id, model="breeze-tts", hub=origin)

  # STT is hub-only: goes to the direct hub's async task API
  ./audiocpp_client.py --direct-hub http://10.0.0.36:18080 stt sample.wav --upload

  # Which backends are alive right now
  ./audiocpp_client.py health

Hub and fan-out are LAN-only, unauthenticated services — keep them off the
public internet.
"""

from __future__ import annotations

import argparse
import base64  # noqa: F401  (kept for parity with docs; STT uses server-side paths)
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
import wave

# Farm entrypoint: the LAN fan-out proxy, one URL for every host + failover.
DEFAULT_HUB = "http://10.0.0.36:18082"
# A single real hub, for the routes the fan-out does not proxy (STT/tasks,
# upload, voices, history). Swap in another host for that host's state.
DEFAULT_DIRECT_HUB = "http://10.0.0.36:18080"
# Local development: a hub on this machine answers both roles.
LOCAL_HUB = "http://127.0.0.1:18080"
POLL_INTERVAL = 0.5
POLL_TIMEOUT = 600


class HubError(RuntimeError):
    """API/proxy error returned by the hub or the fan-out proxy."""

    def __init__(self, status: int, message: str):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status


def _request_full(hub: str, path: str, body=None, raw: bytes | None = None,
                  method: str | None = None, ctype: str = "application/json",
                  timeout: int = 60) -> tuple[bytes, dict]:
    """One HTTP round trip; returns (payload, response headers).

    The headers matter against the fan-out: X-Fanout-Hub / X-Fanout-Instance
    name the hub that served a take, which is where that take is archived.
    """
    url = hub.rstrip("/") + path
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"),
                                 headers={"Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = resp.read()
            headers = dict(resp.headers.items())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        try:
            detail = json.loads(detail).get("error", {})
            detail = detail.get("message") or json.dumps(detail)
        except Exception:
            pass
        raise HubError(e.code, detail) from None
    return payload, headers


def _request(hub: str, path: str, body=None, raw: bytes | None = None,
             method: str | None = None, ctype: str = "application/json",
             timeout: int = 60) -> bytes:
    return _request_full(hub, path, body=body, raw=raw, method=method,
                         ctype=ctype, timeout=timeout)[0]


def _json(hub: str, path: str, body=None, method: str | None = None, timeout: int = 60):
    payload = _request(hub, path, body=body, method=method, timeout=timeout)
    return json.loads(payload or b"null")


# --------------------------------------------------------------------------- #
# Discovery
# --------------------------------------------------------------------------- #

def instances(hub: str = DEFAULT_HUB) -> list[dict]:
    """Instances across the farm (fan-out) or on one hub.

    The fan-out tags each entry with `hub` / `hubLabel`. `id` is hub-local, so
    it is only usable against that same hub — see instance_id().
    """
    return _json(hub, "/api/instances")


def instance_id(name: str, hub: str = DEFAULT_DIRECT_HUB) -> str:
    """Resolve a hub-side service name (e.g. `citrinet`) to that hub's task id.

    Hub-local by construction: instance ids mean nothing outside the hub that
    issued them, which is also why the fan-out pins task reads with ?hub=.
    """
    for inst in instances(hub):
        if inst.get("instanceName") == name:
            return inst["id"]
    raise HubError(404, f"no instance with service name {name!r} on {hub} (is it READY?)")


def models(hub: str = DEFAULT_HUB) -> list[str]:
    """Ready model ids — fan-out aliases by default, hub service names on a hub."""
    out = _json(hub, "/v1/models")
    return [m["id"] for m in out.get("data", [])]


def farm_health(hub: str = DEFAULT_HUB, timeout: int = 20) -> dict:
    """`GET /farm/health`: per-hub up/down + latency, and each alias' backend.

    Fan-out only; hubs have no such route, so pointing this at a hub raises a
    HubError that says so instead of a bare 404.
    """
    try:
        return _json(hub, "/farm/health", timeout=timeout)
    except HubError as e:
        if e.status == 404:
            raise HubError(404, f"{hub} does not serve /farm/health — that route is on the "
                                f"fan-out proxy (default {DEFAULT_HUB})") from None
        raise


# --------------------------------------------------------------------------- #
# TTS — voice design (fan-out by default: one URL for the farm, with failover)
# --------------------------------------------------------------------------- #

def speech_with_origin(text: str, model: str = "breeze", *, instruction: str | None = None,
                       seed: int | None = None, temperature: float | None = None,
                       voice_ref: str | None = None, reference_text: str | None = None,
                       extra_options: dict | None = None, hub: str = DEFAULT_HUB,
                       timeout: int = 600) -> tuple[bytes, dict]:
    """Like speech(), but also returns the response headers.

    Against the fan-out those carry `X-Fanout-Hub` / `X-Fanout-Instance`; feed
    the hub back to history_record() to fetch the archived take. `model` is a
    farm alias there (`breeze`, `expressive`, `instant`, `sanotts`, ...), not a
    `host:port:service` triple.
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
    return _request_full(hub, "/v1/audio/speech", body=body, timeout=timeout)


def speech(text: str, model: str = "breeze", *, instruction: str | None = None,
           seed: int | None = None, temperature: float | None = None,
           voice_ref: str | None = None, reference_text: str | None = None,
           extra_options: dict | None = None, hub: str = DEFAULT_HUB,
           timeout: int = 600) -> bytes:
    """Generate speech; returns raw WAV bytes (synchronous /v1/audio/speech).

    voice_ref/reference_text are TOP-LEVEL body fields (engine contract), not
    options entries — the engine rejects unknown keys inside options.
    """
    return speech_with_origin(text, model, instruction=instruction, seed=seed,
                              temperature=temperature, voice_ref=voice_ref,
                              reference_text=reference_text,
                              extra_options=extra_options, hub=hub, timeout=timeout)[0]


def speak(path: str, text: str, **kwargs) -> str:
    """Generate speech and write it to `path`; returns the path."""
    wav = speech(text, **kwargs)
    with open(path, "wb") as f:
        f.write(wav)
    return path


def upload_wav(path_or_bytes, hub: str = DEFAULT_DIRECT_HUB) -> dict:
    """Upload WAV bytes (or a file path) for server-side use; returns info with 'path'.

    Hub-only route: the uploaded path is meaningful on that hub alone, so this
    takes a direct hub, never the fan-out.
    """
    raw = open(path_or_bytes, "rb").read() if isinstance(path_or_bytes, str) else path_or_bytes
    return json.loads(_request(hub, "/api/audio/upload", raw=raw, ctype="audio/wav"))


# --------------------------------------------------------------------------- #
# STT — speech to text (async task API; `audio` = server-side path, NOT base64)
# Sent to a real hub on purpose: the fan-out also serves POST /api/tasks by alias
# (`{"model":"stt","request":{…}}`, see docs/agent-api.md §2), but keeping upload
# and task on one host is simpler and needs no ?hub= pin on the reads.
# --------------------------------------------------------------------------- #

def transcribe(audio: str, *, hub: str = DEFAULT_DIRECT_HUB, service: str = "citrinet",
               upload: bool = False, wait: bool = True,
               timeout: int = POLL_TIMEOUT) -> dict:
    """Transcribe audio (hub-side service name, e.g. `citrinet`).

    `audio` is a server-side WAV path, or a local file path when upload=True
    (uploaded via /api/audio/upload first). Returns the final task dict
    (`text` holds the transcript) when wait=True, else the submitted task.

    Goes to a real hub by default: `service` is a service name on that host, and
    the audio path has to live on the same host that runs the engine.
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
# Hub-only: each hub owns its own data/voices/ and data/history/<modelId>/.
# --------------------------------------------------------------------------- #

def voices(hub: str = DEFAULT_DIRECT_HUB) -> list[dict]:
    """Registered reference voices (use entries' paths as voice_ref for cloning).

    Per hub, not per farm: a `voice_ref` path only resolves on the hub that
    stores the WAV.
    """
    return _json(hub, "/api/voices")


def history(model: str = "breeze-tts", hub: str = DEFAULT_DIRECT_HUB) -> list[dict]:
    """Archived generations, newest first.

    Each entry: `taskId` (feed it to history_record), `text` (truncated),
    `instanceName`, `result.durationSec`, `time` (epoch ms).

    `model` is the hub-side modelId (`breeze-tts`, `sanotts`, `citrinet_asr`),
    not the fan-out alias (`breeze`, `instant`, `stt`).
    """
    return _json(hub, f"/api/history/{model}")


def history_record(task_id: str, model: str = "breeze-tts", hub: str = DEFAULT_DIRECT_HUB) -> dict:
    """Full record of one generation: the take's `text`, `options` (instruction,
    seed…) and `result`.

    `task_id` is an entry's `taskId` from history(). For a take made through the
    fan-out, pass the `X-Fanout-Hub` value from speech_with_origin() — history
    lives on the hub that served it.
    """
    return _json(hub, f"/api/history/{model}/{task_id}")


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def _main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0],
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--hub", default=None,
                   help="fan-out base URL for TTS + discovery "
                        f"(default $AUDIOCPP_HUB_URL or {DEFAULT_HUB}; "
                        f"local dev: {LOCAL_HUB})")
    p.add_argument("--direct-hub", default=None,
                   help="a single hub, for the routes the fan-out does not proxy "
                        "(upload, voices, history) and for STT, which stays here "
                        f"(default $AUDIOCPP_DIRECT_HUB_URL or {DEFAULT_DIRECT_HUB}; "
                        f"local dev: {LOCAL_HUB})")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("say", help="generate speech to a file (via the fan-out)")
    s.add_argument("text")
    s.add_argument("-o", "--out", default="out.wav")
    s.add_argument("-m", "--model", default="breeze", help="farm alias (breeze, expressive, instant, sanotts, qwen3-vd)")
    s.add_argument("--instruction")
    s.add_argument("--seed", type=int)
    s.add_argument("--temperature", type=float)
    s.add_argument("--voice-ref", help="server-side WAV path for voice cloning (hub-side, not an alias)")
    s.add_argument("--reference-text", help="transcript of the reference clip (required when cloning)")

    t = sub.add_parser("stt", help="transcribe a WAV (hub-only: uses --direct-hub)")
    t.add_argument("audio", help="local or server-side WAV path")
    t.add_argument("--upload", action="store_true", help="audio is a local file; upload it first")

    w = sub.add_parser("sweep", help="generate a variety of voice designs")
    w.add_argument("text")
    w.add_argument("--instructions", nargs="+", required=True)
    w.add_argument("--seeds", type=int, nargs="+", default=[0, 1, 2])
    w.add_argument("--temperatures", type=float, nargs="+", default=[0.9])
    w.add_argument("-d", "--outdir", default=".")
    w.add_argument("-m", "--model", default="breeze")

    sub.add_parser("voices", help="list voice-library entries (hub-only: --direct-hub)")
    h = sub.add_parser("history", help="list archived generations (hub-only: --direct-hub)")
    h.add_argument("-m", "--model", default="breeze-tts",
                   help="hub-side modelId, not a fan-out alias (breeze-tts, sanotts, citrinet_asr)")

    sub.add_parser("health", help="fan-out view: per-hub up/down + alias routing (fan-out only)")
    sub.add_parser("models", help="list model ids / fan-out aliases that are READY")

    a = p.parse_args(argv)
    env = os.environ
    hub = a.hub or env.get("AUDIOCPP_HUB_URL", DEFAULT_HUB)
    # Symmetric with the flag above on purpose: AUDIOCPP_HUB_URL is the fan-out
    # for TTS and must NOT silently become the STT/history target, so pointing
    # the hub-only calls elsewhere always takes an explicit --direct-hub (or
    # AUDIOCPP_DIRECT_HUB_URL). Local dev sets both to the same localhost hub.
    direct = a.direct_hub or env.get("AUDIOCPP_DIRECT_HUB_URL", DEFAULT_DIRECT_HUB)

    if a.cmd == "say":
        wav, headers = speech_with_origin(a.text, model=a.model, instruction=a.instruction,
                                          seed=a.seed, temperature=a.temperature,
                                          voice_ref=a.voice_ref,
                                          reference_text=a.reference_text, hub=hub)
        with open(a.out, "wb") as f:
            f.write(wav)
        # stderr, so stdout stays parseable; tells you which hub archived the take.
        if origin := headers.get("X-Fanout-Hub"):
            print(f"[fanout] {origin} / {headers.get('X-Fanout-Instance', '?')}", file=sys.stderr)
        print(f"{a.out} ({wav_duration(a.out):.2f}s)")
    elif a.cmd == "stt":
        task = transcribe(a.audio, hub=direct, upload=a.upload)
        if task["status"] != "DONE":
            sys.exit(f"task {task['id']} ended as {task['status']}: {task.get('error')}")
        print(task.get("text", ""))
    elif a.cmd == "sweep":
        for r in voice_sweep(a.text, a.instructions, seeds=a.seeds,
                             temperatures=a.temperatures, outdir=a.outdir,
                             model=a.model, hub=hub):
            print(json.dumps(r, ensure_ascii=False))
    elif a.cmd == "voices":
        for v in voices(direct):
            # hub voice entries are keyed by `vid` (docs/API.md), not `id`
            vid = v.get("vid") or v.get("id") or "?"
            print(f"{vid}: {v['name']}" + (f"  [{v.get('text','')}]" if v.get("text") else ""))
    elif a.cmd == "history":
        for r in history(a.model, direct):
            # list entries are keyed by `taskId` (docs/API.md), not `id`
            tid = r.get("taskId") or r.get("id") or "?"
            dur = (r.get("result") or {}).get("durationSec")
            print(f"{tid}: {r.get('text','')}" + (f"  [{dur}s]" if dur else ""))
    elif a.cmd == "health":
        info = farm_health(hub)
        print(f"farm {info['hubsUp']}/{info['hubsTotal']} hubs up, "
              f"{info['readyAliases']}/{len(info['knownAliases'])} aliases ready")
        for st in info["hubs"]:
            mark = "up  " if st["ok"] else "DOWN"
            print(f"  [{mark}] {st['baseUrl']} ({st['label']}) "
                  f"{st['latencyMs']}ms {st['lastError'] or ''}".rstrip())
        for rt in info["routes"]:
            where = rt["resolved"] or "no ready backend"
            print(f"  {', '.join(rt['aliases'])} -> {where}")
    elif a.cmd == "models":
        for mid in models(hub):
            print(mid)


if __name__ == "__main__":
    _main()
