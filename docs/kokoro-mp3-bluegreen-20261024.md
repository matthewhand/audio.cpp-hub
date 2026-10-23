# Kokoro MP3 and TalkingHead blue-green acceptance (24 Oct 2026)

## Source and decisions
- Isolated source branch: feat/kokoro-mp3-isolated-20261024 based on feature branch commit d15fe98.
- Production audio.cpp-hub :18080 and fanout :18082 remain unchanged.
- Only Kokoro **non-streaming** POST /v1/audio/speech routes through the MP3 fallback.
- Kokoro requests with absent response_format default to MP3 to match OpenAI and the existing Python server; explicit response_format=wav stays WAV. Other TTS models retain their existing behavior.
- FFmpeg/libmp3lame encodes at 128 kbps, matching TalkingHead's duration estimator. Encoder process is context-bound (25s); WAV input is bounded to 24 MiB. Unsupported streaming+explicit MP3 returns HTTP 400. Encoder failure returns HTTP 502 before writing audio.
- WAV is archived in hub history even when MP3 is delivered; this preserves lossless history.
- Official upstream audio.cpp native mp3_encode frontend source exists at external/audio.cpp-server-frontends/modules/mp3_encode.cpp, but the host and cached builder both lack lame/lame.h. No packages were installed.
- HttpBindHost in hub.config.json is opt-in; unset remains :port as in the old hub, while 127.0.0.1 restricts the new candidate to loopback.

## Evidence
- Full offline go test -count=1 ./... and go vet ./... pass using the cached golang:1.27 container with --network none.
- Real Kokoro CPU test via an isolated network namespace passed: HTTP 200 WAV (24 kHz), HTTP 200 audio/mpeg, successful MP3 decoding; no production restarts.
- Actual TalkingHead tts_speech.openai_speech_synth client code succeeded with model=kokoro, voice=af_bella, omitted response_format, and a fictional Bearer value. Result was decodable MP3, with client duration estimate within 1.4% of the WAV reference.
- Source-only/bounded error tests: wrong MIME, malformed WAV, oversize WAV, invalid MP3 encoder result, streaming MP3 request, unrelated models, and hostname/port validation.
- The isolated hub process exited normally after acceptance.

## Proposed blue-green deployment (NOT YET RUN)
1. Recheck host disk and RAM gates, active builds, current hub and original engine PIDs, and port ownership. Do not proceed under resource pressure.
2. Reconfirm the exact candidate binary SHA256, source commit, production config and service associations.
3. Review the prepared candidate directory and proposed unit file. The separate service uses 127.0.0.1:18280 and model instance ports starting at 18290, with separate data/run; no shared instance-manager state.
4. With separate owner approval, register and start ONLY the candidate service. Do not restart audio-cpp-hub on :18080 or stop its Breeze and Sanotts engines.
5. From localhost, start one Kokoro CPU instance with modelId=kokoro_tts and **name=kokoro** using existing Q8 weights. Verify /api/instances READY, /v1/models returns kokoro, /v1/audio/speech default MP3, explicit WAV and errors. Check resources continuously. No 0.0.0.0 listener.
6. Keep 9093 Python active while testing the TalkingHead user config in an isolated/private staged copy. Then, with owner approval, change only the Kokoro provider endpoint and the 9093-specific fallback endpoints in ~/.config/talkinghead-assist/providers.json and .env to http://127.0.0.1:18280, preserving file permissions and credentials. Model=kokoro and voice=af_bella need no changes.
7. Verify speech from the actual TalkingHead backend, fallback after F5 unavailable, audio decoding and timepoints. Test remote consumers separately; 127.0.0.1 on other machines is NOT the GTX.
8. Soak at least one full usual operating cycle and verify no new client accesses on port 9093 before a separate retirement approval.
9. Retire only Docker app openai-kokoro-tts-docker-app-1, then check the image is unreferenced before removing openai-kokoro-tts-docker-app:latest. Remove only ~/openai-kokoro-tts-docker after offhost preservation and consumer proof. No broad Docker prune.

## Client inventory and constraints
- GTX ~.config/talkinghead-assist/providers.json has tts.providers.kokoro.endpoint http://10.0.0.36:9093, model kokoro, voice af_bella, and extra_endpoints that include 9093.
- GTX ~.config/talkinghead-assist/.env has TALKINGHEAD_TTS_FALLBACK_ENDPOINT and TALKINGHEAD_TTS_FALLBACK_ENDPOINTS containing 9093; preserve unrelated F5 primary and other endpoints.
- Ubuntu-Max Homepage services.yaml advertises GTX Kokoro at :9093 and stale CPU :9094; informational links, update separately with approval.
- 9094 CPU test container was retired previously. 9093 Python container and its shared image still run; their active service is NOT to be removed until after cutover acceptance.
- Other clients cannot be ruled out from snapshots with zero established connections. No direct network service exposure of the test hub.
- Stage binds only host loopback; for remote clients, separately design authenticated/firewall-restricted ingress rather than opening 18280 to LAN.

## Rollback
- Before any config change, make a permission-restricted, verified backup of exactly the TalkingHead providers.json and .env, without exposing credentials.
- If candidate fails before cutover, stop only candidate service and leave 9093, :18080, Breeze and Sanotts untouched.
- If TalkingHead acceptance fails after its endpoint update, restore only those two original config files via an owner-approved supported path, verify checksums, and keep 9093 online.
- No 9093 Docker/container/image/source deletion before separate acceptance and explicit approval.
