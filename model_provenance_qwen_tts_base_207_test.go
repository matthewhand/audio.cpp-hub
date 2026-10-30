package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

// These fictional in-memory tests check expected metadata format and resolver behavior.
// No model bytes are fetched or hashed; actual downloader verification is separate.
var qwenBase207 = []struct{ family, id, remote, sha string }{
	{"qwen3_tts_base", "qwen3_tts_1_7b_base_bf16", "Qwen3-TTS-12Hz-1.7B-Base-GGUF/qwen3-tts-12hz-1.7b-base-bf16.gguf", "db237375e0f04d10fd0ac0afc2855e6844fdcb04a7d471e8a4b6c36bdb6030d7"},
	{"qwen3_tts_base", "qwen3_tts_1_7b_base_q8_0", "Qwen3-TTS-12Hz-1.7B-Base-GGUF/qwen3-tts-12hz-1.7b-base-q8_0_v2.gguf", "92641a8022d521efd79a5db45e952589b3f2b781680f9abfcf26f075d37b86c6"},
}

const qwenBase207Commit = "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8"

func TestQwenBase207PinnedMetadataAndExpectedDigestFormat(t *testing.T) {
	for _, tc := range qwenBase207 {
		t.Run(tc.id, func(t *testing.T) {
			p := resolvePackage(findPackageFamily(tc.family), tc.id)
			if p == nil || p.ID != tc.id || p.Repo != "audio-cpp/audio.cpp-gguf" || p.Revision != qwenBase207Commit || len(p.Files) != 1 || p.Files[0].Remote != tc.remote || p.Files[0].SHA256 != tc.sha {
				t.Fatalf("wrong immutable metadata: %+v", p)
			}
			if !packageHasExpectedSHA256(p) {
				t.Fatal("expected digest absent")
			}
			parsed, err := validateExpectedSHA256(p.Files[0].SHA256)
			if err != nil || parsed != tc.sha {
				t.Fatalf("invalid expected digest format: %v", err)
			}
			url := buildResolveURL("https://huggingface.co", p.Repo, p.Revision, p.Files[0].Remote)
			if !strings.Contains(url, "/resolve/"+qwenBase207Commit+"/") || strings.Contains(url, "/resolve/main/") {
				t.Fatalf("mutable resolution URL: %q", url)
			}
		})
	}
}

func TestQwenBase207RejectsMalformedDigestFormats(t *testing.T) {
	for name, bad := range map[string]string{
		"short-63":   strings.Repeat("a", 63),
		"long-65":    strings.Repeat("a", 65),
		"non-hex-64": "g" + strings.Repeat("a", 63),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := validateExpectedSHA256(bad); err == nil {
				t.Fatalf("malformed declared digest accepted: %q", bad)
			}
		})
	}
}

func TestQwenBase207UnverifiedModelScopeFailsBeforeDownloader(t *testing.T) {
	h := &Hub{} // no downloader or config; mirror check must reject first
	for _, tc := range qwenBase207 {
		t.Run(tc.id, func(t *testing.T) {
			data, err := json.Marshal(map[string]string{"modelId": tc.family, "packageId": tc.id, "source": "modelscope"})
			if err != nil {
				t.Fatal(err)
			}
			req := httptest.NewRequest("POST", "/api/downloads", strings.NewReader(string(data)))
			req.Header.Set("Content-Type", "application/json")
			resp := httptest.NewRecorder()
			h.handleDownloadCreate(resp, req)
			if resp.Code != 400 || !strings.Contains(resp.Body.String(), "PACKAGE_MIRROR_UNVERIFIED") {
				t.Fatalf("unverified mirror not rejected: HTTP %d %q", resp.Code, resp.Body.String())
			}
		})
	}
}

func TestQwenBase207PriorPinsAndUnhashedOrigRemain(t *testing.T) {
	prior := resolvePackage(findPackageFamily("qwen3_tts_voicedesign"), "qwen3_tts_1_7b_voicedesign_q8_0")
	if prior == nil || prior.Revision != qwenBase207Commit || !packageHasExpectedSHA256(prior) {
		t.Fatalf("prior pinned family regressed: %+v", prior)
	}
	orig := resolvePackage(findPackageFamily("qwen3_tts_base"), "qwen3_tts_1_7b_base_orig")
	if orig == nil || orig.Revision != "main" || packageHasExpectedSHA256(orig) {
		t.Fatalf("unhashed Base orig changed: %+v", orig)
	}
	legacy := resolvePackage(findPackageFamily("rvc"), "rvc_f16")
	if legacy == nil || legacy.Revision != "main" || packageHasExpectedSHA256(legacy) {
		t.Fatalf("legacy unhashed entry changed: %+v", legacy)
	}
}
