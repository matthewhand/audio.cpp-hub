package main

import (
	"strings"
	"testing"
)

// Parakeet-TDT 0.6B v3 and its English fine-tune Underdog Bark 3.0 (#186).

func TestParakeetTDTCard(t *testing.T) {
	model := findModel("parakeet_tdt")
	if model == nil {
		t.Fatal("parakeet_tdt model is not registered, though model-packages.json already ships its GGUF")
	}
	assertASRCard(t, "parakeet_tdt", "parakeet_tdt", []any{"offline", "streaming"})
	if findPackageFamily("parakeet_tdt") == nil {
		t.Fatal("parakeet_tdt lost its download packages")
	}
}

func TestUnderdogBark3Card(t *testing.T) {
	model := findModel("underdog_bark3")
	if model == nil {
		t.Fatal("underdog_bark3 model is not registered")
	}
	// Only offline sessions have been smoke-tested with the converted weights.
	assertASRCard(t, "underdog_bark3", "parakeet_tdt", []any{"offline"})
	// No hosted GGUF exists: the card must point at the local converter, not a download package.
	if findPackageFamily("underdog_bark3") != nil {
		t.Error("underdog_bark3 must not advertise a download package; weights come from tools/bark3")
	}
	if desc, _ := model["descriptionEn"].(string); !strings.Contains(desc, "tools/bark3") || !strings.Contains(desc, "CC-BY-4.0") {
		t.Errorf("underdog_bark3 descriptionEn should name tools/bark3 and the CC-BY-4.0 licence; got %q", desc)
	}
}

func assertASRCard(t *testing.T, id, family string, wantModes []any) {
	t.Helper()
	model := findModel(id)
	for key, want := range map[string]string{"family": family, "serverTask": "asr", "category": "asr", "outputType": "text"} {
		if got, _ := model[key].(string); got != want {
			t.Errorf("%s.%s = %q; want %q", id, key, got, want)
		}
	}
	inputs, _ := model["inputs"].(map[string]any)
	if inputs["text"] != "none" || inputs["audio"] != "required" || inputs["voiceRef"] != "none" {
		t.Errorf("%s inputs = %v; want audio only", id, inputs)
	}
	modes, _ := model["modes"].([]any)
	if len(modes) != len(wantModes) {
		t.Fatalf("%s modes = %v; want %v", id, modes, wantModes)
	}
	for i := range modes {
		if modes[i] != wantModes[i] {
			t.Errorf("%s modes = %v; want %v", id, modes, wantModes)
		}
	}
}
