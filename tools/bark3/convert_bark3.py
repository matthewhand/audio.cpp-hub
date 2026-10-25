#!/usr/bin/env python3
"""Convert ConwayResearch Underdog Bark 3.0 (``model.bark``) into a parakeet_tdt GGUF for audio.cpp (#186).

Bark 3.0 is an English fine-tune of nvidia/parakeet-tdt-0.6b-v3 shipped in a compressed
"bark-levels" container. Its bundled ``bark_loader.py`` decodes it exactly into
HF ``ParakeetForTDT`` tensor names, so the pipeline is:

  model.bark --bark_loader--> numpy state dict
             --prepare_state_dict--> drop vad_head.* / num_batches_tracked, cast F32
             --stage--> <out>/model.safetensors + HF sidecars + provenance.json
             --audiocpp_gguf --family parakeet_tdt--> GGUF

Requirements: numpy, plus ``constriction`` for bark_loader. No torch, no safetensors package.

Usage:
  python3 convert_bark3.py --bark-dir DIR --meta-dir DIR --out-dir DIR \
      [--gguf-tool PATH --model-spec PATH --type q8_0 --gguf-out FILE] [--bark-revision SHA]

``--bark-dir`` holds model.bark and bark_loader.py (ConwayResearch/Underdog-Bark-3.0).
``--meta-dir`` holds the HF sidecars (config.json, tokenizer files...), e.g. from
ConwayResearch/Underdog-Bark-3.0-Pro, which ships the same ParakeetForTDT config.
Weights are CC-BY-4.0: keep the upstream NOTICE with any redistributed GGUF.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import struct
import subprocess
import sys
from pathlib import Path

import numpy as np

SIDECARS = (
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "processor_config.json",
    "generation_config.json",
)
GGUF_TYPES = ("orig", "f16", "q8_0")
DROP_PREFIXES = ("vad_head.",)
DROP_SUFFIXES = ("num_batches_tracked",)
# Fields that must agree between the .bark header config and the sidecar config.json.
CHECK_TOP = ("model_type", "vocab_size", "blank_token_id")
CHECK_ENCODER = ("hidden_size", "num_hidden_layers", "num_mel_bins")


def prepare_state_dict(sd: dict) -> tuple[dict, list]:
    """Return (F32 contiguous tensors to keep, sorted list of dropped names)."""
    kept, dropped = {}, []
    for name in sorted(sd):
        if name.startswith(DROP_PREFIXES) or name.endswith(DROP_SUFFIXES):
            dropped.append(name)
            continue
        arr = np.ascontiguousarray(np.asarray(sd[name], dtype=np.float32))
        if not np.isfinite(arr).all():
            raise ValueError(f"non-finite values in {name}")
        kept[name] = arr
    if not kept:
        raise ValueError("no tensors left after filtering")
    return kept, dropped


def validate_config(bark_cfg: dict, ref_cfg: dict) -> None:
    """Fail fast if the Bark header config disagrees with the sidecar config.json."""
    for key in CHECK_TOP:
        if bark_cfg.get(key) != ref_cfg.get(key):
            raise ValueError(f"config mismatch {key}: bark={bark_cfg.get(key)!r} sidecar={ref_cfg.get(key)!r}")
    be, re_ = bark_cfg.get("encoder_config", {}), ref_cfg.get("encoder_config", {})
    for key in CHECK_ENCODER:
        if be.get(key) != re_.get(key):
            raise ValueError(f"config mismatch encoder_config.{key}: bark={be.get(key)!r} sidecar={re_.get(key)!r}")


def write_safetensors(path: Path, tensors: dict, metadata: dict | None = None) -> None:
    """Minimal F32 safetensors writer (stdlib + numpy), streaming one tensor at a time."""
    header, offset = {}, 0
    for name in sorted(tensors):
        nbytes = tensors[name].nbytes
        header[name] = {"dtype": "F32", "shape": list(tensors[name].shape), "data_offsets": [offset, offset + nbytes]}
        offset += nbytes
    if metadata:
        header["__metadata__"] = {str(k): str(v) for k, v in metadata.items()}
    blob = json.dumps(header, separators=(",", ":")).encode()
    blob += b" " * ((8 - (8 + len(blob)) % 8) % 8)
    tmp = path.with_suffix(path.suffix + ".part")
    try:
        with open(tmp, "wb") as f:
            f.write(struct.pack("<Q", len(blob)))
            f.write(blob)
            for name in sorted(tensors):
                f.write(tensors[name].astype("<f4", copy=False).tobytes())
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    tmp.replace(path)


def stage(sd: dict, bark_cfg: dict, meta_dir: Path, out_dir: Path, provenance: dict | None = None) -> dict:
    """Write model.safetensors + sidecars + provenance.json into out_dir. Returns the provenance dict."""
    meta_dir, out_dir = Path(meta_dir), Path(out_dir)
    for f in SIDECARS:
        if not (meta_dir / f).is_file():
            raise FileNotFoundError(f"missing sidecar {f} in {meta_dir}")
    validate_config(bark_cfg, json.loads((meta_dir / "config.json").read_text()))
    kept, dropped = prepare_state_dict(sd)
    out_dir.mkdir(parents=True, exist_ok=True)
    write_safetensors(out_dir / "model.safetensors", kept, metadata={"format": "pt", "source": "underdog-bark-3.0"})
    for f in SIDECARS:
        shutil.copyfile(meta_dir / f, out_dir / f)
    info = dict(provenance or {})
    info.update({"tensors": len(kept), "dropped": dropped,
                 "parameters": int(sum(a.size for a in kept.values())), "dtype": "F32"})
    (out_dir / "provenance.json").write_text(json.dumps(info, indent=2) + "\n")
    return info


def gguf_command(tool: Path, staged: Path, output: Path, qtype: str, model_spec: Path | None) -> list:
    if qtype not in GGUF_TYPES:
        raise ValueError(f"--type must be one of {GGUF_TYPES}, got {qtype!r}")
    cmd = [str(tool), "--input", str(Path(staged) / "model.safetensors"), "--root", str(staged),
           "--family", "parakeet_tdt", "--type", qtype, "--overwrite", "--output", str(output)]
    if model_spec:
        cmd += ["--model-spec", str(model_spec)]
    return cmd


def load_bark(bark_dir: Path):
    loader = Path(bark_dir) / "bark_loader.py"
    if not loader.is_file():
        raise FileNotFoundError(f"bark_loader.py not found in {bark_dir}")
    spec = importlib.util.spec_from_file_location("bark_loader", loader)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {loader}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.load_state_dict(str(Path(bark_dir) / "model.bark"), as_numpy=True)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--bark-dir", type=Path, required=True)
    ap.add_argument("--meta-dir", type=Path, required=True)
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--bark-revision", default="unknown")
    ap.add_argument("--gguf-tool", type=Path)
    ap.add_argument("--model-spec", type=Path)
    ap.add_argument("--type", default="q8_0", choices=GGUF_TYPES)
    ap.add_argument("--gguf-out", type=Path)
    a = ap.parse_args(argv)
    sd, cfg = load_bark(a.bark_dir)
    info = stage(sd, cfg, a.meta_dir, a.out_dir, provenance={
        "source_repo": "ConwayResearch/Underdog-Bark-3.0", "bark_revision": a.bark_revision,
        "license": "CC-BY-4.0", "base_model": "nvidia/parakeet-tdt-0.6b-v3"})
    print(f"staged {info['tensors']} tensors ({info['parameters']} params), dropped {len(info['dropped'])}: {info['dropped']}")
    if a.gguf_tool:
        out = a.gguf_out or a.out_dir / f"underdog-bark-3.0-{a.type}.gguf"
        cmd = gguf_command(a.gguf_tool, a.out_dir, out, a.type, a.model_spec)
        print("+", " ".join(cmd), flush=True)
        subprocess.run(cmd, check=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
