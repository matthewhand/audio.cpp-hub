package main

import (
	"strings"
	"testing"
)

func TestPowerShellUtil(t *testing.T) {
	// Simple string without single quotes
	if got := psEscape("hello world"); got != "hello world" {
		t.Fatalf("expected unchanged, got %q", got)
	}

	// String with single quote
	if got := psEscape("C:\\User's Dir\\app.exe"); got != "C:\\User''s Dir\\app.exe" {
		t.Fatalf("expected escaped quote, got %q", got)
	}

	// String with multiple and adjacent quotes
	if got := psEscape("it's a 'test'"); got != "it''s a ''test''" {
		t.Fatalf("expected double quotes, got %q", got)
	}

	// makeAutoStartShortcutScript
	link := "C:\\Startup\\app.lnk"
	exe := "C:\\Program Files\\Hub's Dir\\hub.exe"
	workDir := "C:\\Program Files\\Hub's Dir"

	script := makeAutoStartShortcutScript(link, exe, workDir)
	if !strings.Contains(script, "CreateShortcut('C:\\Startup\\app.lnk')") {
		t.Fatalf("missing link in script: %s", script)
	}
	if !strings.Contains(script, "TargetPath = 'C:\\Program Files\\Hub''s Dir\\hub.exe'") {
		t.Fatalf("missing or unescaped exe in script: %s", script)
	}
	if !strings.Contains(script, "WorkingDirectory = 'C:\\Program Files\\Hub''s Dir'") {
		t.Fatalf("missing or unescaped workDir in script: %s", script)
	}
	if !strings.Contains(script, "$sc.Save();") {
		t.Fatalf("missing Save in script: %s", script)
	}
}
