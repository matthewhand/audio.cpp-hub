package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

// Provider LFS SHA-256 source metadata is checked against a pinned tree and
// separate HEAD. Requests below are fictional and in-memory, no model files.
var mossLocal207 = []struct{ family, id, remote, sha string }{
	{"moss_tts_local", "moss_tts_local_v1_5_bf16", "MOSS-TTS-Local-v1.5-GGUF/moss-tts-local-v1.5-bf16.gguf", "293d590dcf8c01686762af605cdc11b7aade5e328ea2b091150e09839794d57f"},
	{"moss_tts_local", "moss_tts_local_v1_5_q8_0", "MOSS-TTS-Local-v1.5-GGUF/moss-tts-local-v1.5-q8_0.gguf", "d465210814e60cc09224b33bf272bde519c871dda76997a8c17aed4878d1ba9a"},
}

const mossLocal207Commit = "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8"

func TestMossLocal207ExactPinsAndIntegrity(t *testing.T) {
	for _, tc := range mossLocal207 {
		t.Run(tc.id, func(t *testing.T) {
			p := resolvePackage(findPackageFamily(tc.family), tc.id)
			if p == nil || p.ID != tc.id || p.Repo != "audio-cpp/audio.cpp-gguf" || p.Revision != mossLocal207Commit || len(p.Files) != 1 || p.Files[0].Remote != tc.remote || p.Files[0].SHA256 != tc.sha {
				t.Fatalf("wrong immutable source: %+v", p)
			}
			if !packageHasExpectedSHA256(p) {
				t.Fatal("expected digest absent")
			}
			digest, err := validateExpectedSHA256(p.Files[0].SHA256)
			if err != nil || digest != tc.sha {
				t.Fatalf("invalid expected SHA-256: %v", err)
			}
			u := buildResolveURL("https://huggingface.co", p.Repo, p.Revision, p.Files[0].Remote)
			if !strings.Contains(u, "/resolve/"+mossLocal207Commit+"/") || strings.Contains(u, "/resolve/main/") {
				t.Fatalf("un-pinned URL: %q", u)
			}
		})
	}
}

func TestMossLocal207RejectsUnverifiedModelScopeBeforeDownload(t *testing.T) {
	h := &Hub{} // intentionally no downloader: this rejection must occur first
	for _, tc := range mossLocal207 {
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
				t.Fatalf("unsafe mirror accepted: HTTP %d %q", response.Code, response.Body.String())
			}
		})
	}
}

func TestMossLocal207LegacyAndPriorPinsUnaffected(t *testing.T) {
	prior := resolvePackage(findPackageFamily("moss_tts_nano"), "moss_tts_nano_100m_q8_0")
	if prior == nil || prior.Revision != mossLocal207Commit || !packageHasExpectedSHA256(prior) {
		t.Fatalf("prior pinned family changed: %+v", prior)
	}
	legacy := resolvePackage(findPackageFamily("rvc"), "rvc_f16")
	if legacy == nil || legacy.Revision != "main" || packageHasExpectedSHA256(legacy) {
		t.Fatalf("unhashed legacy changed: %+v", legacy)
	}
}
