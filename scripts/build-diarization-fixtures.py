#!/usr/bin/env python3
"""Create script-attributed diarization test audio without loading any ML model.

The four ordered source turns derive from upstream's independently authored
four_speaker_short.txt plus silence-gap inspection. These boundaries have not
been human-audited for exact voice identity or phonetic speech activity.
"""
import argparse
import array
import hashlib
import json
import pathlib
import subprocess
import wave

RATE = 16000
SOURCE_COMMIT = "f6277c1695a83cf388a8282c1c1a8757cf626f18"
# Source-script speaker order and broad turn cuts: not a human audited RTTM.
TURNS = (
    ("speaker_1", 0.17, 7.65),
    ("speaker_2", 8.45, 14.12),
    ("speaker_3", 16.20, 21.24),
    ("speaker_4", 22.29, 27.99),
)
CASES = {
    "silence_0spk": (6.0, ()),
    "solo_1spk": (8.5, ((0, 0.50),)),
    "overlap_2spk": (12.0, ((0, 0.50), (1, 5.30))),
    "overlap_4spk": (19.0, ((0, 0.50), (1, 5.30), (2, 8.90), (3, 12.40))),
}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def audio_bytes(path):
    command = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", str(path), "-ac", "1", "-ar", str(RATE),
        "-f", "s16le", "-acodec", "pcm_s16le", "-",
    ]
    try:
        result = subprocess.run(
            command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            check=True, timeout=15,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("Cannot build diarization fixtures: ffmpeg is not installed or not in PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Cannot build diarization fixtures: ffmpeg exceeded the 15-second conversion limit") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or b"").decode("utf-8", errors="replace").strip()
        raise RuntimeError(
            f"Cannot decode source audio {path}: ffmpeg exited {exc.returncode}"
            + (f" ({detail[:300]})" if detail else "")
        ) from exc
    if not result.stdout or len(result.stdout) % 2:
        raise RuntimeError(f"Source audio {path} produced no valid 16-bit PCM samples")
    return result.stdout


def build(source, destination):
    source = pathlib.Path(source)
    destination = pathlib.Path(destination)
    if not source.is_file():
        raise FileNotFoundError(f"Source WAV does not exist: {source}")
    pcm = audio_bytes(source)
    destination.mkdir(parents=True, exist_ok=True)
    decoded = array.array("h")
    decoded.frombytes(pcm)
    if __import__("sys").byteorder != "little":
        decoded.byteswap()
    meta = {
        "sample_rate": RATE,
        "source_commit": SOURCE_COMMIT,
        "source_repo": "https://github.com/0xShug0/audio.cpp",
        "source_path": "assets/resources/four_speaker_short.wav",
        "source_sha256": sha256(source.read_bytes()),
        "independent_label_origin": "four_speaker_short.txt: ordered speaker_1..4, with source windows based on silence detection",
        "human_voice_identity_verified": False,
        "phoneme_boundary_verified": False,
        "source_audio_redistribution_rights_verified": False,
        "use": "deterministic script-attributed regression fixtures; not a calibrated DER benchmark until independently audited",
        "cases": {},
    }
    for key, (duration, placements) in CASES.items():
        size = round(duration * RATE)
        mixed = [0] * size
        rttm = []
        tracks = []
        for index, dest_start_s in placements:
            speaker, clip_start_s, clip_end_s = TURNS[index]
            a = round(clip_start_s * RATE)
            b = round(clip_end_s * RATE)
            start = round(dest_start_s * RATE)
            assert 0 <= a < b <= len(decoded)
            assert start + (b - a) <= size
            for j, sample in enumerate(decoded[a:b]):
                # Fixed gain prevents clipping at the two-speaker overlaps.
                mixed[start + j] += round(sample / 2)
            d = (b - a) / RATE
            rttm.append((dest_start_s, d, speaker))
            tracks.append({
                "speaker_id": speaker, "source_start_sample": a,
                "source_end_sample": b, "output_start_sample": start,
                "output_end_sample": start + b - a,
            })
        output = array.array("h", (max(-32768, min(32767, v)) for v in mixed))
        if __import__("sys").byteorder != "little":
            output.byteswap()
        wav_path = destination / f"{key}.wav"
        with wave.open(str(wav_path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes(output.tobytes())
        ref_text = "".join(
            f"SPEAKER {key} 1 {start:.6f} {dur:.6f} <NA> <NA> {who} <NA> <NA>\n"
            for start, dur, who in sorted(rttm)
        )
        rttm_path = destination / f"{key}.rttm"
        rttm_path.write_text(ref_text)
        meta["cases"][key] = {
            "duration_seconds": duration, "speaker_count_scripted": len(placements),
            "wav_sha256": sha256(wav_path.read_bytes()),
            "rttm_sha256": sha256(ref_text.encode()),
            "tracks": tracks,
        }
    (destination / "manifest.json").write_text(json.dumps(meta, sort_keys=True, indent=2) + "\n")
    print(json.dumps({name: {"speakers": x["speaker_count_scripted"], "wav_sha256": x["wav_sha256"]} for name, x in meta["cases"].items()}, indent=2))


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--source", type=pathlib.Path, help="Legacy v1 source, explicitly requested")
    mode.add_argument("--validate-intake", type=pathlib.Path, help="Validate v2 intake JSON only; never build WAVs")
    parser.add_argument("--source-root", type=pathlib.Path, help="Allowed local source directory for v2")
    parser.add_argument("--output", type=pathlib.Path, help="Legacy v1 output directory")
    args = parser.parse_args()
    if args.validate_intake is not None:
        if args.source_root is None or args.output is not None:
            parser.error("v2 --validate-intake requires --source-root and forbids --output")
        from diarization_intake_v2 import validate_intake_file

        summary = validate_intake_file(args.validate_intake, args.source_root)
        print(json.dumps(summary, sort_keys=True))
        return
    if args.output is None or args.source_root is not None:
        parser.error("v1 --source requires --output and forbids --source-root")
    build(args.source, args.output)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as exc:
        parser_message = f"Fixture build failed: {exc}"
        raise SystemExit(parser_message) from None
