package main

import "testing"

func TestSortformerDiarizationRegistry(t *testing.T) {
	model := findModel("sortformer_diar")
	if model == nil {
		t.Fatal("Sortformer diarization model is not registered")
	}
	for key, want := range map[string]string{
		"family":     "sortformer_diar",
		"serverTask": "diar",
		"category":   "asr",
		"outputType": "json",
	} {
		if got, _ := model[key].(string); got != want {
			t.Errorf("%s = %q; want %q", key, got, want)
		}
	}
	if only, _ := model["diarizationOnly"].(bool); !only {
		t.Error("standalone diarization must not masquerade as ASR")
	}
	inputs, ok := model["inputs"].(map[string]any)
	if !ok || inputs["audio"] != "required" || inputs["text"] != "none" {
		t.Error("Sortformer must require audio and must not request text")
	}
}
