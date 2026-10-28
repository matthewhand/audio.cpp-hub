package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHubStateReadyAndInstanceID(t *testing.T) {
	var nilState *hubState
	if nilState.ready("tts") {
		t.Errorf("nil hubState should not be ready")
	}
	if nilState.instanceID("tts") != "" {
		t.Errorf("nil hubState should return empty instanceID")
	}

	st := &hubState{
		ok: false,
		instances: []map[string]any{
			{"instanceName": "tts", "status": "READY", "id": "inst-1"},
		},
	}
	if st.ready("tts") {
		t.Errorf("hubState with ok=false should not be ready")
	}
	if st.instanceID("tts") != "" {
		t.Errorf("hubState with ok=false should return empty instanceID")
	}

	st.ok = true
	if !st.ready("tts") {
		t.Errorf("hubState with ok=true and READY instance should be ready")
	}
	if got := st.instanceID("tts"); got != "inst-1" {
		t.Errorf("instanceID = %q, want inst-1", got)
	}

	// Missing or not ready
	if st.ready("asr") {
		t.Errorf("asr should not be ready")
	}
	if st.instanceID("asr") != "" {
		t.Errorf("asr should have empty instanceID")
	}

	// Non-string id
	st.instances = append(st.instances, map[string]any{
		"instanceName": "other",
		"status":       "READY",
		"id":           12345, // int, not string
	})
	if !st.ready("other") {
		t.Errorf("other should be ready")
	}
	if st.instanceID("other") != "" {
		t.Errorf("non-string id should return empty string")
	}
}

func TestHealthStoreApplyAndFailover(t *testing.T) {
	cfg := &Config{
		Hubs: []Hub{
			{BaseURL: "http://hub-a:18080", Label: "hub-a"},
			{BaseURL: "http://hub-b:18080", Label: "hub-b"},
		},
		PollIntervalMs: 100,
		PollTimeoutMs:  50,
	}
	store := newHealthStore(cfg)

	// Initial state
	st, ok := store.hub("http://hub-a:18080")
	if !ok || st.ok || st.lastError != "not polled yet" {
		t.Fatalf("unexpected initial state: %+v", st)
	}

	// Non-existent hub apply is safe no-op
	store.apply("http://unknown:18080", nil, 10*time.Millisecond, nil)

	// First successful poll
	insts := []map[string]any{
		{"instanceName": "kokoro", "status": "READY", "id": "inst-k"},
	}
	store.apply("http://hub-a:18080", insts, 5*time.Millisecond, nil)
	st, _ = store.hub("http://hub-a:18080")
	if !st.ok || st.failures != 0 || len(st.instances) != 1 || st.latencyMs != 5 {
		t.Errorf("unexpected state after success: %+v", st)
	}

	// First failure: ok remains true (failThreshold = 2)
	store.apply("http://hub-a:18080", nil, 10*time.Millisecond, errors.New("timeout"))
	st, _ = store.hub("http://hub-a:18080")
	if !st.ok || st.failures != 1 || st.lastError != "timeout" || len(st.instances) != 0 {
		t.Errorf("after 1 failure, hub should still be considered ok (failThreshold=2): %+v", st)
	}

	// Second consecutive failure: ok becomes false
	store.apply("http://hub-a:18080", nil, 10*time.Millisecond, errors.New("conn refused"))
	st, _ = store.hub("http://hub-a:18080")
	if st.ok || st.failures != 2 || st.lastError != "conn refused" {
		t.Errorf("after 2 failures, hub should be ok=false: %+v", st)
	}

	// Recovery resets failures to 0 immediately
	store.apply("http://hub-a:18080", insts, 4*time.Millisecond, nil)
	st, _ = store.hub("http://hub-a:18080")
	if !st.ok || st.failures != 0 || st.lastError != "" {
		t.Errorf("hub should recover immediately after 1 success: %+v", st)
	}

	// Check all and snapshot
	all := store.all()
	if len(all) != 2 || all[0].baseURL != "http://hub-a:18080" {
		t.Errorf("unexpected all: %+v", all)
	}

	snap, _ := store.snapshot()
	if len(snap) != 2 || snap[0].baseURL != "http://hub-a:18080" {
		t.Errorf("unexpected snapshot: %+v", snap)
	}
}

func TestProbeHub(t *testing.T) {
	// 1. Success
	srvSuccess := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/instances" {
			http.NotFound(w, r)
			return
		}
		json.NewEncoder(w).Encode([]map[string]any{
			{"instanceName": "sensevoice", "status": "READY", "id": "sv-1"},
		})
	}))
	defer srvSuccess.Close()

	insts, latency, err := probeHub(context.Background(), srvSuccess.URL, 2*time.Second)
	if err != nil {
		t.Fatalf("probeHub failed: %v", err)
	}
	if len(insts) != 1 || insts[0]["instanceName"] != "sensevoice" {
		t.Errorf("unexpected instances: %+v", insts)
	}
	if latency <= 0 {
		t.Errorf("latency should be > 0, got %v", latency)
	}

	// 2. HTTP Error (500)
	srv500 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "internal server error", http.StatusInternalServerError)
	}))
	defer srv500.Close()

	_, _, err = probeHub(context.Background(), srv500.URL, 2*time.Second)
	if err == nil {
		t.Fatalf("expected error from 500 response, got nil")
	}
	var httpErr *httpError
	if !errors.As(err, &httpErr) {
		t.Errorf("expected *httpError, got %T: %v", err, err)
	}

	// 3. Bad JSON
	srvBadJSON := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("not valid json"))
	}))
	defer srvBadJSON.Close()

	_, _, err = probeHub(context.Background(), srvBadJSON.URL, 2*time.Second)
	if err == nil {
		t.Fatalf("expected json decode error, got nil")
	}

	// 4. Timeout / cancelled context
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled
	_, _, err = probeHub(ctx, srvSuccess.URL, 2*time.Second)
	if err == nil {
		t.Fatalf("expected cancelled context error, got nil")
	}
}

func TestHealthStoreRunAndPollOnce(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]any{
			{"instanceName": "cosyvoice", "status": "READY", "id": "cosy-1"},
		})
	}))
	defer srv.Close()

	cfg := &Config{
		Hubs: []Hub{
			{BaseURL: srv.URL, Label: "test-hub"},
		},
		PollIntervalMs: 50,
		PollTimeoutMs:  500,
	}
	store := newHealthStore(cfg)

	// Test pollOnce directly with healthy context
	store.pollOnce(context.Background())

	st, ok := store.hub(srv.URL)
	if !ok || !st.ok || len(st.instances) != 1 {
		t.Fatalf("expected hub to be polled and ready after pollOnce, got: %+v", st)
	}

	// Test run termination on context cancellation
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		store.run(ctx)
		close(done)
	}()

	time.Sleep(100 * time.Millisecond)
	cancel()

	select {
	case <-done:
		// Clean exit
	case <-time.After(1 * time.Second):
		t.Fatalf("store.run did not terminate on context cancellation")
	}
}
