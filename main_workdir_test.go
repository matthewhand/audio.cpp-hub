package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnsureWorkDir(t *testing.T) {
	origCwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}

	// 1. When web/ already exists in current directory, ensureWorkDir is a no-op
	ensureWorkDir()
	nowCwd, _ := os.Getwd()
	if nowCwd != origCwd {
		t.Errorf("cwd changed unexpectedly: %q vs %q", nowCwd, origCwd)
	}

	// 2. When in a subdirectory whose parent has web/
	tmp := t.TempDir()
	webDir := filepath.Join(tmp, "web")
	subDir := filepath.Join(tmp, "sub")
	if err := os.MkdirAll(webDir, 0755); err != nil {
		t.Fatalf("mkdir webDir: %v", err)
	}
	if err := os.MkdirAll(subDir, 0755); err != nil {
		t.Fatalf("mkdir subDir: %v", err)
	}

	t.Cleanup(func() {
		os.Chdir(origCwd)
	})

	if err := os.Chdir(subDir); err != nil {
		t.Fatalf("chdir subDir: %v", err)
	}

	ensureWorkDir()

	current, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}

	// Evaluate symlinks in case /tmp is symlinked (e.g., macOS /var -> /private/var)
	evalTmp, _ := filepath.EvalSymlinks(tmp)
	evalCur, _ := filepath.EvalSymlinks(current)
	if evalCur != evalTmp {
		t.Errorf("expected cwd to switch to %q, got %q", evalTmp, evalCur)
	}
}
