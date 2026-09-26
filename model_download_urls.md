# Model Download URLs

> **文档定位（重要）**：本文件是 **audio.cpp 上游模型权重的来源参考**，供手动下载时查阅，并非 hub 的功能清单。
> hub 内置了权重下载器：模型的可下载包以根目录 `model-packages.json`（`go:embed` 内嵌，共 48 个模型族，覆盖 `models.json` 28 个模型之外的更多模型）为准，
> 查询接口 `GET /api/models/{modelId}/packages`，创建下载任务 `POST /api/downloads`（ModelScope 镜像可用 `"source":"modelscope"`）。
> 推荐优先使用 UI 的「下载权重」弹窗 / 下载管理面板，而不是手动下载。

所有模型下载地址汇总，主要来源于 HuggingFace，少量来自 NVIDIA NGC 和 Facebook。

---

## 官方 GGUF 主仓库

### audio-cpp/audio.cpp-gguf
https://huggingface.co/audio-cpp/audio.cpp-gguf

包含以下模型的 GGUF 版本（路径为仓库内目录）：

| 模型 | 仓库路径 |
|------|----------|
| ACE-Step 1.5 Turbo | `ACE-Step1.5-GGUF/turbo/` |
| ACE-Step 1.5 Base | `ACE-Step1.5-GGUF/base/` |
| Chatterbox | `Chatterbox-GGUF/` |
| Citrinet ASR | `Citrinet-ASR-GGUF/` |
| Fish Audio S2 Pro | `Fish-Audio-S2-Pro-GGUF/` |
| HeartMuLa | `HeartMuLa-GGUF/` |
| Higgs Audio v3 STT | `Higgs-Audio-v3-STT-GGUF/` |
| Higgs Audio v3 TTS 4B | `Higgs-Audio-v3-TTS-4B-GGUF/` |
| HTDemucs | `HTDemucs-GGUF/` |
| IndexTTS2 | `IndexTTS2-GGUF/` |
| Irodori-TTS 500M v3 | `Irodori-TTS-500M-v3-GGUF/` |
| Irodori-TTS 600M v3 VoiceDesign | `Irodori-TTS-600M-v3-VoiceDesign-GGUF/` |
| Mel-Band RoFormer | `Mel-Band-RoFormer-GGUF/` |
| MioCodec 25Hz v2 | `MioCodec-25Hz-44.1kHz-v2-GGUF/` |
| MioTTS 1.7B | `MioTTS-1.7B-GGUF/` |
| MOSS-TTS-Local v1.5 | `MOSS-TTS-Local-v1.5-GGUF/` |
| MOSS-TTS-Nano 100M | `MOSS-TTS-Nano-100M-GGUF/` |
| Nemotron 3.5 ASR | `Nemotron-3.5-ASR-Streaming-0.6B-GGUF/` |
| OmniVoice | `OmniVoice-GGUF/` |
| PocketTTS | `PocketTTS-GGUF/`（含多语言子目录） |
| Qwen3-ASR | `Qwen3-ASR-*-GGUF/` |
| Qwen3 ForcedAligner | `Qwen3-ForcedAligner-0.6B-GGUF/` |
| Qwen3-TTS | `Qwen3-TTS-12Hz-*-GGUF/` |
| Seed-VC | `SeedVC-MLX-GGUF/` |
| Sortformer Diar | `Sortformer-Diar-4spk-v1-GGUF/` |
| Stable Audio 3 | `Stable-Audio-3-*-GGUF/` |
| Supertonic 3 | `Supertonic-3-GGUF/` |
| Vevo2 | `Vevo2-GGUF/` |
| VibeVoice 1.5B | `VibeVoice-1.5B-GGUF/` |
| VibeVoice ASR | `VibeVoice-ASR-GGUF/` |
| Voxtral Mini 4B | `Voxtral-Mini-4B-Realtime-2602-GGUF/` |
| VoxCPM2 | `VoxCPM2-GGUF/` |

---

## 社区 GGUF 仓库

### mirek190/audio.cpp
https://huggingface.co/mirek190/audio.cpp

| 模型 | 仓库路径 |
|------|----------|
| GLM-TTS | `Text to audio (TTS)/GLM-TTS_Q8.gguf` |
| Hviske ASR v5.3 | `Audio to text (ASR)/hviske-v5.3_Q8.gguf` |
| OuteTTS 1.0-1B | `Text to audio (TTS)/Llama-OuteTTS-1.0-1B_Q8.gguf` |

### phuocnguyen90/VieNeu-TTS-v3-Turbo-GGUF
https://huggingface.co/phuocnguyen90/VieNeu-TTS-v3-Turbo-GGUF

| 模型 |
|------|
| VieNeu-TTS v3 Turbo |

---

## Safetensors 原始仓库（按模型分类）

### ACE-Step 1.5
- `https://huggingface.co/ACE-Step/Ace-Step1.5`
- `https://huggingface.co/ACE-Step/acestep-v15-base`

### Chatterbox
- `https://huggingface.co/ResembleAI/chatterbox`

### GLM-TTS
- `https://huggingface.co/zai-org/GLM-TTS`
- `https://huggingface.co/mlx-community/index-tts2-mlx`（campplus 组件）

### HeartMuLa
- `https://huggingface.co/HeartMuLa/HeartMuLaGen`
- `https://huggingface.co/HeartMuLa/HeartMuLa-oss-3B`
- `https://huggingface.co/HeartMuLa/HeartCodec-oss-20260123`

### Higgs Audio STT v3
- `https://huggingface.co/bosonai/higgs-audio-v3-stt`
- `https://huggingface.co/openai/whisper-large-v3`

### Hviske ASR v5.3
- `https://huggingface.co/syvai/hviske-v5.3`

### IndexTTS2
- `https://huggingface.co/mlx-community/index-tts2-mlx`

### Irodori-TTS 500M v3
- `https://huggingface.co/Aratako/Irodori-TTS-500M-v3`
- `https://huggingface.co/llm-jp/llm-jp-3-150m`
- `https://huggingface.co/Aratako/Semantic-DACVAE-Japanese-32dim`

### Irodori-TTS 600M v3 VoiceDesign
- `https://huggingface.co/Aratako/Irodori-TTS-600M-v3-VoiceDesign`
- `https://huggingface.co/llm-jp/llm-jp-3-150m`
- `https://huggingface.co/Aratako/Semantic-DACVAE-Japanese-32dim`

### Mel-Band RoFormer
- `https://huggingface.co/mlx-community/mel-roformer-mlx`

### MioCodec 25Hz v2
- `https://huggingface.co/Aratako/MioCodec-25Hz-44.1kHz-v2`
- `https://huggingface.co/mlx-community/wavlm-base-plus-mlx`

### MioTTS 1.7B
- `https://huggingface.co/Aratako/MioTTS-1.7B`
- `https://huggingface.co/Aratako/MioCodec-25Hz-44.1kHz-v2`
- `https://huggingface.co/mlx-community/wavlm-base-plus-mlx`

### MOSS-TTS-Nano 100M
- `https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M`
- `https://huggingface.co/OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano`

### MOSS-TTS-Local v1.5
- `https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Local-Transformer-v1.5`
- `https://huggingface.co/OpenMOSS-Team/MOSS-Audio-Tokenizer-v2`

### Nemotron 3.5 ASR
- `https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b`

### OmniVoice
- `https://huggingface.co/k2-fsa/OmniVoice`

### OuteTTS 1.0-1B
- `https://huggingface.co/OuteAI/Llama-OuteTTS-1.0-1B`
- `https://huggingface.co/ibm-research/DAC.speech.v1.0`
- `https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B`

### PocketTTS
- `https://huggingface.co/kyutai/pocket-tts`（需授权 gated）

### Qwen3-ASR 0.6B
- `https://huggingface.co/Qwen/Qwen3-ASR-0.6B`

### Qwen3-ASR 1.7B
- `https://huggingface.co/Qwen/Qwen3-ASR-1.7B-hf`

### Qwen3 ForcedAligner 0.6B
- `https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B`

### Qwen3-TTS 0.6B Base
- `https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base`

### Qwen3-TTS 1.7B Base
- `https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base`

### Qwen3-TTS 1.7B CustomVoice
- `https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`

### Qwen3-TTS 1.7B VoiceDesign
- `https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign`

### Qwen3-TTS Tokenizer 12Hz
- `https://huggingface.co/Qwen/Qwen3-TTS-Tokenizer-12Hz`

### Seed-VC
- `https://huggingface.co/mlx-community/SeedVC-MLX`

### Sortformer Diar 4spk v1
- `https://huggingface.co/nvidia/diar_sortformer_4spk-v1`

### Stable Audio 3 Medium（需授权 gated）
- `https://huggingface.co/stabilityai/stable-audio-3-medium`

### Stable Audio 3 Small Music（需授权 gated）
- `https://huggingface.co/stabilityai/stable-audio-3-small-music`

### Stable Audio 3 Small SFX（需授权 gated）
- `https://huggingface.co/stabilityai/stable-audio-3-small-sfx`

### Supertonic 3
- `https://huggingface.co/mlx-community/supertonic-3-mlx`

### Vevo2
- `https://huggingface.co/RMSnow/Vevo2`

### VibeVoice 1.5B
- `https://huggingface.co/microsoft/VibeVoice-1.5B`

### VibeVoice 7B
- `https://huggingface.co/vibevoice/VibeVoice-7B`

### VibeVoice ASR
- `https://huggingface.co/microsoft/VibeVoice-ASR`

### VoxCPM2
- `https://huggingface.co/OpenBMB/VoxCPM2`

---

## 非 HuggingFace 来源

| 模型 | 地址 |
|------|------|
| **Citrinet ASR** (NVIDIA NGC) | `https://api.ngc.nvidia.com/v2/models/nvidia/nemo/stt_en_citrinet_256/versions/1.0.0rc1/files/stt_en_citrinet_256.nemo` |
| **HTDemucs** (Facebook) | `https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th`（含多个 `.th` 文件） |
| **Whisper medium** (OpenAI) | `https://openaipublic.azureedge.net/main/whisper/models/345ae4da62f9b3d59415adc60127b97c714f32e89e936602e85993674d08dcb1/medium.pt` |

---

## 在 hub 中下载

上表所列仓库已在 hub 的 `model-packages.json` 中转换为可下载包，无需手动拼接 URL：

```bash
# 1) 查看某模型有哪些下载包
curl http://127.0.0.1:8080/api/models/index_tts2/packages

# 2) 创建下载任务（packageId 缺省取 default 包，创建即开始）
curl -X POST http://127.0.0.1:8080/api/downloads \
  -H 'Content-Type: application/json' \
  -d '{"modelId":"index_tts2"}'

# 3) 通过 ModelScope 镜像下载（目前仅 audio.cpp-gguf 仓库可用）
curl -X POST http://127.0.0.1:8080/api/downloads \
  -H 'Content-Type: application/json' \
  -d '{"modelId":"index_tts2","source":"modelscope"}'
```

gated 仓库（如 `PocketTTS`、`Stable Audio 3`）需在创建任务时传 `"token"`（HuggingFace token）。下载进度、暂停 / 续传、删除见 `docs/API.md` 的「权重下载」章节。

认证：手动下载 gated 仓库时，可通过环境变量 `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN`，或 `~/.cache/huggingface/token` 文件配置令牌。
