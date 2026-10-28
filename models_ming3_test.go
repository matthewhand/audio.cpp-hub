package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// Ming 3.0 cards (#184 ming3_tts, #185 ming3_audio). One serverTask per card, as with qwen3_tts.

type ming3Card struct {
	id, family, serverTask, category, outputType string
	text, audio, voiceRef                        string
	schemaKeys                                   []string
}

func assertMing3Card(t *testing.T, c ming3Card) {
	t.Helper()
	model := findModel(c.id)
	if model == nil {
		t.Fatalf("%s model is not registered", c.id)
	}
	for key, want := range map[string]string{
		"family": c.family, "serverTask": c.serverTask, "category": c.category, "outputType": c.outputType,
	} {
		if got, _ := model[key].(string); got != want {
			t.Errorf("%s.%s = %q; want %q", c.id, key, got, want)
		}
	}
	inputs, _ := model["inputs"].(map[string]any)
	if inputs["text"] != c.text || inputs["audio"] != c.audio || inputs["voiceRef"] != c.voiceRef {
		t.Errorf("%s inputs = %v; want text=%s audio=%s voiceRef=%s", c.id, inputs, c.text, c.audio, c.voiceRef)
	}
	modes, _ := model["modes"].([]any)
	if len(modes) != 1 || modes[0] != "offline" {
		t.Errorf("%s modes = %v; want [offline] (upstream exposes only offline sessions)", c.id, modes)
	}
	schema, ok := model["paramSchema"].(map[string]any)
	if !ok {
		t.Fatalf("%s paramSchema missing", c.id)
	}
	for _, k := range c.schemaKeys {
		if _, ok := schema[k]; !ok {
			t.Errorf("%s paramSchema missing %q", c.id, k)
		}
	}
}

// assertGGUFPackages checks that a card has downloads from repo with the given default file.
func assertGGUFPackages(t *testing.T, id, repo, defaultFile string, wantFiles ...string) {
	t.Helper()
	raw := findPackageFamily(id)
	if raw == nil {
		t.Fatalf("%s has no download packages", id)
	}
	var fam struct {
		Packages []struct {
			ID      string `json:"id"`
			Default bool   `json:"default"`
			Repo    string `json:"repo"`
			Files   []struct {
				Remote string `json:"remote"`
				Local  string `json:"local"`
			} `json:"files"`
		} `json:"packages"`
	}
	if err := json.Unmarshal(raw, &fam); err != nil {
		t.Fatal(err)
	}
	have := map[string]bool{}
	defaults := 0
	for _, p := range fam.Packages {
		if p.Repo != repo || len(p.Files) != 1 || p.Files[0].Remote != p.Files[0].Local {
			t.Errorf("%s package %q: want one file from %s with remote==local", id, p.ID, repo)
			continue
		}
		have[p.Files[0].Remote] = true
		if p.Default {
			defaults++
		}
	}
	if defaults != 1 {
		t.Errorf("%s: want exactly one default package, got %d", id, defaults)
	}
	for _, f := range wantFiles {
		if !have[f] {
			t.Errorf("%s: missing package for %s", id, f)
		}
	}
	pkg := resolvePackage(raw, "")
	if pkg == nil || len(pkg.Files) != 1 || pkg.Files[0].Remote != defaultFile {
		t.Errorf("%s default package = %+v; want %s", id, pkg, defaultFile)
	}
}

var ming3TTSSchema = []string{"language", "template_name", "instruct", "voice_id", "reference_text",
	"seed", "guidance_scale", "sigma", "temperature", "max_tokens", "text_chunk_size", "text_chunk_mode"}

func TestMing3TTSCards(t *testing.T) {
	assertMing3Card(t, ming3Card{id: "ming3_tts", family: "ming3_tts", serverTask: "tts", category: "tts",
		outputType: "audio", text: "required", audio: "none", voiceRef: "optional", schemaKeys: ming3TTSSchema})
	assertMing3Card(t, ming3Card{id: "ming3_tts_voicedesign", family: "ming3_tts", serverTask: "vdes", category: "tts",
		outputType: "audio", text: "required", audio: "none", voiceRef: "none",
		schemaKeys: []string{"language", "instruct", "seed", "guidance_scale", "text_chunk_size"}})
}

func TestMing3TTSPackages(t *testing.T) {
	for _, id := range []string{"ming3_tts", "ming3_tts_voicedesign"} {
		assertGGUFPackages(t, id, "audio-cpp/Ming-3.0-TTS-0.5B-GGUF", "ming-3.0-tts-0.5b-q8_0.gguf",
			"ming-3.0-tts-0.5b-q8_0.gguf", "ming-3.0-tts-0.5b-bf16.gguf")
	}
}

func TestMing3AudioCards(t *testing.T) {
	assertMing3Card(t, ming3Card{id: "ming3_audio_asr", family: "ming3_audio", serverTask: "asr", category: "asr",
		outputType: "text", text: "none", audio: "required", voiceRef: "none",
		schemaKeys: []string{"prompt", "system_prompt", "enable_thinking", "max_tokens"}})
	assertMing3Card(t, ming3Card{id: "ming3_audio", family: "ming3_audio", serverTask: "tts", category: "tts",
		outputType: "audio", text: "required", audio: "none", voiceRef: "optional",
		schemaKeys: []string{"voice_id", "language", "reference_text", "seed", "guidance_scale", "sigma",
			"temperature", "max_audio_tokens", "text_chunk_size", "text_chunk_mode", "trim_silence"}})
	// The 16B MoE is usable on modest RAM only with disk-streamed experts; the cards must say how.
	for _, id := range []string{"ming3_audio_asr", "ming3_audio"} {
		if desc, _ := findModel(id)["descriptionEn"].(string); !strings.Contains(desc, "ming3_audio.disk_experts=true") {
			t.Errorf("%s descriptionEn should document the ming3_audio.disk_experts=true session option", id)
		}
	}
}

func TestMing3AudioPackages(t *testing.T) {
	for _, id := range []string{"ming3_audio_asr", "ming3_audio"} {
		assertGGUFPackages(t, id, "audio-cpp/Ming-3.0-Audio-Tiny-GGUF", "ming-3.0-audio-tiny-q4_k.gguf",
			"ming-3.0-audio-tiny-q4_k.gguf", "ming-3.0-audio-tiny-q8_0.gguf", "ming-3.0-audio-tiny-bf16.gguf")
	}
}

// Package families render by displayName, so a card's download family must not reuse another's name.
func TestPackageFamilyDisplayNamesUnique(t *testing.T) {
	var fams map[string]struct {
		DisplayName string `json:"displayName"`
	}
	if err := json.Unmarshal(modelPackagesRaw, &fams); err != nil {
		t.Fatal(err)
	}
	seen := map[string]string{}
	for id, f := range fams {
		if prev, ok := seen[f.DisplayName]; ok {
			t.Errorf("package families %s and %s share displayName %q", prev, id, f.DisplayName)
		}
		seen[f.DisplayName] = id
	}
}
