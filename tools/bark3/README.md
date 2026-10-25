# Underdog Bark 3.0 → parakeet_tdt GGUF

[Underdog Bark 3.0](https://huggingface.co/ConwayResearch/Underdog-Bark-3.0) (CC-BY-4.0) is an English
fine-tune of NVIDIA Parakeet-TDT 0.6B v3. It is published only as `model.bark`, a compressed container
decoded by the bundled `bark_loader.py`. Upstream audio.cpp already runs the `parakeet_tdt` family, so
the converter only has to rebuild a Transformers-layout checkpoint and hand it to `audiocpp_gguf`.

```
model.bark --bark_loader.py--> state dict --convert_bark3.py--> model.safetensors + sidecars
           --audiocpp_gguf --family parakeet_tdt--> underdog-bark-3.0-q8_0.gguf
```

## Requirements

- Python 3 with numpy, plus `constriction` (needed by `bark_loader.py`). No torch or safetensors package.
- An audio.cpp build with `parakeet_tdt` (its `audiocpp_gguf` tool and `model_specs/parakeet_tdt.json`).
- About 3.5 GB peak RAM and 2.5 GB scratch disk for the intermediate F32 safetensors.

## Steps

```bash
# 1. Weights and loader
hf download ConwayResearch/Underdog-Bark-3.0 model.bark bark_loader.py NOTICE README.md --local-dir bark
# 2. Transformers config/tokenizer sidecars (the Bark 3.0 repo ships only weights;
#    the sibling Pro repo carries the matching Parakeet-TDT sidecars)
hf download ConwayResearch/Underdog-Bark-3.0-Pro config.json tokenizer.json tokenizer_config.json \
  processor_config.json generation_config.json --local-dir meta
# 3. Convert (writes out/model.safetensors, sidecars and provenance.json, then the GGUF)
python3 tools/bark3/convert_bark3.py --bark-dir bark --meta-dir meta --out-dir out \
  --bark-revision main \
  --gguf-tool /path/to/audio.cpp/build/bin/audiocpp_gguf \
  --model-spec /path/to/audio.cpp/model_specs/parakeet_tdt.json \
  --type q8_0 --gguf-out models/Underdog-Bark-3.0-GGUF/underdog-bark-3.0-q8_0.gguf
```

`--type` accepts `orig`, `f16` or `q8_0`. Omit `--gguf-tool` to stop after the safetensors stage.
The intermediate `out/model.safetensors` can be deleted once the GGUF exists.

The converter drops `vad_head.*` and BatchNorm `num_batches_tracked` buffers, casts weights to
contiguous F32, rejects empty or non-finite tensors, and checks the config (model type, vocab and blank
ids, encoder width, depth and mel bins) before writing anything.

Then pick the GGUF on the **Underdog Bark 3.0** card (family `parakeet_tdt`).

## Verified

On a Vulkan build of upstream audio.cpp 082177e (AMD iGPU): 699 tensors / 627M parameters converted in
37 s; q8_0 GGUF 0.92 GB; offline ASR at RTF ≈ 0.016 (about 60× realtime), peak RSS 1.5 GB.

## Tests

```bash
python3 -m unittest discover -s tools/bark3 -p 'test_*.py'
```

The tests are offline and synthetic: they never download or need the real weights.

Keep the CC-BY-4.0 attribution (the upstream `NOTICE`) alongside any converted GGUF you redistribute.
