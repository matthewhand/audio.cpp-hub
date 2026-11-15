//go:build !windows

package main

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReadyChildExitUpdatesAPIAndProxy(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("fake child requires python3")
	}
	h, handler := newTestHubForAPI(t)
	portListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := portListener.Addr().(*net.TCPAddr).Port
	portListener.Close()

	const child = `#!/usr/bin/env python3
import http.server, json, pathlib, sys
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path == "/health" else 404)
        self.end_headers()
port = json.loads(pathlib.Path(sys.argv[2]).read_text())["port"]
with http.server.HTTPServer(("127.0.0.1", port), Handler) as server:
    server.timeout = 0.05
    while not pathlib.Path("exit-child").exists():
        server.handle_request()
print("synthetic child exit log", flush=True)
sys.exit(7)
`
	executable, err := filepath.Abs("fake-engine")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(executable, []byte(child), 0755); err != nil {
		t.Fatal(err)
	}
	inst, err := h.instances.Start(StartParams{
		ModelID: "supertonic", Name: "exit-test", ExecName: "fake-engine",
		ExecPath: executable, Backend: "cpu", Port: &port,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.instances.Stop(inst.ID) })
	deadline := time.Now().Add(5 * time.Second)
	for h.instances.StatusOf(inst) != "READY" {
		select {
		case <-inst.done:
			t.Fatalf("child exited before ready: %s", readLogTail(inst.ID))
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("fake child never became READY")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := os.WriteFile("exit-child", nil, 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case <-inst.done:
	case <-time.After(3 * time.Second):
		t.Fatal("fake child did not exit")
	}
	list := doRequest(t, handler, "GET", "/api/instances", nil)
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), `"status":"EXITED"`) {
		t.Fatalf("expected EXITED in /api/instances, got %d %s", list.Code, list.Body)
	}
	models := doRequest(t, handler, "GET", "/v1/models", nil)
	if strings.Contains(models.Body.String(), "exit-test") {
		t.Fatalf("exited service still discoverable: %s", models.Body)
	}
	for _, path := range []string{"/v1/audio/speech", "/v1/audio/transcriptions/live?model=exit-test"} {
		rec := doRequest(t, handler, "POST", path, `{"model":"exit-test","input":"hello"}`)
		var response struct {
			Error struct{ Code string }
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil ||
			rec.Code != http.StatusServiceUnavailable || response.Error.Code != "INSTANCE_EXITED" {
			t.Fatalf("%s: want 503 INSTANCE_EXITED, got %d %s", path, rec.Code, rec.Body)
		}
	}
	task := doRequest(t, handler, "POST", "/api/tasks", map[string]any{"instanceId": inst.ID})
	if task.Code != http.StatusConflict {
		t.Fatalf("exited instance accepted task: %d %s", task.Code, task.Body)
	}
	events := h.instances.Events()
	if len(events) == 0 || events[0].Level != "error" ||
		!strings.Contains(events[0].Message, "exit=7") || !strings.Contains(events[0].Message, "synthetic child exit log") {
		t.Fatalf("missing exit diagnostic: %+v", events)
	}
	if _, err := h.instances.reservePort(&port); err != nil {
		t.Fatalf("exited card still reserves its port: %v", err)
	}
	remove := doRequest(t, handler, "DELETE", "/api/instances/"+inst.ID, nil)
	if remove.Code != http.StatusOK || h.instances.Get(inst.ID) != nil {
		t.Fatalf("could not remove exited instance: %d %s", remove.Code, remove.Body)
	}
}
