package main

import (
	"encoding/json"
	"net/http"
	"slices"
	"testing"
)

func TestModelCatalogPresetVoiceCapabilities(t *testing.T) {
	_, handler := newTestHubForAPI(t)
	resp := doRequest(t, handler, "GET", "/api/models", nil)
	if resp.Code != http.StatusOK {
		t.Fatalf("GET /api/models: HTTP %d", resp.Code)
	}
	var catalog []struct {
		ID           string
		Category     string
		Capabilities struct {
			PresetVoiceParam    string
			PresetVoices        []string
			PresetVoiceRequires map[string]string
		}
		ParamSchema map[string]json.RawMessage
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &catalog); err != nil {
		t.Fatal(err)
	}
	want := map[string]struct {
		param string
		count int
	}{
		"kokoro_tts":            {"voice_id", 54},
		"supertonic":            {"voice_id", 10},
		"magpie_tts":            {"voice_id", 5},
		"ming3_tts":             {"voice_id", 4},
		"qwen3_tts_customvoice": {"speaker", 9},
	}
	for _, card := range catalog {
		caps := card.Capabilities
		expected, advertisesPresets := want[card.ID]
		if !advertisesPresets {
			if caps.PresetVoiceParam != "" || len(caps.PresetVoices) > 0 || len(caps.PresetVoiceRequires) > 0 {
				t.Errorf("%s advertises unconfigured presets: %+v", card.ID, caps)
			}
			continue
		}
		delete(want, card.ID)
		if card.Category != "tts" || caps.PresetVoiceParam != expected.param || len(caps.PresetVoices) != expected.count {
			t.Errorf("%s presets: param=%q count=%d; want param=%q count=%d",
				card.ID, caps.PresetVoiceParam, len(caps.PresetVoices), expected.param, expected.count)
		}
		var enum struct {
			Type   string
			Values []string
		}
		if err := json.Unmarshal(card.ParamSchema[expected.param], &enum); err != nil {
			t.Fatalf("%s preset enum: %v", card.ID, err)
		}
		var voices []string
		for _, voice := range enum.Values {
			if voice != "" {
				voices = append(voices, voice)
			}
		}
		if enum.Type != "enum" || !slices.Equal(caps.PresetVoices, voices) {
			t.Errorf("%s presets do not match the existing enum", card.ID)
		}
		if card.ID == "ming3_tts" {
			var template struct{ Values []string }
			if err := json.Unmarshal(card.ParamSchema["template_name"], &template); err != nil {
				t.Fatal(err)
			}
			if len(caps.PresetVoiceRequires) != 1 || caps.PresetVoiceRequires["template_name"] != "ip" ||
				!slices.Contains(template.Values, "ip") {
				t.Errorf("Ming 3.0 preset template requirement = %v; want template_name=ip", caps.PresetVoiceRequires)
			}
		} else if len(caps.PresetVoiceRequires) > 0 {
			t.Errorf("%s unexpectedly requires %v", card.ID, caps.PresetVoiceRequires)
		}
	}
	if len(want) > 0 {
		t.Errorf("expected model cards missing: %v", want)
	}
}
