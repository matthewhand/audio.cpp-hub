package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func farmBody(t *testing.T, handler http.Handler) map[string]any {
	t.Helper()
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/farm/health", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body
}

func TestFarmHealthUpCached(t *testing.T) {
	var hits atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "updatedAt": "2026-10-10T00:00:00Z",
			"hubsUp": 2, "hubsTotal": 2,
			"hubs": []map[string]any{{"failures": 0}, {"failures": 0}},
		})
	}))
	defer up.Close()

	h := &Hub{farm: newFarmHealth(up.URL)}
	handler := h.newHandler()
	for i := 0; i < 2; i++ {
		body := farmBody(t, handler)
		if body["available"] != true || body["hubsUp"] != float64(2) || body["hubsTotal"] != float64(2) {
			t.Fatalf("body = %#v", body)
		}
		if body["failures"] != float64(0) {
			t.Fatalf("failures must be present when zero: %#v", body)
		}
		if body["checkedAt"] != "2026-10-10T00:00:00Z" {
			t.Fatalf("checkedAt = %#v", body["checkedAt"])
		}
	}
	if hits.Load() != 1 {
		t.Fatalf("upstream hits = %d, want 1 (5s cache)", hits.Load())
	}
}

func TestFarmHealthPartial(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": false, "hubsUp": 1, "hubsTotal": 2,
			"hubs": []map[string]any{{"failures": 1}, {"failures": 2}},
		})
	}))
	defer up.Close()
	body := farmBody(t, (&Hub{farm: newFarmHealth(up.URL)}).newHandler())
	if body["available"] != true || body["hubsUp"] != float64(1) || body["hubsTotal"] != float64(2) || body["failures"] != float64(3) {
		t.Fatalf("partial = %#v", body)
	}
}

func TestFarmHealthUnreachable(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("closed server must not be hit")
	}))
	url := up.URL
	up.Close()
	body := farmBody(t, (&Hub{farm: newFarmHealth(url)}).newHandler())
	if len(body) != 1 || body["available"] != false {
		t.Fatalf("unreachable = %#v", body)
	}
}

func TestFarmHealthDisabled(t *testing.T) {
	var hits atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer up.Close()
	for _, farm := range []*farmHealth{newFarmHealth(""), nil} {
		body := farmBody(t, (&Hub{farm: farm}).newHandler())
		if len(body) != 1 || body["available"] != false {
			t.Fatalf("disabled = %#v", body)
		}
	}
	if hits.Load() != 0 {
		t.Fatalf("disabled probe hit upstream %d times", hits.Load())
	}
}

func TestFarmHealthInvalidBody(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}))
	defer up.Close()
	body := farmBody(t, (&Hub{farm: newFarmHealth(up.URL)}).newHandler())
	if len(body) != 1 || body["available"] != false {
		t.Fatalf("invalid = %#v", body)
	}
}

func TestFarmHealthIgnoresRequestURL(t *testing.T) {
	var hits atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		writeJSON(w, http.StatusOK, map[string]any{
			"hubsUp": 3, "hubsTotal": 4, "hubs": []map[string]any{{"failures": 1}},
		})
	}))
	defer up.Close()
	h := &Hub{farm: newFarmHealth(up.URL)}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/farm/health?url=http://127.0.0.1:9/steal", nil)
	h.newHandler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["hubsUp"] != float64(3) || body["failures"] != float64(1) || hits.Load() != 1 {
		t.Fatalf("body=%#v hits=%d", body, hits.Load())
	}
}

func TestFarmHealthSingleFlight(t *testing.T) {
	var hits atomic.Int32
	started := make(chan struct{})
	var once sync.Once
	release := make(chan struct{})
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		once.Do(func() { close(started) })
		<-release
		writeJSON(w, http.StatusOK, map[string]any{"hubsUp": 1, "hubsTotal": 1})
	}))
	defer up.Close()
	handler := (&Hub{farm: newFarmHealth(up.URL)}).newHandler()

	var wg sync.WaitGroup
	errCh := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/farm/health", nil))
			if rec.Code != http.StatusOK {
				errCh <- errStatus(rec.Code)
			}
		}()
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream was not called")
	}
	close(release)
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Fatal(err)
	}
	if hits.Load() != 1 {
		t.Fatalf("single-flight hits = %d", hits.Load())
	}
}

type statusErr int

func (e statusErr) Error() string { return http.StatusText(int(e)) }

func errStatus(code int) error { return statusErr(code) }
