package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

// Source evidence for these public SHA-256 values is documented in
// docs/model-provenance-shared-gguf-207.md. No model content is downloaded.
func TestSharedGGUFLicenseReviewedPins(t *testing.T) {
	cases := []struct{ family, id, path, commit, sha string }{
		{"chatterbox", "chatterbox_f16", "Chatterbox-GGUF/chatterbox-f16.gguf", "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8", "615371181a0bffe8239cf6f724d57f2b153618c52c31d526c8f20eacc763c6e1"},
		{"chatterbox", "chatterbox_q8_0", "Chatterbox-GGUF/chatterbox-q8_0.gguf", "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8", "45d71d8d248ba831014813bbbbba74c7d786dd9447c02090fe05c44344f69453"},
		{"irodori_tts", "irodori_tts_500m_v3_f16", "Irodori-TTS-500M-v3-GGUF/irodori-tts-500m-v3-f16.gguf", "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8", "d8cb39d6dd6929eb4de1c3e8f508d4322402d3424b553cf52006d5ef2d37546b"},
		{"irodori_tts", "irodori_tts_500m_v3_q8_0", "Irodori-TTS-500M-v3-GGUF/irodori-tts-500m-v3-q8_0.gguf", "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8", "2442786d5e4c102759bac44b87b8ed987ba66fd6af640f6dc1b98598af1485a3"},
		{"irodori_tts", "irodori_tts_600m_v3_voicedesign_f16", "Irodori-TTS-600M-v3-VoiceDesign-GGUF/irodori-tts-600m-v3-voicedesign-f16.gguf", "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8", "006ec83aff079162a7a3aa038de9a57fa3d81ad47ed845c4a435e39ad206e6f1"},
		{"irodori_tts", "irodori_tts_600m_v3_voicedesign_q8_0", "Irodori-TTS-600M-v3-VoiceDesign-GGUF/irodori-tts-600m-v3-voicedesign-q8_0.gguf", "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8", "e7bb696b9fa59b59fb51935a3db08c0552c383cc1f2ad8927544864f672e4527"},
		{"irodori_tts", "irodori_tts_v4_small_f16", "Irodori-TTS-v4-Small-GGUF/irodori-tts-v4-small-f16.gguf", "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8", "9bf7e431597f21d1ee4fd48fd4f0bbdc83c83ba6f47c6e4ea0557cbf69aaeda5"},
		{"irodori_tts", "irodori_tts_v4_small_q8_0", "Irodori-TTS-v4-Small-GGUF/irodori-tts-v4-small-q8_0.gguf", "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8", "9be716e8ab66c887417acf446d198e5dc53f1669bb90136a410706232f1a0d38"},
		{"vibevoice", "vibevoice_1_5b_bf16", "VibeVoice-1.5B-GGUF/vibevoice-1.5b-bf16.gguf", "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8", "d851e2e972ff7def0729cc02da7b417bbe68ac6769594507ae78b4d3f414e1ac"},
		{"vibevoice", "vibevoice_1_5b_q8_0", "VibeVoice-1.5B-GGUF/vibevoice-1.5b-q8_0.gguf", "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8", "e9ca80a31ffe7e4726fcad9798ba10ba1e514d89174fd48ea548d21022e0e6f8"},
	}
	const repo = "audio-cpp/audio.cpp-gguf"
	for _, tc := range cases {
		t.Run(tc.id, func(t *testing.T) {
			pkg := resolvePackage(findPackageFamily(tc.family), tc.id)
			if pkg == nil || pkg.Repo != repo || pkg.Revision != tc.commit || len(pkg.Files) != 1 || pkg.Files[0].Remote != tc.path || pkg.Files[0].SHA256 != tc.sha {
				t.Fatalf("package provenance unexpectedly changed for %s: %+v", tc.id, pkg)
			}
			if !packageHasExpectedSHA256(pkg) {
				t.Fatal("declared package digest absent")
			}
			if hash, err := validateExpectedSHA256(pkg.Files[0].SHA256); err != nil || hash != tc.sha {
				t.Fatalf("expected SHA-256 fails strict validation: %v", err)
			}
			endpoint := buildResolveURL("https://huggingface.co", pkg.Repo, pkg.Revision, pkg.Files[0].Remote)
			if !strings.Contains(endpoint, "/resolve/"+tc.commit+"/") || strings.Contains(endpoint, "/resolve/main/") {
				t.Fatalf("model URL not pinned: %s", endpoint)
			}
		})
	}
}

func TestSharedGGUFHashedMirrorsRejectedWithoutNetwork(t *testing.T) {
	cases := []struct{ family, id, path, commit, sha string }{
		{"chatterbox", "chatterbox_f16", "Chatterbox-GGUF/chatterbox-f16.gguf", "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8", "615371181a0bffe8239cf6f724d57f2b153618c52c31d526c8f20eacc763c6e1"},
		{"chatterbox", "chatterbox_q8_0", "Chatterbox-GGUF/chatterbox-q8_0.gguf", "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8", "45d71d8d248ba831014813bbbbba74c7d786dd9447c02090fe05c44344f69453"},
		{"irodori_tts", "irodori_tts_500m_v3_f16", "Irodori-TTS-500M-v3-GGUF/irodori-tts-500m-v3-f16.gguf", "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8", "d8cb39d6dd6929eb4de1c3e8f508d4322402d3424b553cf52006d5ef2d37546b"},
		{"irodori_tts", "irodori_tts_500m_v3_q8_0", "Irodori-TTS-500M-v3-GGUF/irodori-tts-500m-v3-q8_0.gguf", "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8", "2442786d5e4c102759bac44b87b8ed987ba66fd6af640f6dc1b98598af1485a3"},
		{"irodori_tts", "irodori_tts_600m_v3_voicedesign_f16", "Irodori-TTS-600M-v3-VoiceDesign-GGUF/irodori-tts-600m-v3-voicedesign-f16.gguf", "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8", "006ec83aff079162a7a3aa038de9a57fa3d81ad47ed845c4a435e39ad206e6f1"},
		{"irodori_tts", "irodori_tts_600m_v3_voicedesign_q8_0", "Irodori-TTS-600M-v3-VoiceDesign-GGUF/irodori-tts-600m-v3-voicedesign-q8_0.gguf", "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8", "e7bb696b9fa59b59fb51935a3db08c0552c383cc1f2ad8927544864f672e4527"},
		{"irodori_tts", "irodori_tts_v4_small_f16", "Irodori-TTS-v4-Small-GGUF/irodori-tts-v4-small-f16.gguf", "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8", "9bf7e431597f21d1ee4fd48fd4f0bbdc83c83ba6f47c6e4ea0557cbf69aaeda5"},
		{"irodori_tts", "irodori_tts_v4_small_q8_0", "Irodori-TTS-v4-Small-GGUF/irodori-tts-v4-small-q8_0.gguf", "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8", "9be716e8ab66c887417acf446d198e5dc53f1669bb90136a410706232f1a0d38"},
		{"vibevoice", "vibevoice_1_5b_bf16", "VibeVoice-1.5B-GGUF/vibevoice-1.5b-bf16.gguf", "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8", "d851e2e972ff7def0729cc02da7b417bbe68ac6769594507ae78b4d3f414e1ac"},
		{"vibevoice", "vibevoice_1_5b_q8_0", "VibeVoice-1.5B-GGUF/vibevoice-1.5b-q8_0.gguf", "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8", "e9ca80a31ffe7e4726fcad9798ba10ba1e514d89174fd48ea548d21022e0e6f8"},
	}
	h := &Hub{} // deliberately no downloader: fail closed before network or task creation
	for _, tc := range cases {
		t.Run(tc.id, func(t *testing.T) {
			payload, _ := json.Marshal(map[string]string{"modelId": tc.family, "packageId": tc.id, "source": "modelscope"})
			req := httptest.NewRequest("POST", "/api/downloads", strings.NewReader(string(payload)))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			h.handleDownloadCreate(rec, req)
			if rec.Code != 400 || !strings.Contains(rec.Body.String(), "PACKAGE_MIRROR_UNVERIFIED") {
				t.Fatalf("unverified mutable mirror not blocked: status=%d body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestSharedGGUFLegacyAndPriorPilotRemainIntact(t *testing.T) {
	legacy := resolvePackage(findPackageFamily("rvc"), "rvc_f16")
	if legacy == nil || legacy.Revision != "main" || packageHasExpectedSHA256(legacy) {
		t.Fatal("unreviewed legacy package changed")
	}
	original := resolvePackage(findPackageFamily("kokoro_tts"), "kokoro_82m_q8_0")
	if original == nil || original.Revision != "874fcb41ececda20bcbc0782d6b4ea7f7d069ea8" || !packageHasExpectedSHA256(original) {
		t.Fatal("prior pilot was regressed")
	}
}
