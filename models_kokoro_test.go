package main

import (
	"encoding/json"
	"strings"
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
	wantIDs := strings.Fields(`af_alloy af_aoede af_bella af_heart af_jessica af_kore af_nicole af_nova af_river af_sarah af_sky
		am_adam am_echo am_eric am_fenrir am_liam am_michael am_onyx am_puck am_santa
		bf_alice bf_emma bf_isabella bf_lily bm_daniel bm_fable bm_george bm_lewis ef_dora em_alex em_santa ff_siwis
		hf_alpha hf_beta hm_omega hm_psi if_sara im_nicola jf_alpha jf_gongitsune jf_nezumi jf_tebukuro jm_kumo
		pf_dora pm_alex pm_santa zf_xiaobei zf_xiaoni zf_xiaoxiao zf_xiaoyi zm_yunjian zm_yunxi zm_yunxia zm_yunyang`)
	meta, _ := voice["valueMeta"].(map[string]any)
	if len(meta) != len(wantIDs) || len(values) != len(wantIDs) {
		t.Fatalf("preset values/metadata = %d/%d, want %d each", len(values), len(meta), len(wantIDs))
	}
	groupByPrefix := map[byte]string{'a': "en-us", 'b': "en-gb", 'e': "es", 'f': "fr-fr", 'h': "hi", 'i': "it", 'j': "ja", 'p': "pt-br", 'z': "zh"}
	language, _ := model["language"].(map[string]any)
	languageValues, _ := language["values"].([]any)
	groups := map[string]bool{}
	for i, id := range wantIDs {
		entry, _ := meta[id].(map[string]any)
		label, _ := entry["label"].(string)
		gender := "male"
		if id[1] == 'f' {
			gender = "female"
		}
		group := groupByPrefix[id[0]]
		if values[i] != id || label == "" || entry["group"] != group || entry["gender"] != gender ||
			(entry["requiresUniDic"] == true) != (group == "ja") {
			t.Errorf("invalid voice %s: value=%v metadata=%v", id, values[i], entry)
		}
		groups[group] = true
	}
	if len(groups) != len(languageValues) {
		t.Fatalf("voice groups %v do not match language values %v", groups, languageValues)
	}
	for _, v := range languageValues {
		if group, ok := v.(string); !ok || !groups[group] {
			t.Errorf("language %v has no matching voice group", v)
		}
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
