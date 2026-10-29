package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

// Exact immutable upstream metadata established by two Hugging Face metadata
// interfaces; these fictional HTTP tests do not fetch or execute weights.
var provenanceBatch207 = []struct{ family, id, remote, sha256 string }{
	{"ace_step", "ace_step_base_bf16", "ACE-Step1.5-GGUF/base/ace-step-1.5-base-bf16.gguf", "d5bb61554bd8669ba5498054422e7a771414257d77acc47b3953e5da8c98836f"},
	{"ace_step", "ace_step_base_q8_0", "ACE-Step1.5-GGUF/base/ace-step-1.5-base-q8_0.gguf", "2fb7bc3627c79bc99486510619d4264da22d40814edff0415dd3337164336e4a"},
	{"ace_step", "ace_step_turbo_bf16", "ACE-Step1.5-GGUF/turbo/ace-step-1.5-turbo-bf16.gguf", "7aa8cc911bb7e47647bba619cf25afc22a42e35c568a102cd9a3b28a54b94013"},
	{"ace_step", "ace_step_turbo_q8_0", "ACE-Step1.5-GGUF/turbo/ace-step-1.5-turbo-q8_0.gguf", "1f0015f81c10a1182531e6207c7aeaa060b8cad3470a2f88daa3cb74ed636e63"},
	{"miocodec", "miocodec_f16", "MioCodec-25Hz-44.1kHz-v2-GGUF/miocodec-25hz-44khz-v2-f16.gguf", "6b921c62f66839ca6849e53252987a76b44950f1f3e2e0c03bcd34526a4558f4"},
	{"miocodec", "miocodec_orig", "MioCodec-25Hz-44.1kHz-v2-GGUF/miocodec-25hz-44khz-v2-orig.gguf", "997190af1b7a302bf037942a5aa78434d261d8c4fe54bf03f52a380aa8656868"},
	{"miocodec", "miocodec_q8_0", "MioCodec-25Hz-44.1kHz-v2-GGUF/miocodec-25hz-44khz-v2-q8_0.gguf", "f785604da457327caf26e4f0fc14bd4b8aac20116d6612e9076a386071f3a05b"},
	{"vibevoice_asr", "vibevoice_asr_f16", "VibeVoice-ASR-GGUF/vibevoice-asr-f16.gguf", "7858c8551dd623158e6e03b84ebc9fbf7021f67069c4d26e95c0dca6a713e67c"},
	{"vibevoice_asr", "vibevoice_asr_q8_0", "VibeVoice-ASR-GGUF/vibevoice-asr-q8_0.gguf", "6cefa920277f13d102c0014397044c52b63aa02e1a54f519e1732e04217859f8"},
}

const provenanceBatch207Commit = "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8"

func TestBatch207PinnedHashesAndSourceURLs(t *testing.T) {
	for _, tc := range provenanceBatch207 {
		t.Run(tc.id, func(t *testing.T) {
			p := resolvePackage(findPackageFamily(tc.family), tc.id)
			if p == nil || p.ID != tc.id || p.Repo != "audio-cpp/audio.cpp-gguf" || p.Revision != provenanceBatch207Commit || len(p.Files) != 1 || p.Files[0].Remote != tc.remote || p.Files[0].SHA256 != tc.sha256 {
				t.Fatalf("incorrect pinned metadata for %s: %+v", tc.id, p)
			}
			sha, err := validateExpectedSHA256(p.Files[0].SHA256)
			if err != nil || sha != tc.sha256 || !packageHasExpectedSHA256(p) {
				t.Fatalf("missing or invalid SHA-256 for %s: %v", tc.id, err)
			}
			endpoint := buildResolveURL("https://huggingface.co", p.Repo, p.Revision, p.Files[0].Remote)
			if !strings.Contains(endpoint, "/resolve/"+provenanceBatch207Commit+"/") || strings.Contains(endpoint, "/resolve/main/") {
				t.Fatalf("un-pinned model URL %q", endpoint)
			}
		})
	}
}

func TestBatch207ModelScopeRejectedBeforeDownloader(t *testing.T) {
	h := &Hub{} // no downloader configured: source selection must fail first
	for _, tc := range provenanceBatch207 {
		t.Run(tc.id, func(t *testing.T) {
			body, err := json.Marshal(map[string]string{"modelId": tc.family, "packageId": tc.id, "source": "modelscope"})
			if err != nil {
				t.Fatal(err)
			}
			r := httptest.NewRequest("POST", "/api/downloads", strings.NewReader(string(body)))
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			h.handleDownloadCreate(w, r)
			if w.Code != 400 || !strings.Contains(w.Body.String(), "PACKAGE_MIRROR_UNVERIFIED") {
				t.Fatalf("untrusted mirror not rejected before network: HTTP %d: %q", w.Code, w.Body.String())
			}
		})
	}
}

func TestBatch207LegacyAndEarlierPinsUnaffected(t *testing.T) {
	legacy := resolvePackage(findPackageFamily("rvc"), "rvc_f16")
	if legacy == nil || legacy.Revision != "main" || packageHasExpectedSHA256(legacy) {
		t.Fatalf("unhashed legacy package no longer unchanged: %+v", legacy)
	}
	prev := resolvePackage(findPackageFamily("vibevoice"), "vibevoice_1_5b_q8_0")
	if prev == nil || prev.Revision != provenanceBatch207Commit || !packageHasExpectedSHA256(prev) {
		t.Fatalf("previous #217 pinned model regressed: %+v", prev)
	}
}
