package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// fakeStartJSONHub is a minimal /api/models + /api/instances stand-in for
// docker/start-json-instance.sh: a POSTed instance is STARTING on the first
// poll and READY afterwards.
type fakeStartJSONHub struct {
	mu     sync.Mutex
	status map[string]string
	polls  map[string]int
	posts  [][]byte
}

func (f *fakeStartJSONHub) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/models", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, "[]")
	})
	mux.HandleFunc("/api/instances", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.Method {
		case http.MethodPost:
			body, _ := io.ReadAll(r.Body)
			f.posts = append(f.posts, body)
			var p struct {
				Name string `json:"name"`
			}
			json.Unmarshal(body, &p)
			f.status[p.Name] = "STARTING"
			w.WriteHeader(http.StatusCreated)
			io.WriteString(w, `{}`)
		case http.MethodGet:
			list := []map[string]string{}
			for name, st := range f.status {
				if st == "STARTING" {
					f.polls[name]++
					if f.polls[name] > 1 {
						st = "READY"
						f.status[name] = st
					}
				}
				list = append(list, map[string]string{"instanceName": name, "status": st})
			}
			json.NewEncoder(w).Encode(list)
		}
	})
	return mux
}

func (f *fakeStartJSONHub) postCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.posts)
}

func (f *fakeStartJSONHub) post(i int) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if i < 0 || i >= len(f.posts) {
		return ""
	}
	return string(f.posts[i])
}

func runStartJSONInstance(t *testing.T, payload, hubURL string) (int, string) {
	t.Helper()
	for _, bin := range []string{"bash", "curl", "python3"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s not on PATH", bin)
		}
	}
	cmd := exec.Command("bash", filepath.Join("docker", "start-json-instance.sh"), payload, hubURL)
	cmd.Env = append(os.Environ(), "START_JSON_WAIT_SECONDS=15")
	out, err := cmd.CombinedOutput()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode(), string(out)
		}
		t.Fatalf("run script: %v\n%s", err, out)
	}
	return 0, string(out)
}

func writeStartJSONPayload(t *testing.T, dir, name, weights string) string {
	t.Helper()
	path := filepath.Join(dir, name+".json")
	body, err := json.Marshal(map[string]any{"modelId": "m", "name": name, "weightsPath": weights, "idleUnloadMs": 180000})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestStartJSONInstanceScript(t *testing.T) {
	dir := t.TempDir()
	weights := filepath.Join(dir, "w.gguf")
	if err := os.WriteFile(weights, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	t.Run("existing instance is a no-op", func(t *testing.T) {
		f := &fakeStartJSONHub{status: map[string]string{"a1": "READY"}, polls: map[string]int{}}
		srv := httptest.NewServer(f.handler())
		defer srv.Close()
		rc, out := runStartJSONInstance(t, writeStartJSONPayload(t, dir, "a1", weights), srv.URL)
		if rc != 0 || f.postCount() != 0 || !strings.Contains(out, "already exists") {
			t.Fatalf("rc=%d posts=%d out=%s", rc, f.postCount(), out)
		}
	})

	t.Run("missing weights skips without POST", func(t *testing.T) {
		f := &fakeStartJSONHub{status: map[string]string{}, polls: map[string]int{}}
		srv := httptest.NewServer(f.handler())
		defer srv.Close()
		rc, out := runStartJSONInstance(t, writeStartJSONPayload(t, dir, "a2", filepath.Join(dir, "nope.gguf")), srv.URL)
		if rc != 0 || f.postCount() != 0 || !strings.Contains(out, "weights missing") {
			t.Fatalf("rc=%d posts=%d out=%s", rc, f.postCount(), out)
		}
	})

	t.Run("unreadable payload skips", func(t *testing.T) {
		f := &fakeStartJSONHub{status: map[string]string{}, polls: map[string]int{}}
		srv := httptest.NewServer(f.handler())
		defer srv.Close()
		rc, _ := runStartJSONInstance(t, filepath.Join(dir, "absent.json"), srv.URL)
		if rc != 0 || f.postCount() != 0 {
			t.Fatalf("rc=%d posts=%d", rc, f.postCount())
		}
	})

	t.Run("absent instance is POSTed once and waits for READY", func(t *testing.T) {
		f := &fakeStartJSONHub{status: map[string]string{}, polls: map[string]int{}}
		srv := httptest.NewServer(f.handler())
		defer srv.Close()
		payload := writeStartJSONPayload(t, dir, "a3", weights)
		want, _ := os.ReadFile(payload)
		rc, out := runStartJSONInstance(t, payload, srv.URL)
		if rc != 0 || f.postCount() != 1 || f.post(0) != string(want) || !strings.Contains(out, "READY") {
			t.Fatalf("rc=%d posts=%d out=%s", rc, f.postCount(), out)
		}
		// Second run is idempotent.
		rc, out = runStartJSONInstance(t, payload, srv.URL)
		if rc != 0 || f.postCount() != 1 || !strings.Contains(out, "already exists") {
			t.Fatalf("rerun rc=%d posts=%d out=%s", rc, f.postCount(), out)
		}
	})
}
