package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/matthewhand/audio.cpp-hub/internal/idvalidate"
	"github.com/matthewhand/audio.cpp-hub/internal/wav"
)

func TestToUserError(t *testing.T) {
	if toUserError(nil) != nil {
		t.Fatal("expected nil for nil error")
	}

	rawErr := errors.New("raw error")
	if toUserError(rawErr) != rawErr {
		t.Fatalf("expected raw error returned unchanged")
	}

	wavErr := &wav.Error{Code: "WAV_ERR", Msg: "wav msg", Params: map[string]any{"k": "v"}}
	ue := toUserError(wavErr)
	if u, ok := ue.(*UserError); !ok || u.Code != "WAV_ERR" || u.Msg != "wav msg" {
		t.Fatalf("expected *UserError with code WAV_ERR, got: %+v", ue)
	}

	idErr := &idvalidate.Error{Code: "ID_ERR", Msg: "id msg", Params: map[string]any{"x": "y"}}
	ie := toUserError(idErr)
	if u, ok := ie.(*UserError); !ok || u.Code != "ID_ERR" || u.Msg != "id msg" {
		t.Fatalf("expected *UserError with code ID_ERR, got: %+v", ie)
	}
}

func TestAudioUploadAndProbe(t *testing.T) {
	tmp := t.TempDir()
	origUploadDir := uploadDir
	uploadDir = filepath.Join(tmp, "uploads")
	defer func() { uploadDir = origUploadDir }()

	// Invalid WAV upload
	if _, err := saveUpload([]byte("invalid wav bytes")); err == nil {
		t.Fatal("expected error for invalid wav bytes, got nil")
	}

	// Make a valid WAV in memory
	wavFile := filepath.Join(tmp, "valid.wav")
	makeValidWAV(t, wavFile)
	data, err := os.ReadFile(wavFile)
	if err != nil {
		t.Fatalf("failed to read test wav: %v", err)
	}

	// Valid upload
	info, err := saveUpload(data)
	if err != nil {
		t.Fatalf("saveUpload failed: %v", err)
	}
	id := optString(info, "id")
	if id == "" {
		t.Fatal("expected non-empty id from saveUpload")
	}
	if info["sampleRate"] != 16000 || info["channels"] != 1 || info["bitsPerSample"] != 16 {
		t.Fatalf("unexpected audio info: %+v", info)
	}

	// uploadPath
	if uploadPath("invalid-id-!") != "" {
		t.Fatal("expected empty path for invalid ID")
	}
	if uploadPath("0123456789abcdef0123456789abcdef") != "" {
		t.Fatal("expected empty path for non-existent safe ID")
	}
	upPath := uploadPath(id)
	if upPath == "" || !pathExists(upPath) {
		t.Fatalf("expected existing upload path for %q, got %q", id, upPath)
	}

	// probeWAV
	// Non-existent
	if _, err := probeWAV(filepath.Join(tmp, "none.wav")); err == nil {
		t.Fatal("expected error for non-existent file, got nil")
	}

	// Valid file
	pInfo, err := probeWAV(wavFile)
	if err != nil {
		t.Fatalf("probeWAV failed: %v", err)
	}
	if _, hasID := pInfo["id"]; hasID {
		t.Fatalf("probeWAV result should not have id, got: %v", pInfo["id"])
	}
	if pInfo["sampleRate"] != 16000 {
		t.Fatalf("unexpected sample rate: %v", pInfo["sampleRate"])
	}

	// Round3
	if round3(1.23456) != 1.235 {
		t.Fatalf("expected 1.235, got %v", round3(1.23456))
	}
	if round3(0.0) != 0.0 {
		t.Fatalf("expected 0.0, got %v", round3(0.0))
	}
}
