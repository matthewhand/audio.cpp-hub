package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const minimalConfig = `{
  "hubs": [{"baseUrl": "http://10.0.0.36:18080"}],
  "routes": [{"aliases": ["breeze"], "targets": [{"hub": "http://10.0.0.36:18080", "instanceName": "breeze"}]}]
}`

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "farm.routes.json")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	return path
}

func TestLoadConfigDefaults(t *testing.T) {
	cfg, err := LoadConfig(writeConfig(t, minimalConfig))
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.Listen != defaultListen {
		t.Errorf("listen = %q, want %q", cfg.Listen, defaultListen)
	}
	if cfg.PollIntervalMs != defaultPollMs {
		t.Errorf("pollIntervalMs = %d, want %d", cfg.PollIntervalMs, defaultPollMs)
	}
	if cfg.MaxBodyBytes != defaultMaxBodyBytes {
		t.Errorf("maxBodyBytes = %d, want %d", cfg.MaxBodyBytes, defaultMaxBodyBytes)
	}
	if _, ok := cfg.routeFor("breeze"); !ok {
		t.Error("routeFor(breeze) not found")
	}
}

func TestLoadConfigRejects(t *testing.T) {
	tests := []struct {
		name    string
		body    string
		wantErr string
	}{
		{
			name:    "no hubs",
			body:    `{"hubs": [], "routes": [{"aliases": ["a"], "targets": [{"hub": "http://h", "instanceName": "x"}]}]}`,
			wantErr: "hubs is empty",
		},
		{
			name:    "no routes",
			body:    `{"hubs": [{"baseUrl": "http://h"}], "routes": []}`,
			wantErr: "routes is empty",
		},
		{
			name: "duplicate hub",
			body: `{"hubs": [{"baseUrl": "http://h"}, {"baseUrl": "http://h"}],
			        "routes": [{"aliases": ["a"], "targets": [{"hub": "http://h", "instanceName": "x"}]}]}`,
			wantErr: "duplicate hub",
		},
		{
			name: "target hub not listed",
			body: `{"hubs": [{"baseUrl": "http://h"}],
			        "routes": [{"aliases": ["a"], "targets": [{"hub": "http://other", "instanceName": "x"}]}]}`,
			wantErr: "not listed in hubs",
		},
		{
			name: "duplicate alias across routes",
			body: `{"hubs": [{"baseUrl": "http://h"}],
			        "routes": [{"aliases": ["a"], "targets": [{"hub": "http://h", "instanceName": "x"}]},
			                   {"aliases": ["A"], "targets": [{"hub": "http://h", "instanceName": "y"}]}]}`,
			wantErr: "duplicate alias",
		},
		{
			name: "bad instance name",
			body: `{"hubs": [{"baseUrl": "http://h"}],
			        "routes": [{"aliases": ["a"], "targets": [{"hub": "http://h", "instanceName": "../etc"}]}]}`,
			wantErr: "not a valid service name",
		},
		{
			name:    "malformed json",
			body:    `{"hubs": [`,
			wantErr: "farm.routes.json",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := LoadConfig(writeConfig(t, tc.body))
			if err == nil {
				t.Fatal("expected an error, got nil")
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("error = %v, want it to contain %q", err, tc.wantErr)
			}
		})
	}
}

func TestLoadConfigMissingFile(t *testing.T) {
	if _, err := LoadConfig(filepath.Join(t.TempDir(), "nope.json")); err == nil {
		t.Fatal("expected an error for a missing file")
	}
}

// TestCommittedRoutesConfig pins the shipped farm.routes.json: it must parse,
// and the aliases agents depend on must map to the documented backends.
func TestCommittedRoutesConfig(t *testing.T) {
	cfg, err := LoadConfig(filepath.Join("farm.routes.json"))
	if err != nil {
		t.Fatalf("LoadConfig(farm.routes.json): %v", err)
	}
	if cfg.Listen != ":18082" {
		t.Errorf("listen = %q, want :18082", cfg.Listen)
	}
	want := map[string][]string{
		"breeze":            {"http://10.0.0.36:18080/breeze", "http://10.0.0.30:18080/breeze"},
		"expressive":        {"http://10.0.0.36:18080/breeze", "http://10.0.0.30:18080/breeze"},
		"qwen3-vd":          {"http://10.0.0.30:18081/qwen3-vd"},
		"voice-design-fast": {"http://10.0.0.30:18081/qwen3-vd"},
		"sanotts":           {"http://10.0.0.36:18080/sanotts", "http://10.0.0.32:18080/sanotts"},
		"instant":           {"http://10.0.0.36:18080/sanotts", "http://10.0.0.32:18080/sanotts"},
		"citrinet":          {"http://10.0.0.36:18080/citrinet"},
		"stt":               {"http://10.0.0.36:18080/citrinet"},
	}
	for alias, targets := range want {
		rt, ok := cfg.routeFor(alias)
		if !ok {
			t.Errorf("alias %q missing from farm.routes.json", alias)
			continue
		}
		var got []string
		for _, tgt := range rt.Targets {
			got = append(got, tgt.Hub+"/"+tgt.InstanceName)
		}
		if strings.Join(got, ",") != strings.Join(targets, ",") {
			t.Errorf("alias %q targets = %v, want %v", alias, got, targets)
		}
	}
	// The RX 6600 XT route must never appear in the shipped table.
	for _, h := range cfg.Hubs {
		if h.BaseURL == ":18180" || h.BaseURL == "http://10.0.0.30:18180" {
			t.Errorf("farm.routes.json must not route to the 6600 XT throwaway port: %s", h.BaseURL)
		}
	}
}
