package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// Fish Audio Drama 3 (engine family fish_drama3): MoE expressive multi-speaker TTS with
// <|speaker:N|> tags, inline stage directions and voice cloning through the references option.
func TestFishDrama3Registry(t *testing.T) {
	model := findModel("fish_drama3")
	if model == nil {
		t.Fatal("fish_drama3 model is not registered")
	}
	for key, want := range map[string]string{
		"family":     "fish_drama3",
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
	for _, k := range []string{"max_tokens", "seed", "temperature", "top_p", "top_k", "references", "reference_text"} {
		if _, ok := schema[k]; !ok {
			t.Errorf("paramSchema missing %q", k)
		}
	}
	if mt, _ := schema["max_tokens"].(map[string]any); mt == nil || mt["type"] != "integer" || mt["default"] != float64(1024) {
		t.Errorf("max_tokens = %v; want integer default 1024 (engine default)", schema["max_tokens"])
	}
	if tk, _ := schema["top_k"].(map[string]any); tk == nil || tk["default"] != float64(4097) {
		t.Errorf("top_k = %v; want default 4097 (no cap, engine default)", schema["top_k"])
	}
	if ref, _ := schema["references"].(map[string]any); ref == nil || ref["type"] != "string" {
		t.Errorf("references = %v; want a string (JSON array passed through as the engine expects)", schema["references"])
	}
	if desc, _ := model["descriptionEn"].(string); !strings.Contains(desc, "disk_experts") {
		t.Errorf("descriptionEn should mention the disk_experts session option, got %q", desc)
	}
}

func TestFishDrama3Packages(t *testing.T) {
	raw := findPackageFamily("fish_drama3")
	if raw == nil {
		t.Fatal("fish_drama3 has no download packages")
	}
	var fam struct {
		Category string `json:"category"`
		Packages []struct {
			ID      string `json:"id"`
			Default bool   `json:"default"`
			Repo    string `json:"repo"`
			Target  string `json:"targetDir"`
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
	want := map[string]string{
		"fish_drama3_q4_experts_q8_backbone": "drama-3-backbone-8bit-experts-Q4_K_S.gguf",
		"fish_drama3_q3_experts_q8_backbone": "drama-3-backbone-8bit-experts-Q3_K_S.gguf",
		"fish_drama3_q2_experts_q8_backbone": "drama-3-backbone-8bit-experts-Q2_K.gguf",
		"fish_drama3_q4_backbone":            "drama-3-backbone-4bit-experts-Q4_K_S.gguf",
	}
	defaults := 0
	seen := map[string]bool{}
	for _, p := range fam.Packages {
		seen[p.ID] = true
		if p.Default {
			defaults++
			if p.ID != "fish_drama3_q4_experts_q8_backbone" {
				t.Errorf("default package = %q; want fish_drama3_q4_experts_q8_backbone", p.ID)
			}
		}
		if p.Repo != "Jmica/Drama-3-GGUF" || p.Target != "Drama-3-GGUF" {
			t.Errorf("package %q: repo=%q targetDir=%q", p.ID, p.Repo, p.Target)
		}
		if len(p.Files) != 1 || p.Files[0].Remote != want[p.ID] || p.Files[0].Local != want[p.ID] {
			t.Errorf("package %q: files = %+v; want one file %q", p.ID, p.Files, want[p.ID])
		}
	}
	if defaults != 1 {
		t.Errorf("want exactly one default package, got %d", defaults)
	}
	for id := range want {
		if !seen[id] {
			t.Errorf("package %q missing", id)
		}
	}
}
