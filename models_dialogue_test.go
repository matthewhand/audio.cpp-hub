package main

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestModelCatalogDialogueCapabilities(t *testing.T) {
	_, handler := newTestHubForAPI(t)
	resp := doRequest(t, handler, "GET", "/api/models", nil)
	if resp.Code != http.StatusOK {
		t.Fatalf("GET /api/models: HTTP %d", resp.Code)
	}
	var catalog []struct {
		ID           string
		Category     string
		Capabilities struct {
			MultiSpeaker     bool
			MaxSpeakers      int
			SpeakerIndexBase *int
			SpeakerTagFormat string
		}
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &catalog); err != nil {
		t.Fatal(err)
	}
	want := map[string]struct {
		count, base int
		tag         string
	}{
		"moss_ttsd":   {2, 1, "[S{n}]"},
		"fish_drama3": {16, 0, "<|speaker:{n}|>"},
		"vibevoice":   {4, 1, "Speaker {n}:"},
	}
	for _, card := range catalog {
		caps := card.Capabilities
		expected, known := want[card.ID]
		if !known {
			if caps.MultiSpeaker || caps.MaxSpeakers != 0 || caps.SpeakerIndexBase != nil || caps.SpeakerTagFormat != "" {
				t.Errorf("%s unexpectedly advertises dialogue: %+v", card.ID, caps)
			}
			continue
		}
		delete(want, card.ID)
		if card.Category != "tts" || !caps.MultiSpeaker || caps.MaxSpeakers != expected.count ||
			caps.SpeakerTagFormat != expected.tag || caps.SpeakerIndexBase == nil || *caps.SpeakerIndexBase != expected.base {
			t.Errorf("%s dialogue metadata = %+v; want %d slots starting at %d with %q",
				card.ID, caps, expected.count, expected.base, expected.tag)
		}
	}
	if len(want) > 0 {
		t.Errorf("dialogue cards missing from catalog: %v", want)
	}
}
