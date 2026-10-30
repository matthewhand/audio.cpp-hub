package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

// Synthetic in-memory tests of declared expected-hash metadata and source selection.
// No model bytes are fetched or hashed and no real download task can be created.
var parakeetTDT207 = []struct{ family, id, remote, sha string }{
	{"parakeet_tdt", "parakeet_tdt_f16", "Parakeet-TDT-0.6B-v3-GGUF/parakeet-tdt-0.6b-v3-f16.gguf", "1720770887bbb6ae633b3375c6ce4b76b3eaff9cd4efd7b890db734cc0adfe80"},
	{"parakeet_tdt", "parakeet_tdt_q8_0", "Parakeet-TDT-0.6B-v3-GGUF/parakeet-tdt-0.6b-v3-q8_0.gguf", "6fa498f10f8cb606f041aa9512733cfee842a932359b00b0c45b9b723c4f4f4b"},
}

const parakeetTDT207Commit = "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8"

func TestParakeetTDT207ImmutableSHA256Metadata(t *testing.T) {
	for _, tc := range parakeetTDT207 {
		t.Run(tc.id, func(t *testing.T) {
			pkg := resolvePackage(findPackageFamily(tc.family), tc.id)
			if pkg == nil || pkg.ID != tc.id || pkg.Repo != "audio-cpp/audio.cpp-gguf" || pkg.Revision != parakeetTDT207Commit || len(pkg.Files) != 1 || pkg.Files[0].Remote != tc.remote || pkg.Files[0].SHA256 != tc.sha {
				t.Fatalf("wrong pinned package metadata: %+v", pkg)
			}
			if !packageHasExpectedSHA256(pkg) {
				t.Fatal("expected SHA-256 missing")
			}
			expected, err := validateExpectedSHA256(pkg.Files[0].SHA256)
			if err != nil || expected != tc.sha {
				t.Fatalf("invalid declared SHA-256: %v", err)
			}
			url := buildResolveURL("https://huggingface.co", pkg.Repo, pkg.Revision, pkg.Files[0].Remote)
			if !strings.Contains(url, "/resolve/"+parakeetTDT207Commit+"/") || strings.Contains(url, "/resolve/main/") {
				t.Fatalf("mutable Hugging Face URL: %q", url)
			}
		})
	}
}

func TestParakeetTDT207RejectsBadExpectedSHA256Strings(t *testing.T) {
	for name, bad := range map[string]string{
		"63-hex":    strings.Repeat("a", 63),
		"65-hex":    strings.Repeat("a", 65),
		"64-nonhex": "g" + strings.Repeat("a", 63),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := validateExpectedSHA256(bad); err == nil {
				t.Fatalf("accepted malformed declared SHA-256: %q", bad)
			}
		})
	}
}

func TestParakeetTDT207ModelScopeMirrorMustRejectBeforeDownloader(t *testing.T) {
	h := &Hub{} // Deliberate fail-closed sentinel; any premature config/task use must fail.
	for _, tc := range parakeetTDT207 {
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
				t.Fatalf("mirror not rejected: HTTP %d %q", resp.Code, resp.Body.String())
			}
		})
	}
}

func TestParakeetTDT207PriorAndUnhashedPackagesUnaffected(t *testing.T) {
	prior := resolvePackage(findPackageFamily("voxtral_realtime"), "voxtral_realtime_q8_0")
	if prior == nil || prior.Revision != parakeetTDT207Commit || !packageHasExpectedSHA256(prior) {
		t.Fatalf("prior Voxtral immutable hash regressed: %+v", prior)
	}
	legacy := resolvePackage(findPackageFamily("rvc"), "rvc_f16")
	if legacy == nil || legacy.Revision != "main" || packageHasExpectedSHA256(legacy) {
		t.Fatalf("unhashed RVC legacy regressed: %+v", legacy)
	}
	excluded := resolvePackage(findPackageFamily("voxtral_realtime"), "voxtral_realtime_q4_k")
	if excluded == nil || excluded.Revision != "main" || packageHasExpectedSHA256(excluded) {
		t.Fatalf("unhashed Voxtral Q4_K unexpectedly changed: %+v", excluded)
	}
}
