package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

// SHA-256 expectations are provider LFS tree and HEAD metadata, verified at a pinned commit.
// All HTTP calls are fictional and in-memory; no weights are downloaded.
var qwenTTS207Batch = []struct{ family, id, remote, sha string }{
	{"qwen3_tts_customvoice", "qwen3_tts_1_7b_customvoice_bf16", "Qwen3-TTS-12Hz-1.7B-CustomVoice-GGUF/qwen3-tts-12hz-1.7b-customvoice-bf16.gguf", "5be0742e196ea9cd9ce0d7d8b69b0fc4fa8181b06cb0bd0591fb1dcdfce6c5a5"},
	{"qwen3_tts_customvoice", "qwen3_tts_1_7b_customvoice_q8_0", "Qwen3-TTS-12Hz-1.7B-CustomVoice-GGUF/qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf", "c8ac3f94b6e73f137c0e7ecc9270bc8faec7a476ff799b87e48844d1d0987ac3"},
}

const qwenTTS207Commit = "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8"

func TestQwenTTS207ExactPinsAndStrictHashes(t *testing.T) {
	for _, tc := range qwenTTS207Batch {
		t.Run(tc.id, func(t *testing.T) {
			p := resolvePackage(findPackageFamily(tc.family), tc.id)
			if p == nil || p.ID != tc.id || p.Repo != "audio-cpp/audio.cpp-gguf" || p.Revision != qwenTTS207Commit || len(p.Files) != 1 || p.Files[0].Remote != tc.remote || p.Files[0].SHA256 != tc.sha {
				t.Fatalf("incorrect immutable package: %+v", p)
			}
			if !packageHasExpectedSHA256(p) {
				t.Fatal("expected SHA-256 absent")
			}
			digest, err := validateExpectedSHA256(p.Files[0].SHA256)
			if err != nil || digest != tc.sha {
				t.Fatalf("invalid strict SHA-256: %v", err)
			}
			u := buildResolveURL("https://huggingface.co", p.Repo, p.Revision, p.Files[0].Remote)
			if !strings.Contains(u, "/resolve/"+qwenTTS207Commit+"/") || strings.Contains(u, "/resolve/main/") {
				t.Fatalf("mutable source %q", u)
			}
		})
	}
}

func TestQwenTTS207ModelScopeFailsClosedWithoutDownloader(t *testing.T) {
	h := &Hub{} // no downloader; cross-provider guard must run first
	for _, tc := range qwenTTS207Batch {
		t.Run(tc.id, func(t *testing.T) {
			body, err := json.Marshal(map[string]string{"modelId": tc.family, "packageId": tc.id, "source": "modelscope"})
			if err != nil {
				t.Fatal(err)
			}
			req := httptest.NewRequest("POST", "/api/downloads", strings.NewReader(string(body)))
			req.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			h.handleDownloadCreate(response, req)
			if response.Code != 400 || !strings.Contains(response.Body.String(), "PACKAGE_MIRROR_UNVERIFIED") {
				t.Fatalf("unsafe mirror accepted: %d %q", response.Code, response.Body.String())
			}
		})
	}
}

func TestQwenTTS207PriorPinsAndUnhashedLegacyRemain(t *testing.T) {
	prior := resolvePackage(findPackageFamily("moss_tts_local"), "moss_tts_local_v1_5_q8_0")
	if prior == nil || prior.Revision != qwenTTS207Commit || !packageHasExpectedSHA256(prior) {
		t.Fatalf("previous pin regressed: %+v", prior)
	}
	legacy := resolvePackage(findPackageFamily("rvc"), "rvc_f16")
	if legacy == nil || legacy.Revision != "main" || packageHasExpectedSHA256(legacy) {
		t.Fatalf("unhashed legacy changed: %+v", legacy)
	}
	excluded := resolvePackage(findPackageFamily("qwen3_tts_voicedesign"), "qwen3_tts_1_7b_voicedesign_q8_0")
	if excluded == nil || excluded.Revision != "main" || packageHasExpectedSHA256(excluded) {
		t.Fatalf("excluded Qwen family unexpectedly changed: %+v", excluded)
	}
}
