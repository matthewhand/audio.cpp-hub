package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestUnmaskEnv(t *testing.T) {
	if got := unmaskEnv(nil, map[string]string{"A": "secret"}); got != nil {
		t.Fatalf("expected nil for nil incoming, got %v", got)
	}

	incoming := map[string]string{
		"SECRET": execEnvMask,
		"NEW":    "value",
	}
	existing := map[string]string{
		"SECRET": "real-secret",
		"OLD":    "old-val",
	}
	res := unmaskEnv(incoming, existing)
	if res["SECRET"] != "real-secret" {
		t.Fatalf("expected unmasked secret, got %q", res["SECRET"])
	}
	if res["NEW"] != "value" {
		t.Fatalf("expected new value, got %q", res["NEW"])
	}
	if _, ok := res["OLD"]; ok {
		t.Fatal("OLD should not be in unmasked output")
	}

	// Incoming with mask but not in existing
	incoming2 := map[string]string{"UNKNOWN": execEnvMask}
	res2 := unmaskEnv(incoming2, existing)
	if _, ok := res2["UNKNOWN"]; ok {
		t.Fatal("UNKNOWN with mask should be omitted")
	}
}

func TestExecutableRegistry(t *testing.T) {
	tmp := t.TempDir()
	regFile := filepath.Join(tmp, "executables.json")
	reg := NewExecutableRegistry(regFile)

	// List empty
	if list := reg.List(); len(list) != 0 {
		t.Fatalf("expected empty list, got %d", len(list))
	}
	if reg.First() != nil {
		t.Fatal("expected nil for First on empty registry")
	}
	if reg.FindByID("no-such-id") != nil {
		t.Fatal("expected nil for FindByID on empty registry")
	}

	// Add validations
	if _, err := reg.Add("", "/bin/sh", "", nil); err == nil {
		t.Fatal("expected error for empty name, got nil")
	}
	if _, err := reg.Add("Name", "", "", nil); err == nil {
		t.Fatal("expected error for empty path, got nil")
	}
	if _, err := reg.Add("Name", "/bin/sh", "", map[string]string{"123INVALID": "val"}); err == nil {
		t.Fatal("expected error for invalid env key, got nil")
	}
	if _, err := reg.Add("Name", filepath.Join(tmp, "nonexistent"), "", nil); err == nil {
		t.Fatal("expected error for non-existent path, got nil")
	}

	// Create fake executable file
	fakeBin := filepath.Join(tmp, "fake_server")
	if err := os.WriteFile(fakeBin, []byte("#!/bin/sh\nexit 0\n"), 0755); err != nil {
		t.Fatalf("failed to create fake bin: %v", err)
	}

	// Create fake directory with audiocpp_server
	fakeDir := filepath.Join(tmp, "server_dir")
	fakeBinInDir := filepath.Join(fakeDir, "audiocpp_server")
	if err := os.MkdirAll(fakeDir, 0755); err != nil {
		t.Fatalf("failed to create fake dir: %v", err)
	}
	if err := os.WriteFile(fakeBinInDir, []byte("bin"), 0755); err != nil {
		t.Fatalf("failed to create bin in dir: %v", err)
	}

	// Add dir without audiocpp_server
	emptyDir := filepath.Join(tmp, "empty_dir")
	if err := os.MkdirAll(emptyDir, 0755); err != nil {
		t.Fatalf("failed to create empty dir: %v", err)
	}
	if _, err := reg.Add("Empty Dir", emptyDir, "", nil); err == nil {
		t.Fatal("expected EXEC_NOT_FOUND_IN_DIR error, got nil")
	}

	// Add using directory pointing to audiocpp_server
	eDir, err := reg.Add("Server In Dir", fakeDir, "note", map[string]string{"KEY": "VAL"})
	if err != nil {
		t.Fatalf("failed to add server in dir: %v", err)
	}
	if eDir.Path != fakeBinInDir {
		t.Fatalf("expected resolved path %q, got %q", fakeBinInDir, eDir.Path)
	}

	// Add valid executable file
	e1, err := reg.Add("Server 1", fakeBin, "my note", map[string]string{"TOKEN": "secret123"})
	if err != nil {
		t.Fatalf("failed to add server: %v", err)
	}
	if e1.ID == "" || e1.Name != "Server 1" || !e1.Exists {
		t.Fatalf("unexpected entry: %+v", e1)
	}

	// First & FindByID
	if reg.First().ID != eDir.ID {
		t.Fatalf("expected first to be %q, got %q", eDir.ID, reg.First().ID)
	}
	found := reg.FindByID(e1.ID)
	if found == nil || found.Name != "Server 1" {
		t.Fatalf("unexpected find result: %+v", found)
	}

	// Redacted
	red := found.redacted()
	if red.Env["TOKEN"] != execEnvMask {
		t.Fatalf("expected redacted env, got %q", red.Env["TOKEN"])
	}

	// Update non-existent
	if up, err := reg.Update("no-such-id", "New Name", fakeBin, "", nil); err != nil || up != nil {
		t.Fatalf("expected nil for non-existent update, got %v, %v", up, err)
	}

	// Update existing with masked env
	updated, err := reg.Update(e1.ID, "Server 1 Updated", fakeBin, "new note", map[string]string{"TOKEN": execEnvMask, "NEW_KEY": "val"})
	if err != nil {
		t.Fatalf("update failed: %v", err)
	}
	if updated.Name != "Server 1 Updated" {
		t.Fatalf("unexpected updated name: %q", updated.Name)
	}
	if updated.Env["TOKEN"] != "secret123" {
		t.Fatalf("expected preserved secret123, got %q", updated.Env["TOKEN"])
	}
	if updated.Env["NEW_KEY"] != "val" {
		t.Fatalf("expected new key val, got %q", updated.Env["NEW_KEY"])
	}

	// Delete
	if reg.Delete("no-such-id") {
		t.Fatal("expected false when deleting non-existent id")
	}
	if !reg.Delete(e1.ID) {
		t.Fatal("expected true when deleting existing id")
	}
	if len(reg.List()) != 1 {
		t.Fatalf("expected 1 entry left, got %d", len(reg.List()))
	}
}

func TestProfileRegistry(t *testing.T) {
	tmp := t.TempDir()
	profFile := filepath.Join(tmp, "profiles.json")
	reg := NewProfileRegistry(profFile)

	// List empty
	if list := reg.List(); len(list) != 0 {
		t.Fatalf("expected empty list, got %d", len(list))
	}

	// Save new profile
	weightsPath := filepath.Join(tmp, "weights.bin")
	body := map[string]any{
		"name":        "Profile A",
		"modelId":     "kokoro_tts",
		"weightsPath": weightsPath,
		"backend":     "cpu",
		"port":        18090,
	}
	saved, err := reg.Save("", body)
	if err != nil {
		t.Fatalf("failed to save profile: %v", err)
	}
	pid := optString(saved, "id")
	if pid == "" {
		t.Fatal("expected generated id")
	}

	// List shows weightsExists false
	list := reg.List()
	if len(list) != 1 {
		t.Fatalf("expected 1 profile, got %d", len(list))
	}
	if list[0]["weightsExists"] != false {
		t.Fatalf("expected weightsExists=false, got %v", list[0]["weightsExists"])
	}

	// Create weights file
	if err := os.WriteFile(weightsPath, []byte("weights"), 0644); err != nil {
		t.Fatalf("failed to write weights: %v", err)
	}
	list = reg.List()
	if list[0]["weightsExists"] != true {
		t.Fatalf("expected weightsExists=true, got %v", list[0]["weightsExists"])
	}

	// Update profile
	updateBody := map[string]any{
		"name":        "Profile A Renamed",
		"modelId":     "kokoro_tts",
		"weightsPath": weightsPath,
	}
	up, err := reg.Save(pid, updateBody)
	if err != nil || up == nil {
		t.Fatalf("update profile failed: up=%v, err=%v", up, err)
	}
	if optString(up, "name") != "Profile A Renamed" {
		t.Fatalf("unexpected name: %q", up["name"])
	}

	// Update non-existent profile
	upNonExistent, err := reg.Save("no-such-id", updateBody)
	if err != nil || upNonExistent != nil {
		t.Fatalf("expected nil for non-existent profile update: %v, %v", upNonExistent, err)
	}

	// Delete
	if reg.Delete("no-such-id") {
		t.Fatal("expected false for non-existent profile delete")
	}
	if !reg.Delete(pid) {
		t.Fatal("expected true for existing profile delete")
	}
	if len(reg.List()) != 0 {
		t.Fatalf("expected 0 profiles left, got %d", len(reg.List()))
	}
}
