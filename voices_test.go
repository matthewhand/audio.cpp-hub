package main

import (
	"os"
	"path/filepath"
	"testing"
)

// helper to make a small valid WAV file
func makeValidWAV(t *testing.T, path string) {
	t.Helper()
	// RIFF(4) + size(4) + WAVE(4) + fmt (8+16) + data(8+3200)
	// sample rate 16000, 1 channel, 16 bits = 32000 bytes/sec
	var data []byte
	data = append(data, []byte("RIFF")...)
	data = append(data, 0, 0, 0, 0) // will fix size
	data = append(data, []byte("WAVE")...)
	// fmt chunk
	data = append(data, []byte("fmt ")...)
	data = append(data, 16, 0, 0, 0)      // chunk size 16
	data = append(data, 1, 0)             // PCM format 1
	data = append(data, 1, 0)             // 1 channel
	data = append(data, 0x80, 0x3e, 0, 0) // 16000 rate
	data = append(data, 0x00, 0x7d, 0, 0) // 32000 byte rate
	data = append(data, 2, 0)             // block align 2
	data = append(data, 16, 0)            // 16 bits
	// data chunk
	payload := make([]byte, 3200) // 0.1s
	data = append(data, []byte("data")...)
	data = append(data, byte(len(payload)), byte(len(payload)>>8), 0, 0)
	data = append(data, payload...)

	// fix RIFF size
	riffSize := uint32(len(data) - 8)
	data[4] = byte(riffSize)
	data[5] = byte(riffSize >> 8)
	data[6] = byte(riffSize >> 16)
	data[7] = byte(riffSize >> 24)

	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatalf("failed to write wav: %v", err)
	}
}

func TestVoiceLibrary(t *testing.T) {
	tmp := t.TempDir()
	v := NewVoiceLibraryInDir(tmp)

	// List on empty
	if list := v.List(); len(list) != 0 {
		t.Fatalf("expected empty list, got %d items", len(list))
	}

	// Save validation
	if _, err := v.Save("", "text", "", ""); err == nil {
		t.Fatal("expected error for empty name, got nil")
	}
	if _, err := v.Save("Voice 1", "text", "", ""); err == nil {
		t.Fatal("expected error for missing source, got nil")
	}
	if _, err := v.Save("Voice 1", "text", "bad-upload", ""); err == nil {
		t.Fatal("expected error for missing upload, got nil")
	}
	if _, err := v.Save("Voice 1", "text", "", filepath.Join(tmp, "non-existent.wav")); err == nil {
		t.Fatal("expected error for non-existent source, got nil")
	}

	// Create valid wav
	srcWav := filepath.Join(tmp, "source.wav")
	makeValidWAV(t, srcWav)

	// Save valid voice
	entry, err := v.Save("Voice 1", "hello world", "", srcWav)
	if err != nil {
		t.Fatalf("v.Save failed: %v", err)
	}
	vid := optString(entry, "vid")
	if vid == "" {
		t.Fatal("vid should not be empty")
	}
	if optString(entry, "name") != "Voice 1" {
		t.Fatalf("unexpected name: %v", entry["name"])
	}
	if optString(entry, "text") != "hello world" {
		t.Fatalf("unexpected text: %v", entry["text"])
	}

	// Duplicate name
	if _, err := v.Save("Voice 1", "diff", "", srcWav); err == nil {
		t.Fatal("expected error for duplicate voice name, got nil")
	}

	// AudioPath
	audioPath := v.AudioPath(vid)
	if audioPath == "" || !pathExists(audioPath) {
		t.Fatalf("invalid audio path: %q", audioPath)
	}
	if v.AudioPath("invalid-vid-!") != "" {
		t.Fatal("expected empty path for invalid vid")
	}
	if v.AudioPath("0123456789abcdef0123456789abcdef") != "" {
		t.Fatal("expected empty path for non-existent safe vid")
	}

	// Update
	nameReq := ""
	if _, err := v.Update(vid, &nameReq, nil); err == nil {
		t.Fatal("expected error for empty name update, got nil")
	}
	if ok, _ := v.Update("invalid-vid-!", nil, nil); ok {
		t.Fatal("expected false for invalid vid update")
	}
	if ok, _ := v.Update("0123456789abcdef0123456789abcdef", nil, nil); ok {
		t.Fatal("expected false for non-existent vid update")
	}

	// Add second voice to test name collision on update
	srcWav2 := filepath.Join(tmp, "source2.wav")
	makeValidWAV(t, srcWav2)
	entry2, err := v.Save("Voice 2", "", "", srcWav2)
	if err != nil {
		t.Fatalf("save voice 2 failed: %v", err)
	}
	vid2 := optString(entry2, "vid")

	// Update voice 2 name to Voice 1 -> collision
	nameColl := "Voice 1"
	if _, err := v.Update(vid2, &nameColl, nil); err == nil {
		t.Fatal("expected duplicate name error on update, got nil")
	}

	// Valid update: change name and clear text
	newName := "Voice 1 Renamed"
	emptyText := ""
	ok, err := v.Update(vid, &newName, &emptyText)
	if !ok || err != nil {
		t.Fatalf("valid update failed: ok=%v, err=%v", ok, err)
	}

	list := v.List()
	if len(list) != 2 {
		t.Fatalf("expected 2 voices, got %d", len(list))
	}
	for _, it := range list {
		if optString(it, "vid") == vid {
			if optString(it, "name") != "Voice 1 Renamed" {
				t.Fatalf("expected renamed name, got %q", it["name"])
			}
			if _, hasText := it["text"]; hasText {
				t.Fatalf("text should have been cleared, got %v", it["text"])
			}
		}
	}

	// Delete
	if v.Delete("invalid-vid-!") {
		t.Fatal("delete invalid vid should be false")
	}
	if v.Delete("0123456789abcdef0123456789abcdef") {
		t.Fatal("delete non-existent vid should be false")
	}
	if !v.Delete(vid) {
		t.Fatal("delete existing vid should be true")
	}
	if len(v.List()) != 1 {
		t.Fatalf("expected 1 voice left, got %d", len(v.List()))
	}
	if pathExists(audioPath) {
		t.Fatal("audio file should have been deleted on Delete")
	}

	// Save with invalid WAV file (e.g. text file)
	badWav := filepath.Join(tmp, "bad.wav")
	os.WriteFile(badWav, []byte("not a wav file"), 0644)
	if _, err := v.Save("Bad Voice", "", "", badWav); err == nil {
		t.Fatal("expected error parsing bad wav, got nil")
	}
}
