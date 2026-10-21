package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProxyResponseHeaderTimeoutConfig(t *testing.T) {
	for _, c := range []struct {
		ms   int64
		want time.Duration
	}{{0, 60 * time.Second}, {-5, 60 * time.Second}, {600000, 600 * time.Second}, {1500, 1500 * time.Millisecond}} {
		if got := proxyResponseHeaderTimeout(HubConfig{ProxyResponseHeaderTimeoutMs: c.ms}); got != c.want {
			t.Errorf("ms=%d: got %v want %v", c.ms, got, c.want)
		}
	}
	chdirTemp(t)
	if got := loadConfig().ProxyResponseHeaderTimeoutMs; got != 60000 {
		t.Errorf("default proxyResponseHeaderTimeoutMs = %d; want 60000", got)
	}
	if err := os.WriteFile("hub.config.json", []byte(`{"proxyResponseHeaderTimeoutMs":600000}`), 0644); err != nil {
		t.Fatal(err)
	}
	if got := loadConfig().ProxyResponseHeaderTimeoutMs; got != 600000 {
		t.Errorf("configured proxyResponseHeaderTimeoutMs = %d; want 600000", got)
	}
}

// A slow model (lazy load + long offline generation) must not be cut off when the hub
// is configured with a longer response-header timeout; the default still bounds it.
func TestV1ProxyUsesConfiguredResponseHeaderTimeout(t *testing.T) {
	chdirTemp(t)
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		time.Sleep(400 * time.Millisecond)
		w.Header().Set("Content-Type", "audio/wav")
		w.Write([]byte("RIFF....WAVE"))
	}))
	defer engine.Close()

	post := func(timeoutMs int64) int {
		t.Helper()
		h := &Hub{cfg: HubConfig{ProxyMaxBodyBytes: 1 << 20, ProxyResponseHeaderTimeoutMs: timeoutMs},
			instances: NewInstanceManager(18090, 8080)}
		h.instances.items["d3"] = &Instance{ID: "d3", Name: "drama3", Status: "READY", Port: portOf(t, engine.URL)}
		hub := httptest.NewServer(h.newHandler())
		defer hub.Close()
		resp, err := http.Post(hub.URL+"/v1/audio/speech", "application/json",
			strings.NewReader(`{"model":"drama3","input":"<|speaker:0|> Hi.","options":{"seed":42}}`))
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		return resp.StatusCode
	}
	if got := post(100); got != http.StatusBadGateway {
		t.Errorf("100 ms timeout vs 400 ms engine: status %d; want 502", got)
	}
	if got := post(5000); got != http.StatusOK {
		t.Errorf("5 s timeout vs 400 ms engine: status %d; want 200", got)
	}
}

func TestWriteServerJSONMinFreeMemory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "server.json")
	read := func(p StartParams) map[string]any {
		t.Helper()
		if err := writeServerJSON(path, 18090, p, "m"); err != nil {
			t.Fatal(err)
		}
		data, _ := os.ReadFile(path)
		var root map[string]any
		if err := json.Unmarshal(data, &root); err != nil {
			t.Fatal(err)
		}
		return root
	}
	zero, guard := 0, 12288
	if got := read(StartParams{Backend: "cpu"}); got["min_free_memory_mb"] != nil {
		t.Errorf("nil should not write min_free_memory_mb, got %v", got["min_free_memory_mb"])
	}
	if got := read(StartParams{Backend: "cpu", MinFreeMemoryMb: &zero}); got["min_free_memory_mb"] != nil {
		t.Errorf("0 should not write min_free_memory_mb, got %v", got["min_free_memory_mb"])
	}
	if got := read(StartParams{Backend: "cpu", MinFreeMemoryMb: &guard}); got["min_free_memory_mb"] != float64(12288) {
		t.Errorf("12288 should be written, got %v", got["min_free_memory_mb"])
	}
	m := NewInstanceManager(18090, 8080)
	if out := m.ToJSON(&Instance{ID: "x", MinFreeMemoryMb: &guard}, 0); out["minFreeMemoryMb"] != 12288 {
		t.Errorf("ToJSON minFreeMemoryMb = %v; want 12288", out["minFreeMemoryMb"])
	}
	if out := m.ToJSON(&Instance{ID: "y"}, 0); out["minFreeMemoryMb"] != nil {
		t.Errorf("ToJSON should omit unset minFreeMemoryMb, got %v", out["minFreeMemoryMb"])
	}
}

func TestInstanceStartRejectsNegativeMinFreeMemory(t *testing.T) {
	chdirTemp(t)
	weights := filepath.Join(t.TempDir(), "w.gguf")
	os.WriteFile(weights, []byte("x"), 0644)
	h := &Hub{cfg: HubConfig{ProxyMaxBodyBytes: 1 << 20}, instances: NewInstanceManager(18090, 8080)}
	hub := httptest.NewServer(h.newHandler())
	defer hub.Close()
	body, _ := json.Marshal(map[string]any{"modelId": "fish_drama3", "weightsPath": weights, "backend": "vulkan", "minFreeMemoryMb": -1})
	resp, err := http.Post(hub.URL+"/api/instances", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	out, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(out), "MIN_FREE_MEMORY_INVALID") {
		t.Fatalf("status %d body %s; want 400 MIN_FREE_MEMORY_INVALID", resp.StatusCode, out)
	}
}
