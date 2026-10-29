package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

// Source-side provider LFS SHA-256 values in the documented immutable snapshot;
// all API requests are fictional and in-memory, with no weight downloads.
var qwen207Batch = []struct{ family, id, remote, sha256 string }{
	{"qwen3_asr", "qwen3_asr_0_6b_f16", "Qwen3-ASR-0.6B-GGUF/qwen3-asr-0.6b-f16.gguf", "490fefbe91b33e1a0aeb988b97b983d3b95ecd225195e3ca5025ed00923e94d2"},
	{"qwen3_asr", "qwen3_asr_0_6b_q8_0", "Qwen3-ASR-0.6B-GGUF/qwen3-asr-0.6b-q8_0.gguf", "5c53bbb9a6b2ade85c16c290c560658ca18b78a23c323378528f1f945683fcbe"},
	{"qwen3_asr", "qwen3_asr_1_7b_f16", "Qwen3-ASR-1.7B-GGUF/qwen3-asr-1.7b-f16.gguf", "59baf62f2454a1b4d1d9ffed730dbf1d0bce28ed6fec30897de17f9d6d452fc3"},
	{"qwen3_asr", "qwen3_asr_1_7b_q8_0", "Qwen3-ASR-1.7B-GGUF/qwen3-asr-1.7b-q8_0.gguf", "3bc2462eca3a3a8f56abcd860d0943ffdc0546547dde55a9d08589607d6f3936"},
	{"qwen3_forced_aligner", "qwen3_forced_aligner_0_6b_f16", "Qwen3-ForcedAligner-0.6B-GGUF/qwen3-forced-aligner-0.6b-f16.gguf", "38c413223c5e20d20bf43e0aee488fbd7df54a153b2f40d9dea5be5be73bbb8f"},
	{"qwen3_forced_aligner", "qwen3_forced_aligner_0_6b_q8_0", "Qwen3-ForcedAligner-0.6B-GGUF/qwen3-forced-aligner-0.6b-q8_0.gguf", "bf4fec616f77a20d89a649cd1c97bda269644eeb3cf906d1f7488a52d71f7cb2"},
}

const qwen207SharedCommit = "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8"

func TestQwen207PinnedMetadataAndStrictSHA(t *testing.T) {
	for _, tc := range qwen207Batch {
		t.Run(tc.id, func(t *testing.T) {
			pkg := resolvePackage(findPackageFamily(tc.family), tc.id)
			if pkg == nil || pkg.Repo != "audio-cpp/audio.cpp-gguf" || pkg.Revision != qwen207SharedCommit || len(pkg.Files) != 1 || pkg.Files[0].Remote != tc.remote || pkg.Files[0].SHA256 != tc.sha256 {
				t.Fatalf("incorrect immutable package metadata: %+v", pkg)
			}
			if !packageHasExpectedSHA256(pkg) {
				t.Fatal("missing required hash")
			}
			digest, err := validateExpectedSHA256(pkg.Files[0].SHA256)
			if err != nil || digest != tc.sha256 {
				t.Fatalf("wrong expected digest: %v", err)
			}
			url := buildResolveURL("https://huggingface.co", pkg.Repo, pkg.Revision, pkg.Files[0].Remote)
			if !strings.Contains(url, "/resolve/"+qwen207SharedCommit+"/") || strings.Contains(url, "/resolve/main/") {
				t.Fatalf("unexpected mutable source %q", url)
			}
		})
	}
}

func TestQwen207MirrorFailsClosedBeforeDownload(t *testing.T) {
	h := &Hub{} // deliberately no downloader or network
	for _, tc := range qwen207Batch {
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
				t.Fatalf("unverified ModelScope mirror allowed: %d %q", response.Code, response.Body.String())
			}
		})
	}
}

func TestQwen207DoesNotChangeLegacyOrPriorPins(t *testing.T) {
	legacy := resolvePackage(findPackageFamily("rvc"), "rvc_f16")
	if legacy == nil || legacy.Revision != "main" || packageHasExpectedSHA256(legacy) {
		t.Fatalf("legacy source unexpectedly altered: %+v", legacy)
	}
	prior := resolvePackage(findPackageFamily("ace_step"), "ace_step_base_bf16")
	if prior == nil || prior.Revision != qwen207SharedCommit || !packageHasExpectedSHA256(prior) {
		t.Fatalf("earlier #219 pin regressed: %+v", prior)
	}
	upstream := resolvePackage(findPackageFamily("qwen3_asr"), "qwen3_asr_1_7b_safetensors")
	if upstream == nil || upstream.Revision != "main" || packageHasExpectedSHA256(upstream) {
		t.Fatalf("mixed Git/LFS safetensors package unexpectedly changed: %+v", upstream)
	}
}
