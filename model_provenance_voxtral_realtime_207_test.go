package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

// All HTTP activity is fictional and in-memory; these tests assert the expected
// digest string metadata and mirror safety, NOT model-byte hashing.
var voxtral207 = []struct{ family, id, remote, sha string }{
	{"voxtral_realtime", "voxtral_realtime_bf16", "Voxtral-Mini-4B-Realtime-2602-GGUF/voxtral-mini-4b-realtime-2602-bf16.gguf", "8970c7c1ce0c1db94da79a44f7c65e098d228bdb293d6ff31ede446d58a89e20"},
	{"voxtral_realtime", "voxtral_realtime_q8_0", "Voxtral-Mini-4B-Realtime-2602-GGUF/voxtral-mini-4b-realtime-2602-q8_0.gguf", "d246cf359a34e365440e7af5064ff01fa54d8a9848d2127907d1864d1131fef3"},
}

const voxtral207Commit = "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8"

func TestVoxtral207PinnedMetadataAndExpectedHashFormat(t *testing.T) {
	for _, tc := range voxtral207 {
		t.Run(tc.id, func(t *testing.T) {
			p := resolvePackage(findPackageFamily(tc.family), tc.id)
			if p == nil || p.ID != tc.id || p.Repo != "audio-cpp/audio.cpp-gguf" || p.Revision != voxtral207Commit || len(p.Files) != 1 || p.Files[0].Remote != tc.remote || p.Files[0].SHA256 != tc.sha {
				t.Fatalf("wrong immutable package metadata: %+v", p)
			}
			if !packageHasExpectedSHA256(p) {
				t.Fatal("missing expected SHA-256")
			}
			digest, err := validateExpectedSHA256(p.Files[0].SHA256)
			if err != nil || digest != tc.sha {
				t.Fatalf("bad expected hash string: %v", err)
			}
			url := buildResolveURL("https://huggingface.co", p.Repo, p.Revision, p.Files[0].Remote)
			if !strings.Contains(url, "/resolve/"+voxtral207Commit+"/") || strings.Contains(url, "/resolve/main/") {
				t.Fatalf("mutable resolve URL %q", url)
			}
		})
	}
}

func TestVoxtral207MalformedExpectedDigestsFailClosed(t *testing.T) {
	for name, bad := range map[string]string{
		"63-hex":    strings.Repeat("a", 63),
		"65-hex":    strings.Repeat("a", 65),
		"64-nonhex": "g" + strings.Repeat("a", 63),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := validateExpectedSHA256(bad); err == nil {
				t.Fatalf("accepted malformed expected hash: %q", bad)
			}
		})
	}
}

func TestVoxtral207UnverifiedModelScopeFailsBeforeDownloader(t *testing.T) {
	h := &Hub{} // No downloader available; guard must reject before any task creation
	for _, tc := range voxtral207 {
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
				t.Fatalf("unverified mirror accepted HTTP %d %q", response.Code, response.Body.String())
			}
		})
	}
}

func TestVoxtral207ExistingPackagesStayCompatible(t *testing.T) {
	excluded := resolvePackage(findPackageFamily("voxtral_realtime"), "voxtral_realtime_q4_k")
	if excluded == nil || excluded.Revision != "main" || packageHasExpectedSHA256(excluded) {
		t.Fatalf("excluded Voxtral Q4_K changed: %+v", excluded)
	}
	prior := resolvePackage(findPackageFamily("qwen3_tts_base"), "qwen3_tts_1_7b_base_q8_0")
	if prior == nil || prior.Revision != voxtral207Commit || !packageHasExpectedSHA256(prior) {
		t.Fatalf("prior Qwen pin regressed: %+v", prior)
	}
	legacy := resolvePackage(findPackageFamily("rvc"), "rvc_f16")
	if legacy == nil || legacy.Revision != "main" || packageHasExpectedSHA256(legacy) {
		t.Fatalf("legacy unhashed package changed: %+v", legacy)
	}
}
