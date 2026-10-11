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

func TestFarmHealthHubLabel(t *testing.T) {
	// The fan-out mirrors each up hub's GET /api/instances under hubs[].instances
	// and echoes the hub's configured label. hubLabel is the entry whose instance
	// ids include one of THIS hub's own instances; absent when none matches.
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"hubsUp": 3, "hubsTotal": 3,
			"hubs": []map[string]any{
				{
					"label":    "gtx1080-primary",
					"failures": 0,
					"instances": []map[string]any{
						{"id": "deadbeef", "instanceName": "breeze"},
						{"id": "cafe1234", "instanceName": "sanotts"},
					},
				},
				{
					"label":     "rtx4090-backup",
					"failures":  0,
					"instances": []map[string]any{{"id": "other9999", "instanceName": "breeze"}},
				},
			},
		})
	}))
	defer up.Close()

	h := &Hub{farm: newFarmHealth(up.URL), instances: NewInstanceManager(19000, 18080)}
	h.instances.mu.Lock()
	for _, id := range []string{"cafe1234", "mine0001"} {
		h.instances.items[id] = &Instance{ID: id}
	}
	h.instances.mu.Unlock()

	body := farmBody(t, h.newHandler())
	if body["hubLabel"] != "gtx1080-primary" {
		t.Fatalf("hubLabel = %#v, want the entry that owns a local instance", body["hubLabel"])
	}
}

func TestFarmHealthHubLabelNoMatch(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"hubsUp": 2, "hubsTotal": 2,
			"hubs": []map[string]any{
				{"label": "gtx1080-primary", "failures": 0, "instances": []map[string]any{{"id": "abc12345"}}},
				{"label": "", "failures": 1, "instances": []map[string]any{{"id": "none0000"}}},
			},
		})
	}))
	defer up.Close()

	h := &Hub{farm: newFarmHealth(up.URL), instances: NewInstanceManager(19000, 18080)}
	h.instances.mu.Lock()
	h.instances.items["mine0001"] = &Instance{ID: "mine0001"}
	h.instances.mu.Unlock()

	body := farmBody(t, h.newHandler())
	if _, ok := body["hubLabel"]; ok {
		t.Fatalf("hubLabel must be omitted when no entry matches: %#v", body)
	}
}

func TestFarmHealthInFlightCap(t *testing.T) {
	// inFlightCap is an optional passthrough of the fan-out's
	// MaxInFlightPerTarget. Reported -> echoed; absent -> the key is omitted so
	// the client falls back to its own default rather than reading 0 as "no
	// capacity"; malformed -> the body is rejected, like hubs[].failures.
	cases := []struct {
		name  string
		extra any // nil = do not put the key in the body at all
		want  any // nil = the key must be absent from the response
		up    bool
	}{
		{name: "reported", extra: 2, want: float64(2), up: true},
		{name: "reported-zero", extra: 0, want: float64(0), up: true},
		{name: "absent", extra: nil, want: nil, up: true},
		{name: "null", extra: nil, want: nil, up: true},
		{name: "negative", extra: -1, want: nil, up: false},
		{name: "fractional", extra: 1.5, want: nil, up: false},
		{name: "string", extra: "2", want: nil, up: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body := map[string]any{"hubsUp": 1, "hubsTotal": 1}
				// "null" writes an explicit JSON null; absent writes nothing.
				if tc.extra != nil || tc.name == "null" {
					body["inFlightCap"] = tc.extra
				}
				writeJSON(w, http.StatusOK, body)
			}))
			defer up.Close()

			got := farmBody(t, (&Hub{farm: newFarmHealth(up.URL)}).newHandler())
			if got["available"] != tc.up {
				t.Fatalf("available = %#v, want %v (%#v)", got["available"], tc.up, got)
			}
			if tc.want == nil {
				if _, ok := got["inFlightCap"]; ok {
					t.Fatalf("inFlightCap must be omitted: %#v", got)
				}
				return
			}
			if got["inFlightCap"] != tc.want {
				t.Fatalf("inFlightCap = %#v, want %#v", got["inFlightCap"], tc.want)
			}
		})
	}
}

func TestFarmHealthInFlightCapSingleFlighted(t *testing.T) {
	// The cap travels in the cached summary, not in a second request: two reads
	// hit the fan-out once and both see the cap.
	var hits atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		writeJSON(w, http.StatusOK, map[string]any{
			"hubsUp": 2, "hubsTotal": 2, "inFlightCap": 3,
			"hubs": []map[string]any{{"failures": 0}, {"failures": 0}},
		})
	}))
	defer up.Close()
	handler := (&Hub{farm: newFarmHealth(up.URL)}).newHandler()
	for i := 0; i < 2; i++ {
		if body := farmBody(t, handler); body["inFlightCap"] != float64(3) {
			t.Fatalf("inFlightCap = %#v", body["inFlightCap"])
		}
	}
	if hits.Load() != 1 {
		t.Fatalf("upstream hits = %d, want 1", hits.Load())
	}
}

func TestFarmHealthHubLabelNoInstances(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"hubsUp": 1, "hubsTotal": 1})
	}))
	defer up.Close()
	h := &Hub{farm: newFarmHealth(up.URL), instances: NewInstanceManager(19000, 18080)}
	body := farmBody(t, h.newHandler())
	if _, ok := body["hubLabel"]; ok {
		t.Fatalf("no instances anywhere must omit hubLabel: %#v", body)
	}
}

type statusErr int

func (e statusErr) Error() string { return http.StatusText(int(e)) }

func errStatus(code int) error { return statusErr(code) }
