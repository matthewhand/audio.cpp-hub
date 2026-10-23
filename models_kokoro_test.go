package main

import (
	"encoding/json"
	"testing"
)

// Kokoro 82M is a preset-voice TTS family (engine model_specs/kokoro_tts.json):
// 54 built-in voices selected via voice_id, no reference-audio cloning.
func TestKokoroRegistry(t *testing.T) {
	model := findModel("kokoro_tts")
	if model == nil {
		t.Fatal("kokoro_tts model is not registered")
	}
	for key, want := range map[string]string{
		"family":     "kokoro_tts",
		"serverTask": "tts",
		"category":   "tts",
		"outputType": "audio",
	} {
		if got, _ := model[key].(string); got != want {
			t.Errorf("%s = %q; want %q", key, got, want)
		}
	}
	inputs, ok := model["inputs"].(map[string]any)
	if !ok || inputs["text"] != "required" || inputs["audio"] != "none" || inputs["voiceRef"] != "none" {
		t.Errorf("inputs = %v; want text required, audio none, voiceRef none", model["inputs"])
	}
	schema, ok := model["paramSchema"].(map[string]any)
	if !ok {
		t.Fatal("paramSchema missing")
	}
	voice, ok := schema["voice_id"].(map[string]any)
	if !ok {
		t.Fatal("paramSchema.voice_id missing")
	}
	values, _ := voice["values"].([]any)
	if len(values) != 54 {
		t.Errorf("voice_id has %d values; want 54", len(values))
	}
	if voice["default"] != "af_heart" {
		t.Errorf("voice_id default = %v; want af_heart", voice["default"])
	}
	if _, ok := schema["speed"]; !ok {
		t.Error("paramSchema missing speed")
	}
}

func TestKokoroPackages(t *testing.T) {
	raw := findPackageFamily("kokoro_tts")
	if raw == nil {
		t.Fatal("kokoro_tts has no download packages")
	}
	var fam struct {
		Category string `json:"category"`
		Packages []struct {
			ID        string `json:"id"`
			Default   bool   `json:"default"`
			Repo      string `json:"repo"`
			TargetDir string `json:"targetDir"`
			Files     []struct {
				Remote string `json:"remote"`
				Local  string `json:"local"`
			} `json:"files"`
		} `json:"packages"`
	}
	if err := json.Unmarshal(raw, &fam); err != nil {
		t.Fatal(err)
	}
	if fam.Category != "tts" {
		t.Errorf("category = %q; want tts", fam.Category)
	}
	want := map[string]string{
		"kokoro_82m_q8_0": "kokoro-82m-q8_0.gguf",
		"kokoro_82m_bf16": "kokoro-82m-bf16.gguf",
	}
	defaults := 0
	for _, p := range fam.Packages {
		file, ok := want[p.ID]
		if !ok {
			t.Errorf("unexpected package %q", p.ID)
			continue
		}
		delete(want, p.ID)
		if p.Default {
			defaults++
			if p.ID != "kokoro_82m_q8_0" {
				t.Errorf("default package = %q; want kokoro_82m_q8_0", p.ID)
			}
		}
		if p.Repo != "audio-cpp/audio.cpp-gguf" || p.TargetDir != "Kokoro-82M-GGUF" ||
			len(p.Files) != 1 || p.Files[0].Local != file || p.Files[0].Remote != "Kokoro-82M-GGUF/"+file {
			t.Errorf("package %q: unexpected repo/targetDir/files: %+v", p.ID, p)
		}
	}
	if defaults != 1 {
		t.Errorf("want exactly one default package, got %d", defaults)
	}
	for id := range want {
		t.Errorf("missing package %q", id)
	}
}
