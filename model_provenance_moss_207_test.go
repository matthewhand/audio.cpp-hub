package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

// SHA-256 entries are provider metadata cross-checked against immutable
// Git-LFS tree + no-redirect HEAD. These tests use fictional in-memory HTTP.
var moss207Batch = []struct{ family, id, remote, sha256 string }{
	{"moss_transcribe_diarize", "moss_transcribe_diarize_bf16", "MOSS-Transcribe-Diarize-GGUF/moss-transcribe-diarize-bf16.gguf", "5bc627289e2586fc2d9269afda15a305e545a4ff3512c902889be71d58e56ad5"},
	{"moss_transcribe_diarize", "moss_transcribe_diarize_q4_k", "MOSS-Transcribe-Diarize-GGUF/moss-transcribe-diarize-q4_k.gguf", "4e3020379ff592bbb22a4e3d47a7cd6709951cc5d451c561b69df955b5f0a220"},
	{"moss_transcribe_diarize", "moss_transcribe_diarize_q8_0", "MOSS-Transcribe-Diarize-GGUF/moss-transcribe-diarize-q8_0.gguf", "93eea5865615e270b827752945f2dfd0f522ed673f4f551675e9013170173679"},
	{"moss_tts_nano", "moss_tts_nano_100m_bf16", "MOSS-TTS-Nano-100M-GGUF/moss-tts-nano-100m-bf16.gguf", "ea44b602f3fbd6e18d505c48533035bf2db604e929117abcd05d2d77b8f786c8"},
	{"moss_tts_nano", "moss_tts_nano_100m_q8_0", "MOSS-TTS-Nano-100M-GGUF/moss-tts-nano-100m-q8_0.gguf", "823b0de64f01f1ee9a168356c1199be500d71ec2f769f0183b416c9e6dbc0abc"},
}

const moss207Snapshot = "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8"

func TestMoss207ExactPinnedDigests(t *testing.T) {
	for _, tc := range moss207Batch {
		t.Run(tc.id, func(t *testing.T) {
			pkg := resolvePackage(findPackageFamily(tc.family), tc.id)
			if pkg == nil || pkg.ID != tc.id || pkg.Repo != "audio-cpp/audio.cpp-gguf" || pkg.Revision != moss207Snapshot || len(pkg.Files) != 1 || pkg.Files[0].Remote != tc.remote || pkg.Files[0].SHA256 != tc.sha256 {
				t.Fatalf("incorrect immutable package metadata: %+v", pkg)
			}
			if !packageHasExpectedSHA256(pkg) {
				t.Fatal("expected SHA-256 missing")
			}
			digest, err := validateExpectedSHA256(pkg.Files[0].SHA256)
			if err != nil || digest != tc.sha256 {
				t.Fatalf("expected digest invalid: %v", err)
			}
			url := buildResolveURL("https://huggingface.co", pkg.Repo, pkg.Revision, pkg.Files[0].Remote)
			if !strings.Contains(url, "/resolve/"+moss207Snapshot+"/") || strings.Contains(url, "/resolve/main/") {
				t.Fatalf("mutable source URL: %s", url)
			}
		})
	}
}

func TestMoss207UnverifiedMirrorFailsClosed(t *testing.T) {
	h := &Hub{} // deliberately no downloader: no task or network may be used
	for _, tc := range moss207Batch {
		t.Run(tc.id, func(t *testing.T) {
			body, err := json.Marshal(map[string]string{"modelId": tc.family, "packageId": tc.id, "source": "modelscope"})
			if err != nil {
				t.Fatal(err)
			}
			req := httptest.NewRequest("POST", "/api/downloads", strings.NewReader(string(body)))
			req.Header.Set("Content-Type", "application/json")
			resp := httptest.NewRecorder()
			h.handleDownloadCreate(resp, req)
			if resp.Code != 400 || !strings.Contains(resp.Body.String(), "PACKAGE_MIRROR_UNVERIFIED") {
				t.Fatalf("unverified mirror accepted: %d %q", resp.Code, resp.Body.String())
			}
		})
	}
}

func TestMoss207PriorPinsAndUnhashedLegacyRemain(t *testing.T) {
	prior := resolvePackage(findPackageFamily("qwen3_asr"), "qwen3_asr_0_6b_q8_0")
	if prior == nil || prior.Revision != moss207Snapshot || !packageHasExpectedSHA256(prior) {
		t.Fatalf("prior #220 pin regressed: %+v", prior)
	}
	legacy := resolvePackage(findPackageFamily("rvc"), "rvc_f16")
	if legacy == nil || legacy.Revision != "main" || packageHasExpectedSHA256(legacy) {
		t.Fatalf("legacy unhashed routing changed: %+v", legacy)
	}
	notInBatch := resolvePackage(findPackageFamily("moss_tts_local"), "moss_tts_local_v1_5_q8_0")
	if notInBatch == nil || notInBatch.Revision != "main" || packageHasExpectedSHA256(notInBatch) {
		t.Fatalf("excluded MOSS family changed: %+v", notInBatch)
	}
}
