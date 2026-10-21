package main

import (
	"encoding/json"
	"testing"
)

// MOSS-TTSD is dialogue TTS: [S1]/[S2] speaker-tagged text, optional per-speaker
// zero-shot cloning through the voice_samples option (see engine docs/models/moss_ttsd.md).
func TestMossTTSDRegistry(t *testing.T) {
	model := findModel("moss_ttsd")
	if model == nil {
		t.Fatal("moss_ttsd model is not registered")
	}
	for key, want := range map[string]string{
		"family":     "moss_ttsd",
		"serverTask": "tts",
		"category":   "tts",
		"outputType": "audio",
	} {
		if got, _ := model[key].(string); got != want {
			t.Errorf("%s = %q; want %q", key, got, want)
		}
	}
	inputs, ok := model["inputs"].(map[string]any)
	if !ok || inputs["text"] != "required" || inputs["audio"] != "none" || inputs["voiceRef"] != "optional" {
		t.Errorf("inputs = %v; want text required, audio none, voiceRef optional", model["inputs"])
	}
	schema, ok := model["paramSchema"].(map[string]any)
	if !ok {
		t.Fatal("paramSchema missing")
	}
	for _, k := range []string{"language", "seed", "temperature", "repetition_penalty", "text_temperature", "instruct", "reference_text", "voice_samples"} {
		if _, ok := schema[k]; !ok {
			t.Errorf("paramSchema missing %q", k)
		}
	}
}

func TestMossTTSDPackages(t *testing.T) {
	raw := findPackageFamily("moss_ttsd")
	if raw == nil {
		t.Fatal("moss_ttsd has no download packages")
	}
	var fam struct {
		Category string `json:"category"`
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
	if fam.Category != "tts" {
		t.Errorf("category = %q; want tts", fam.Category)
	}
	defaults := 0
	ids := map[string]bool{}
	for _, p := range fam.Packages {
		ids[p.ID] = true
		if p.Default {
			defaults++
			if p.ID != "moss_ttsd_q8_0_codec_f16" {
				t.Errorf("default package = %q; want moss_ttsd_q8_0_codec_f16", p.ID)
			}
		}
		if p.Repo == "" || len(p.Files) != 1 || p.Files[0].Local != p.ID+".gguf" {
			t.Errorf("package %q: want one file named %s.gguf from a repo", p.ID, p.ID)
		}
	}
	if defaults != 1 {
		t.Errorf("want exactly one default package, got %d", defaults)
	}
	for _, id := range []string{"moss_ttsd_q8_0_codec_f16", "moss_ttsd_q4_k_codec_f16", "moss_ttsd_bf16_codec_f16"} {
		if !ids[id] {
			t.Errorf("missing package %q", id)
		}
	}
	if pkg := resolvePackage(raw, ""); pkg == nil {
		t.Error("resolvePackage with no id should fall back to the default package")
	}
}

// MOSS-Transcribe-Diarize: one ASR pass that returns text plus speaker turns.
func TestMossTranscribeDiarizeRegistry(t *testing.T) {
	model := findModel("moss_transcribe_diarize")
	if model == nil {
		t.Fatal("moss_transcribe_diarize model is not registered")
	}
	for key, want := range map[string]string{
		"family":     "moss_transcribe_diarize",
		"serverTask": "asr",
		"category":   "asr",
		"outputType": "text",
	} {
		if got, _ := model[key].(string); got != want {
			t.Errorf("%s = %q; want %q", key, got, want)
		}
	}
	if only, _ := model["diarizationOnly"].(bool); only {
		t.Error("MOSS transcribe-diarize produces transcript text; it is not diarization-only")
	}
	inputs, ok := model["inputs"].(map[string]any)
	if !ok || inputs["audio"] != "required" || inputs["voiceRef"] != "none" {
		t.Errorf("inputs = %v; want audio required, voiceRef none", model["inputs"])
	}
	schema, _ := model["paramSchema"].(map[string]any)
	for _, k := range []string{"max_tokens", "instruct"} {
		if _, ok := schema[k]; !ok {
			t.Errorf("paramSchema missing %q", k)
		}
	}
	raw := findPackageFamily("moss_transcribe_diarize")
	if raw == nil {
		t.Fatal("moss_transcribe_diarize has no download packages")
	}
	pkg := resolvePackage(raw, "")
	if pkg == nil || pkg.ID != "moss_transcribe_diarize_q8_0" {
		t.Errorf("default package = %+v; want moss_transcribe_diarize_q8_0", pkg)
	}
}
