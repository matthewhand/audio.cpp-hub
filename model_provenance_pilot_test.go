package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

// Published hashes below are registry metadata: never fetch model weights.
// All HTTP requests in this test are synthetic and handled in memory.
func TestPilotPackagesHaveExactPinnedMetadata(t *testing.T) {
	cases := []struct{ family, id, repo, commit, remote, hash string }{
		{"ming3_tts", "ming3_tts_q8_0", "audio-cpp/Ming-3.0-TTS-0.5B-GGUF", "2eb8d37c7f10672e69c8aa33091baa04c461b66c", "ming-3.0-tts-0.5b-q8_0.gguf", "fcf2aa25e8e9cf2065a936e506581735c64d6255fb7869f09fbb61a2dde09aa1"},
		{"ming3_tts", "ming3_tts_bf16", "audio-cpp/Ming-3.0-TTS-0.5B-GGUF", "2eb8d37c7f10672e69c8aa33091baa04c461b66c", "ming-3.0-tts-0.5b-bf16.gguf", "43f108a4e6bb54af13071d0cb345a094e0b011b3b8318d8fb2c61753733f5312"},
		{"ming3_tts_voicedesign", "ming3_tts_voicedesign_q8_0", "audio-cpp/Ming-3.0-TTS-0.5B-GGUF", "2eb8d37c7f10672e69c8aa33091baa04c461b66c", "ming-3.0-tts-0.5b-q8_0.gguf", "fcf2aa25e8e9cf2065a936e506581735c64d6255fb7869f09fbb61a2dde09aa1"},
		{"ming3_tts_voicedesign", "ming3_tts_voicedesign_bf16", "audio-cpp/Ming-3.0-TTS-0.5B-GGUF", "2eb8d37c7f10672e69c8aa33091baa04c461b66c", "ming-3.0-tts-0.5b-bf16.gguf", "43f108a4e6bb54af13071d0cb345a094e0b011b3b8318d8fb2c61753733f5312"},
		{"kokoro_tts", "kokoro_82m_q8_0", "audio-cpp/audio.cpp-gguf", "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8", "Kokoro-82M-GGUF/kokoro-82m-q8_0.gguf", "9a4ca6176460cdc8c7845b804c0bbe85a4791ee3ffff568a3fdadbb708c63f47"},
		{"kokoro_tts", "kokoro_82m_bf16", "audio-cpp/audio.cpp-gguf", "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8", "Kokoro-82M-GGUF/kokoro-82m-bf16.gguf", "0d2c2afac39b0ff01fb20b5633a6a5543735e612942b3af571424502b9c2dfaa"},
		{"fun_asr_nano", "fun_asr_nano_2512_q8_0", "FunAudioLLM/Fun-ASR-Nano-2512-GGUF", "ce72677f84900f0dc57f498ace253bfb3c9155b6", "fun-asr-nano-2512-q8_0.gguf", "4d727357574b079b7f43336b2930f39da086ca02f5d8d50872090b4c1c3d5e0a"},
		{"fun_asr_nano", "fun_asr_nano_2512_f16", "FunAudioLLM/Fun-ASR-Nano-2512-GGUF", "ce72677f84900f0dc57f498ace253bfb3c9155b6", "fun-asr-nano-2512-f16.gguf", "3d906c3ccfed07efef88ff53d6cc94b788b9d2edf1492a5679d041b43e98c5be"},
	}
	for _, tc := range cases {
		t.Run(tc.id, func(t *testing.T) {
			pkg := resolvePackage(findPackageFamily(tc.family), tc.id)
			if pkg == nil || pkg.ID != tc.id || pkg.Repo != tc.repo || pkg.Revision != tc.commit || len(pkg.Files) != 1 || pkg.Files[0].Remote != tc.remote || pkg.Files[0].SHA256 != tc.hash {
				t.Fatalf("unexpected pilot metadata for %s: %+v", tc.id, pkg)
			}
			if !packageHasExpectedSHA256(pkg) {
				t.Fatal("pinned package missing expected digest")
			}
			if _, err := validateExpectedSHA256(pkg.Files[0].SHA256); err != nil {
				t.Fatal(err)
			}
			url := buildResolveURL("https://huggingface.co", pkg.Repo, pkg.Revision, pkg.Files[0].Remote)
			if !strings.Contains(url, "/resolve/"+tc.commit+"/") || strings.Contains(url, "/resolve/main/") {
				t.Fatalf("mutable URL for pilot: %s", url)
			}
		})
	}
}

func TestPilotMirrorFailsClosedWithoutDownloader(t *testing.T) {
	tests := []struct{ family, id string }{
		{"ming3_tts", "ming3_tts_q8_0"},
		{"ming3_tts", "ming3_tts_bf16"},
		{"ming3_tts_voicedesign", "ming3_tts_voicedesign_q8_0"},
		{"ming3_tts_voicedesign", "ming3_tts_voicedesign_bf16"},
		{"kokoro_tts", "kokoro_82m_q8_0"},
		{"kokoro_tts", "kokoro_82m_bf16"},
		{"fun_asr_nano", "fun_asr_nano_2512_q8_0"},
		{"fun_asr_nano", "fun_asr_nano_2512_f16"},
	}
	h := &Hub{} // no downloader or network configured: rejection must happen first
	for _, tc := range tests {
		t.Run(tc.id, func(t *testing.T) {
			payload, _ := json.Marshal(map[string]string{"modelId": tc.family, "packageId": tc.id, "source": "modelscope"})
			req := httptest.NewRequest("POST", "/api/downloads", strings.NewReader(string(payload)))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			h.handleDownloadCreate(rec, req)
			if rec.Code != 400 || !strings.Contains(rec.Body.String(), "PACKAGE_MIRROR_UNVERIFIED") {
				t.Fatalf("unverified mirror not blocked offline: %d %s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestLegacyUnhashedPackagesKeepMirrorEligibility(t *testing.T) {
	pkg := resolvePackage(findPackageFamily("rvc"), "rvc_f16")
	if pkg == nil || packageHasExpectedSHA256(pkg) {
		t.Fatalf("legacy package changed: %+v", pkg)
	}
	if packageHasExpectedSHA256(nil) {
		t.Fatal("nil package is not verified")
	}
}
