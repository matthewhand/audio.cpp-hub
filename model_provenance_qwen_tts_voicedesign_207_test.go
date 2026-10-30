package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

// These tests verify expected digest metadata and syntax only; no model bytes
// are downloaded or hashed. Actual downloader integrity is a separate contract.
var qwenVoice207 = []struct{ family, id, remote, sha string }{
	{"qwen3_tts_voicedesign", "qwen3_tts_1_7b_voicedesign_bf16", "Qwen3-TTS-12Hz-1.7B-VoiceDesign-GGUF/qwen3-tts-12hz-1.7b-voicedesign-bf16.gguf", "f12c79e8c492f006b04f5ba823bebe512c9d46e13a7837081f1d34803b4bac0e"},
	{"qwen3_tts_voicedesign", "qwen3_tts_1_7b_voicedesign_q8_0", "Qwen3-TTS-12Hz-1.7B-VoiceDesign-GGUF/qwen3-tts-12hz-1.7b-voicedesign-q8_0.gguf", "b86e03d1d2077bbaed157ab7a7fc646c3e309e69afa52c5e1c86b622b4715057"},
}

const qwenVoice207Commit = "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8"

func TestQwenVoice207PinnedMetadataAndExpectedDigestFormat(t *testing.T) {
	for _, tc := range qwenVoice207 {
		t.Run(tc.id, func(t *testing.T) {
			p := resolvePackage(findPackageFamily(tc.family), tc.id)
			if p == nil || p.ID != tc.id || p.Repo != "audio-cpp/audio.cpp-gguf" || p.Revision != qwenVoice207Commit || len(p.Files) != 1 || p.Files[0].Remote != tc.remote || p.Files[0].SHA256 != tc.sha {
				t.Fatalf("unexpected immutable metadata: %+v", p)
			}
			if !packageHasExpectedSHA256(p) {
				t.Fatal("expected SHA-256 absent")
			}
			digest, err := validateExpectedSHA256(p.Files[0].SHA256)
			if err != nil || digest != tc.sha {
				t.Fatalf("invalid declared digest syntax: %v", err)
			}
			url := buildResolveURL("https://huggingface.co", p.Repo, p.Revision, p.Files[0].Remote)
			if !strings.Contains(url, "/resolve/"+qwenVoice207Commit+"/") || strings.Contains(url, "/resolve/main/") {
				t.Fatalf("mutable Hugging Face URL: %q", url)
			}
		})
	}
}

func TestQwenVoice207RejectsMalformedExpectedDigestSyntax(t *testing.T) {
	for name, bad := range map[string]string{
		"short-63":   strings.Repeat("a", 63),
		"long-65":    strings.Repeat("a", 65),
		"non-hex-64": "g" + strings.Repeat("a", 63),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := validateExpectedSHA256(bad); err == nil {
				t.Fatalf("accepted malformed declared digest: %q", bad)
			}
		})
	}
}

func TestQwenVoice207UnverifiedModelScopeRejectedBeforeDownload(t *testing.T) {
	h := &Hub{} // no downloader: any access before the fail-closed check is a test failure
	for _, tc := range qwenVoice207 {
		t.Run(tc.id, func(t *testing.T) {
			payload, err := json.Marshal(map[string]string{"modelId": tc.family, "packageId": tc.id, "source": "modelscope"})
			if err != nil {
				t.Fatal(err)
			}
			req := httptest.NewRequest("POST", "/api/downloads", strings.NewReader(string(payload)))
			req.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			h.handleDownloadCreate(response, req)
			if response.Code != 400 || !strings.Contains(response.Body.String(), "PACKAGE_MIRROR_UNVERIFIED") {
				t.Fatalf("unverified mirror not rejected: HTTP %d %q", response.Code, response.Body.String())
			}
		})
	}
}

func TestQwenVoice207PreviousPinsAndUnhashedRemain(t *testing.T) {
	prior := resolvePackage(findPackageFamily("qwen3_tts_customvoice"), "qwen3_tts_1_7b_customvoice_q8_0")
	if prior == nil || prior.Revision != qwenVoice207Commit || !packageHasExpectedSHA256(prior) {
		t.Fatalf("previous Qwen pin regressed: %+v", prior)
	}
	legacy := resolvePackage(findPackageFamily("rvc"), "rvc_f16")
	if legacy == nil || legacy.Revision != "main" || packageHasExpectedSHA256(legacy) {
		t.Fatalf("legacy unhashed contract regressed: %+v", legacy)
	}
	excluded := resolvePackage(findPackageFamily("qwen3_tts_base"), "qwen3_tts_1_7b_base_q8_0")
	if excluded == nil || excluded.Revision != "main" || packageHasExpectedSHA256(excluded) {
		t.Fatalf("excluded Qwen family changed: %+v", excluded)
	}
}
