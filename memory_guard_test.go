package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestInstanceStartHostMemoryGuard(t *testing.T) {
	h, handler := newTestHubForAPI(t)
	weights := filepath.Join(t.TempDir(), "fixture.gguf")
	if err := os.WriteFile(weights, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.execs.Add("Fixture", executable, "", nil); err != nil {
		t.Fatal(err)
	}

	const snapshot = "MemAvailable: 1048576 kB\nSwapTotal: 1024 kB\nSwapFree: 256 kB\n"
	ceil75, ceil74, ceil0, ceilInvalid := 75, 74, 0, 101
	for _, tc := range []struct {
		name     string
		min      int
		max      *int
		override any
		memInfo  string
		wantCode string
		wantRead bool
	}{
		{"unset preserves engine-only override", 0, nil, 4096, "", "INSTANCE_PORT_INVALID", false},
		{"insufficient available memory", 2048, nil, nil, snapshot, "INSTANCE_MEMORY_LOW", true},
		{"exact RAM and swap boundary", 1024, &ceil75, nil, snapshot, "INSTANCE_PORT_INVALID", true},
		{"swap above limit", 0, &ceil74, nil, snapshot, "INSTANCE_MEMORY_LOW", true},
		{"smaller override", 2048, nil, 1024, snapshot, "INSTANCE_PORT_INVALID", true},
		{"larger override", 512, nil, 2048, snapshot, "INSTANCE_MEMORY_LOW", true},
		{"zero disables RAM check", 2048, nil, 0, "", "INSTANCE_PORT_INVALID", false},
		{"RAM override leaves swap limit active", 2048, &ceil74, 0, snapshot, "INSTANCE_MEMORY_LOW", true},
		{"fractional override rejected", 2048, nil, 0.5, "", "MIN_FREE_MEMORY_INVALID", false},
		{"wrong RAM unit fails closed", 1, nil, nil, "MemAvailable: 4 MB\n", "INSTANCE_MEMORY_UNAVAILABLE", true},
		{"missing meminfo fails closed", 1, nil, nil, "", "INSTANCE_MEMORY_UNAVAILABLE", true},
		{"missing swap usage fails closed", 0, &ceil75, nil, "SwapTotal: 1024 kB\n", "INSTANCE_MEMORY_UNAVAILABLE", true},
		{"no swap satisfies zero ceiling", 0, &ceil0, nil, "SwapTotal: 0 kB\n", "INSTANCE_PORT_INVALID", true},
		{"any swap exceeds zero ceiling", 0, &ceil0, nil, snapshot, "INSTANCE_MEMORY_LOW", true},
		{"out-of-range swap configuration", 0, &ceilInvalid, nil, "", "INSTANCE_MEMORY_UNAVAILABLE", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h.cfg.MinAvailableMemoryMb = tc.min
			h.cfg.MaxSwapUsedPercent = tc.max
			path := filepath.Join(t.TempDir(), "meminfo")
			if tc.memInfo != "" {
				if err := os.WriteFile(path, []byte(tc.memInfo), 0600); err != nil {
					t.Fatal(err)
				}
			}
			read := false
			h.readHostMemInfo = func() ([]byte, error) {
				read = true
				return os.ReadFile(path)
			}
			// An invalid port proves that a passing guard reaches the normal
			// start path without reserving a port or launching an executable.
			body := map[string]any{"modelId": "supertonic", "weightsPath": weights, "port": 0}
			if tc.override != nil {
				body["minFreeMemoryMb"] = tc.override
			}
			resp := doRequest(t, handler, "POST", "/api/instances", body)
			var result struct{ Code string }
			if err := json.Unmarshal(resp.Body.Bytes(), &result); err != nil || result.Code != tc.wantCode || read != tc.wantRead {
				t.Fatalf("got %d %s (read=%t); want code=%s, read=%t", resp.Code, resp.Body, read, tc.wantCode, tc.wantRead)
			}
			if (tc.wantCode == "INSTANCE_MEMORY_LOW" || tc.wantCode == "INSTANCE_MEMORY_UNAVAILABLE") &&
				resp.Code != http.StatusServiceUnavailable {
				t.Fatalf("memory refusal should be HTTP 503, got %d", resp.Code)
			}
			if len(h.instances.List()) != 0 {
				t.Fatal("test created an instance")
			}
		})
	}
}
