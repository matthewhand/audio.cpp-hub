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
	if cfg.MaxInFlightPerTarget != defaultMaxInFlightPerTarget {
		t.Errorf("maxInFlightPerTarget = %d, want %d", cfg.MaxInFlightPerTarget, defaultMaxInFlightPerTarget)
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

// maxInFlightPerTarget is the knob that keeps one noisy agent off a busy
// instance, so pin both directions: absent gets the small default, an explicit
// negative is the documented "no cap" escape hatch and must survive normalize.
func TestLoadConfigInFlightCap(t *testing.T) {
	const topology = `"hubs": [{"baseUrl": "http://h"}], "routes": [{"aliases": ["a"], "targets": [{"hub": "http://h", "instanceName": "x"}]}]`
	tests := []struct {
		name  string
		field string
		want  int
	}{
		{name: "absent defaults to the small cap", field: "", want: defaultMaxInFlightPerTarget},
		{name: "explicit zero also gets the default", field: `"maxInFlightPerTarget": 0,`, want: defaultMaxInFlightPerTarget},
		{name: "explicit value is kept", field: `"maxInFlightPerTarget": 4,`, want: 4},
		{name: "negative disables the cap", field: `"maxInFlightPerTarget": -1,`, want: -1},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg, err := LoadConfig(writeConfig(t, "{"+tc.field+topology+"}"))
			if err != nil {
				t.Fatalf("LoadConfig: %v", err)
			}
			if cfg.MaxInFlightPerTarget != tc.want {
				t.Errorf("maxInFlightPerTarget = %d, want %d", cfg.MaxInFlightPerTarget, tc.want)
			}
		})
	}
}

// strategy is what turns "list of backends" into "priority order" or "load
// share", so both the default and the rejection cases are pinned here.
func TestLoadConfigStrategy(t *testing.T) {
	const twoTargets = `[{"hub": "http://h", "instanceName": "x"}, {"hub": "http://h", "instanceName": "y"}]`
	tests := []struct {
		name         string
		routeExtra   string
		targets      string
		wantErrs     string
		wantStrategy string
		wantWeights  []int
	}{
		{
			name:         "absent defaults to failover with weight 1",
			targets:      twoTargets,
			wantStrategy: StrategyFailover,
			wantWeights:  []int{1, 1},
		},
		{
			name:         "explicit round_robin keeps config order weights",
			routeExtra:   `"strategy": "round_robin",`,
			targets:      `[{"hub": "http://h", "instanceName": "x", "weight": 3}, {"hub": "http://h", "instanceName": "y"}]`,
			wantStrategy: StrategyRoundRobin,
			wantWeights:  []int{3, 1},
		},
		{
			name:         "strategy is case-insensitive",
			routeExtra:   `"strategy": "Round_Robin",`,
			targets:      twoTargets,
			wantStrategy: StrategyRoundRobin,
			wantWeights:  []int{1, 1},
		},
		{
			name:       "unknown strategy is rejected",
			routeExtra: `"strategy": "sticky",`,
			targets:    twoTargets,
			wantErrs:   "strategy",
		},
		{
			name:     "negative weight is rejected",
			targets:  `[{"hub": "http://h", "instanceName": "x", "weight": -1}]`,
			wantErrs: "weight",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			body := `{"hubs": [{"baseUrl": "http://h"}], "routes": [{"aliases": ["a"], ` + tc.routeExtra +
				`"targets": ` + tc.targets + `}]}`
			cfg, err := LoadConfig(writeConfig(t, body))
			if tc.wantErrs != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErrs) {
					t.Fatalf("error = %v, want it to contain %q", err, tc.wantErrs)
				}
				return
			}
			if err != nil {
				t.Fatalf("LoadConfig: %v", err)
			}
			rt := &cfg.Routes[0]
			if rt.Strategy != tc.wantStrategy {
				t.Errorf("strategy = %q, want %q", rt.Strategy, tc.wantStrategy)
			}
			for i, want := range tc.wantWeights {
				if got := rt.Targets[i].Weight; got != want {
					t.Errorf("targets[%d].weight = %d, want %d", i, got, want)
				}
			}
		})
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
		"breeze":            {"http://10.0.0.30:18080/breeze"},
		"expressive":        {"http://10.0.0.30:18080/breeze"},
		"qwen3-vd":          {"http://10.0.0.30:18081/qwen3-vd"},
		"voice-design-fast": {"http://10.0.0.30:18081/qwen3-vd"},
		"sanotts":           {"http://10.0.0.36:18080/sanotts"},
		"instant":           {"http://10.0.0.36:18080/sanotts"},
		"kokoro":            {"http://127.0.0.1:18280/kokoro", "http://10.0.0.31:18088/kokoro-win1"},
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
	// The committed topology has five active hubs; Windows2 SanoTTS is
	// deliberately excluded until issue #127 passes its recovery gates.
	// This must not ban that host from future independently approved configs.
	if len(cfg.Hubs) != 5 {
		t.Errorf("hubs = %d, want 5 active hubs", len(cfg.Hubs))
	}
	if len(cfg.Routes) != 4 {
		t.Errorf("routes = %d, want 4 route groups", len(cfg.Routes))
	}
	if len(cfg.aliases()) != 7 {
		t.Errorf("aliases = %d, want 7", len(cfg.aliases()))
	}
	wantHubs := map[string]bool{
		"http://10.0.0.36:18080": true,
		"http://10.0.0.30:18080": true,
		"http://10.0.0.30:18081": true,
		"http://127.0.0.1:18280": true,
		"http://10.0.0.31:18088": true,
	}
	for _, hub := range cfg.Hubs {
		if !wantHubs[hub.BaseURL] {
			t.Errorf("unexpected active hub %q", hub.BaseURL)
		}
	}
	for _, route := range cfg.Routes {
		for _, target := range route.Targets {
			if !wantHubs[target.Hub] {
				t.Errorf("unexpected active route target %q", target.Hub)
			}
		}
	}
	// kokoro is the one balanced route: Windows1's GTX 1080 hub takes most of
	// the traffic (weight 4; ~0.7 s per sentence vs ~3.8 s on the GTX host's
	// CPU) and the loopback hub keeps a share as both failover and backstop.
	kokoro, ok := cfg.routeFor("kokoro")
	if !ok {
		t.Fatal("alias kokoro missing from farm.routes.json")
	}
	if kokoro.Strategy != StrategyRoundRobin {
		t.Errorf("kokoro strategy = %q, want %q", kokoro.Strategy, StrategyRoundRobin)
	}
	if got := []int{kokoro.Targets[0].Weight, kokoro.Targets[1].Weight}; got[0] != 1 || got[1] != 4 {
		t.Errorf("kokoro weights = %v, want [1 4]", got)
	}
	for alias := range want {
		if alias == "kokoro" {
			continue
		}
		if rt, _ := cfg.routeFor(alias); rt.Strategy != StrategyFailover {
			t.Errorf("alias %q strategy = %q, want failover", alias, rt.Strategy)
		}
	}
	// The RX 6600 XT route must never appear in the shipped table.
	for _, h := range cfg.Hubs {
		if h.BaseURL == ":18180" || h.BaseURL == "http://10.0.0.30:18180" {
			t.Errorf("farm.routes.json must not route to the 6600 XT throwaway port: %s", h.BaseURL)
		}
	}
}
