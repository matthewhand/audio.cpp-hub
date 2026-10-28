package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFsRoots(t *testing.T) {
	roots := fsRoots()
	if len(roots) == 0 {
		t.Fatal("expected at least one root, got 0")
	}
	foundSlashOrDrive := false
	for _, r := range roots {
		name := optString(r, "name")
		path := optString(r, "path")
		if name == "/" || len(name) == 2 && name[1] == ':' {
			foundSlashOrDrive = true
		}
		if path == "" {
			t.Fatalf("root has empty path: %+v", r)
		}
	}
	if !foundSlashOrDrive {
		t.Fatalf("expected / or drive letter in roots, got: %+v", roots)
	}
}

func TestFsList(t *testing.T) {
	// Empty path
	if _, err := fsList(""); err == nil {
		t.Fatal("expected error for empty path, got nil")
	}

	tmp := t.TempDir()

	// Non-existent path
	if _, err := fsList(filepath.Join(tmp, "non-existent")); err == nil {
		t.Fatal("expected error for non-existent path, got nil")
	}

	// File instead of directory
	filePath := filepath.Join(tmp, "a_file.txt")
	if err := os.WriteFile(filePath, []byte("hello"), 0644); err != nil {
		t.Fatalf("failed to write file: %v", err)
	}
	if _, err := fsList(filePath); err == nil {
		t.Fatal("expected error for file path, got nil")
	}

	// Create subdirectories and files
	subDirB := filepath.Join(tmp, "b_dir")
	subDirA := filepath.Join(tmp, "A_dir")
	os.Mkdir(subDirB, 0755)
	os.Mkdir(subDirA, 0755)
	fileZ := filepath.Join(tmp, "z_file.wav")
	os.WriteFile(fileZ, []byte("wav"), 0644)

	res, err := fsList(tmp)
	if err != nil {
		t.Fatalf("fsList failed: %v", err)
	}
	if optString(res, "path") == "" {
		t.Fatal("expected non-empty path in result")
	}
	entries, ok := res["entries"].([]map[string]any)
	if !ok || len(entries) != 4 {
		t.Fatalf("expected 4 entries, got %d (%v)", len(entries), res["entries"])
	}
	// Dirs should come first, case-insensitive sorted (A_dir, b_dir), then files (a_file.txt, z_file.wav)
	if entries[0]["name"] != "A_dir" || entries[0]["dir"] != true {
		t.Fatalf("expected first entry to be A_dir, got %v", entries[0])
	}
	if entries[1]["name"] != "b_dir" || entries[1]["dir"] != true {
		t.Fatalf("expected second entry to be b_dir, got %v", entries[1])
	}
	if entries[2]["name"] != "a_file.txt" || entries[2]["dir"] != false {
		t.Fatalf("expected third entry to be a_file.txt, got %v", entries[2])
	}
	if entries[3]["name"] != "z_file.wav" || entries[3]["dir"] != false {
		t.Fatalf("expected fourth entry to be z_file.wav, got %v", entries[3])
	}
}

func TestFsStat(t *testing.T) {
	// Empty path
	stEmpty := fsStat("")
	if stEmpty["exists"] != false {
		t.Fatalf("expected exists=false for empty path, got: %+v", stEmpty)
	}

	tmp := t.TempDir()

	// Non-existent
	stNonExistent := fsStat(filepath.Join(tmp, "nope.txt"))
	if stNonExistent["exists"] != false {
		t.Fatalf("expected exists=false, got: %+v", stNonExistent)
	}

	// Existing directory
	stDir := fsStat(tmp)
	if stDir["exists"] != true || stDir["dir"] != true {
		t.Fatalf("expected exists=true and dir=true, got: %+v", stDir)
	}

	// Existing file with extension
	sampleFile := filepath.Join(tmp, "sample.WAV")
	os.WriteFile(sampleFile, []byte("content"), 0644)
	stFile := fsStat(sampleFile)
	if stFile["exists"] != true || stFile["dir"] != false {
		t.Fatalf("expected exists=true and dir=false, got: %+v", stFile)
	}
	if stFile["ext"] != ".wav" {
		t.Fatalf("expected lowercase ext .wav, got: %v", stFile["ext"])
	}
	if stFile["size"] != int64(7) {
		t.Fatalf("expected size 7, got: %v", stFile["size"])
	}
}

func TestFsMkdir(t *testing.T) {
	tmp := t.TempDir()

	// Empty parent
	if _, err := fsMkdir("", "sub"); err == nil {
		t.Fatal("expected error for empty parent, got nil")
	}

	// Empty name
	if _, err := fsMkdir(tmp, "   "); err == nil {
		t.Fatal("expected error for empty name, got nil")
	}

	// Invalid characters
	for _, badName := range []string{".", "..", "a/b", "a\\b", "a*b", "a?b", `a"b`, "a<b", "a>b", "a|b"} {
		if _, err := fsMkdir(tmp, badName); err == nil {
			t.Fatalf("expected error for bad name %q, got nil", badName)
		}
	}

	// Non-existent parent
	if _, err := fsMkdir(filepath.Join(tmp, "nonexistent"), "sub"); err == nil {
		t.Fatal("expected error for non-existent parent, got nil")
	}

	// Valid creation
	entry, err := fsMkdir(tmp, "new_folder")
	if err != nil {
		t.Fatalf("fsMkdir failed: %v", err)
	}
	if entry["name"] != "new_folder" || entry["dir"] != true {
		t.Fatalf("unexpected entry: %+v", entry)
	}

	// Already exists
	if _, err := fsMkdir(tmp, "new_folder"); err == nil {
		t.Fatal("expected ALREADY_EXISTS error, got nil")
	}
}
