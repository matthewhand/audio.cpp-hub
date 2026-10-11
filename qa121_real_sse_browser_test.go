package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// Private loopback-only validation harness. This file is not part of PR #135.
func TestQA121BrowserHarness(t *testing.T) {
	if os.Getenv("QA121_REAL_SSE_BROWSER") != "1" {
		t.Skip("manual, loopback-only browser integration harness")
	}
	root, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	chdirTemp(t) // do not persist synthetic TaskManager data into the checkout
	bus := NewEventBus()
	// Synthetic engine: no weights, GPU, production inference, or network I/O.
	engineReady := make(chan struct{})
	var engineOnce sync.Once
	releaseEngine := func() { engineOnce.Do(func() { close(engineReady) }) }
	defer releaseEngine()
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		<-engineReady
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{\"ok\":true}"))
	}))
	defer engine.Close()
	manager := NewTaskManager(NewHistoryManager())
	manager.AddObserver(bus)
	var busMu sync.RWMutex
	online := true
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/events/stream", func(w http.ResponseWriter, r *http.Request) {
		busMu.RLock()
		current, available := bus, online
		busMu.RUnlock()
		if !available {
			http.Error(w, "offline", http.StatusServiceUnavailable)
			return
		}
		(&Hub{bus: current}).handleEventStream(w, r)
	})
	mux.HandleFunc("POST /qa/off", func(w http.ResponseWriter, r *http.Request) {
		busMu.Lock()
		online = false
		old := bus
		busMu.Unlock()
		old.Close() // forces active EventSource to reconnect
		w.WriteHeader(204)
	})
	mux.HandleFunc("POST /qa/on", func(w http.ResponseWriter, r *http.Request) {
		busMu.Lock()
		bus = NewEventBus()
		manager.AddObserver(bus) // test-only bus rotation; forward future real task events
		online = true
		busMu.Unlock()
		w.WriteHeader(204)
	})
	mux.HandleFunc("GET /api/tasks", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, manager.List(false, ""))
	})
	mux.HandleFunc("POST /qa/live-create", func(w http.ResponseWriter, r *http.Request) {
		inst := &Instance{ID: "qa-real-instance", Name: "Synthetic Engine", ModelID: "nonexistent_model", Port: portOf(t, engine.URL)}
		task := manager.Submit(inst, map[string]any{"text": "Synthetic QA only"}, json.RawMessage("{\"text\":\"Synthetic QA only\"}"))
		writeJSON(w, http.StatusAccepted, map[string]any{"id": task.ID})
	})
	mux.HandleFunc("POST /qa/live-finish", func(w http.ResponseWriter, r *http.Request) {
		releaseEngine()
		w.WriteHeader(http.StatusNoContent)
	})
	mux.Handle("/", http.FileServer(http.Dir(filepath.Join(root, "web"))))
	mux.HandleFunc("POST /qa/publish", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Name string `json:"name"`
			ID   string `json:"id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad JSON", 400)
			return
		}
		if req.Name != eventTaskFinished && req.Name != eventTaskFailed {
			http.Error(w, "invalid test event", 400)
			return
		}
		busMu.RLock()
		current := bus
		busMu.RUnlock()
		current.OnTaskEvent(taskEvent{Name: req.Name, TaskID: req.ID, InstanceID: "i1", ModelID: "supertonic", Category: "tts"})
		w.WriteHeader(204)
	})
	stop := make(chan struct{})
	var once sync.Once
	mux.HandleFunc("POST /qa/stop", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(204)
		once.Do(func() { close(stop) })
	})
	listener, err := net.Listen("tcp", "127.0.0.1:4194")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 2 * time.Second}
	go func() { _ = server.Serve(listener) }()
	fmt.Println("QA121_BROWSER_READY=http://127.0.0.1:4194")
	select {
	case <-stop:
	case <-time.After(80 * time.Second):
		t.Error("browser harness timed out")
	}
	busMu.RLock()
	last := bus
	busMu.RUnlock()
	last.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
}
