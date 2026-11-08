# Superwhisper speech recognition on AMD Vulkan

The hub catalog includes **Superwhisper Offline Lite** (Parakeet TDT v3 Q4) and
**Superwhisper Offline · Cohere Transcribe** (Cohere Q4). The latter exposes
the speech recognition stage. Superwhisper's S1-mini cleanup and vocabulary
processing are separate stages.

Install the matching transcribe.cpp v0.4.1 Python bindings and CPU/Vulkan
native archive from its upstream release:
https://github.com/handy-computer/transcribe.cpp/releases/tag/v0.4.1

Register a hub executable pointing to Python 3.10–3.12. Set these environment
variables on that executable entry:

| Variable | Value |
| --- | --- |
| AUDIOCPP_WORKER_SCRIPT | Absolute path to tools/superwhisper/worker.py |
| TRANSCRIBE_LIBRARY | Absolute path to libtranscribe.so (Linux) or transcribe.dll (Windows) |
| PYTHONPATH | Directory containing transcribe_cpp if the bindings are installed in an isolated directory |

In the launch dialog choose that executable, the Vulkan backend and the
discrete AMD GPU or APU you want to use. Set a free GPU memory floor
appropriate for the host. The worker refuses CPU, NVIDIA and unavailable
devices and validates the device chosen by the library. For a host with
one AMD Vulkan device, omitting the device selects that device.

The Lite card downloads the pinned Q4 conversion and verifies its checksum.
For Cohere, obtain the exact Superwhisper release checkpoint and select its
GGUF file at launch. The official v1.2.0 release manifest pins
cohere-transcribe-03-2026-Q4_K_M.gguf to SHA-256
0ea56826d8bd5d74b7143a4a04e022dc1bb75452cfae49d98b6acb0c1d16a1fb.

The API supports multipart WAV at POST /v1/audio/transcriptions and the
hub UI task flow with an uploaded WAV. Inputs are mono/stereo PCM16 WAV,
up to 120 seconds and 50 MiB. Models stay loaded until the instance stops.
Use offline mode. Keep the worker on the hub's loopback interface.

On Ubuntu-Max both models passed both hub paths on the discrete RX 6600 XT
and the Strix Halo APU with the upstream Vulkan runtime. On Windows the Cohere worker disables flash attention for its own process.
The standard Vulkan attention path transcribed two human speech clips on the
RX 6600 XT where flash attention caused decoder repetition. This setting does
not change the selected device.

On Windows1 (WIN2019 with RX 6600 XT and GTX 1080), configure the
Superwhisper executable entry with `GGML_VK_VISIBLE_DEVICES=0` and
`GGML_VK_PREFER_HOST_MEMORY=1`. Confirm that device 0 is the RX 6600 XT
using the hub's device probe before starting Lite. The host-visible
Vulkan allocation resolved a startup stall on this machine. The worker
still selects AMD Vulkan, and Parakeet's TDT decoder uses its normal
host implementation.
