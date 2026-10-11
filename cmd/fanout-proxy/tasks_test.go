package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------- fixtures

// sttRoute is the shipped ASR shape: alias pair, one host that has citrinet.
func sttRoute(hub string) Route {
	return Route{Aliases: []string{"citrinet", "stt"}, Targets: []Target{{Hub: hub, InstanceName: "citrinet"}}}
}

// sttRouteWithStandby is the same route plus a second ASR host, so failover and
// load spilling can be exercised the way the TTS routes are.
func sttRouteWithStandby(primary, standby string) Route {
	rt := sttRoute(primary)
	rt.Targets = append(rt.Targets, Target{Hub: standby, InstanceName: "citrinet"})
	return rt
}

// markReadyIDs is markReady plus the hub-local instance ids task submission
// needs: the poll snapshot is the only place the proxy can learn them, exactly
// as it does from a real hub's GET /api/instances.
func markReadyIDs(s *healthStore, baseURL string, instances map[string]string) {
	insts := make([]map[string]any, 0, len(instances))
	for name, id := range instances {
		insts = append(insts, map[string]any{"instanceName": name, "status": "READY", "id": id})
	}
	s.apply(baseURL, insts, 5*time.Millisecond, nil)
}

// acceptedTask is the hub's 202 answer: the record an agent then reads back.
const acceptedTask = `{"id":"a1b2c3d4","status":"QUEUED","instanceName":"citrinet","modelId":"citrinet_asr"}`

// taskHub is an upstream audio.cpp-hub stand-in for the /api/tasks contract that
// records what it was asked.
type taskHub struct {
	srv       *httptest.Server
	status    int
	body      string
	calls     int
	lastVerb  string
	lastPath  string
	lastQuery string
	lastRaw   map[string]json.RawMessage
}

func newTaskHub(t *testing.T, status int, body string) *taskHub {
	t.Helper()
	f := &taskHub{status: status, body: body}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls++
		f.lastVerb, f.lastPath, f.lastQuery = r.Method, r.URL.Path, r.URL.RawQuery
		f.lastRaw = nil
		if r.ContentLength > 0 {
			raw := make([]byte, r.ContentLength)
			if _, err := io.ReadFull(r.Body, raw); err != nil {
				t.Errorf("read body: %v", err)
			}
			_ = json.Unmarshal(raw, &f.lastRaw)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(f.status)
		_, _ = w.Write([]byte(f.body))
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// seen returns the instanceId this hub was asked to submit to.
func (f *taskHub) seenInstanceID() string {
	var id string
	if err := json.Unmarshal(f.lastRaw["instanceId"], &id); err != nil {
		return ""
	}
	return id
}

func submitTask(t *testing.T, p *proxy, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/tasks", strings.NewReader(body))
	rec := httptest.NewRecorder()
	p.handler().ServeHTTP(rec, req)
	return rec
}

// ---------------------------------------------------------------- instanceId 解析

func TestHealthStoreInstanceID(t *testing.T) {
	const hub = "http://a:18080"
	tests := []struct {
		name    string
		prepare func(s *healthStore)
		look    string
		want    string
	}{
		{
			name:    "ready instance reports its id",
			prepare: func(s *healthStore) { markReadyIDs(s, hub, map[string]string{"citrinet": "id-1"}) },
			look:    "citrinet",
			want:    "id-1",
		},
		{
			name: "starting instance resolves nothing",
			prepare: func(s *healthStore) {
				s.apply(hub, []map[string]any{{"instanceName": "citrinet", "status": "STARTING", "id": "id-1"}}, time.Millisecond, nil)
			},
			look: "citrinet",
		},
		{
			name:    "service absent from the hub",
			prepare: func(s *healthStore) { markReadyIDs(s, hub, map[string]string{"breeze": "id-2"}) },
			look:    "citrinet",
		},
		{
			name:    "hub reports no id at all (older build)",
			prepare: func(s *healthStore) { markReady(s, hub, "citrinet") },
			look:    "citrinet",
		},
		{
			name: "hub reports a non-string id",
			prepare: func(s *healthStore) {
				s.apply(hub, []map[string]any{{"instanceName": "citrinet", "status": "READY", "id": 42}}, time.Millisecond, nil)
			},
			look: "citrinet",
		},
		{
			name:    "down hub resolves nothing",
			prepare: func(s *healthStore) { markDown(s, hub) },
			look:    "citrinet",
		},
		{
			name:    "never polled",
			prepare: func(s *healthStore) {},
			look:    "citrinet",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := newTestProxy([]Hub{{BaseURL: hub}}, []Route{sttRoute(hub)})
			tc.prepare(p.hub)
			st, _ := p.hub.hub(hub)
			if got := st.instanceID(tc.look); got != tc.want {
				t.Errorf("instanceID(%q) = %q, want %q", tc.look, got, tc.want)
			}
		})
	}
}

// A nil hubState must read as "no id" rather than panic: remote JSON plus a
// config/hub race can always produce one.
func TestNilHubStateInstanceID(t *testing.T) {
	var st *hubState
	if got := st.instanceID("citrinet"); got != "" {
		t.Errorf("instanceID on nil state = %q, want empty", got)
	}
}

// ---------------------------------------------------------------- 任务提交路由

func TestTaskCreate(t *testing.T) {
	const audioPath = "/audio.cpp/data/uploads/clip-7f3a.wav"
	tests := []struct {
		name         string
		statusA      int // primary's answer when it is reached at all (0 = 202)
		statusB      int // standby's answer (0 = 202)
		prepare      func(p *proxy, a, b string)
		body         string
		wantStatus   int
		wantCalls    [2]int
		wantInstance [2]string // instanceId each hub must have been given, "" = not called
		wantTried    int       // attempts entries in the failure envelope
		wantMessage  string    // substring the error message must contain
		wantReason   string    // substring every attempt reason must contain
	}{
		{
			name:         "stt alias routes to citrinet and rewrites instanceId",
			body:         `{"model":"stt","request":{"audio":"` + audioPath + `"}}`,
			wantStatus:   http.StatusAccepted,
			wantCalls:    [2]int{1, 0},
			wantInstance: [2]string{"asr-primary", ""},
		},
		{
			name:         "citrinet is the same route as stt",
			body:         `{"model":"citrinet","request":{"audio":"` + audioPath + `"}}`,
			wantStatus:   http.StatusAccepted,
			wantCalls:    [2]int{1, 0},
			wantInstance: [2]string{"asr-primary", ""},
		},
		{
			name:         "alias is case-insensitive like the speech path",
			body:         `{"model":"STT","request":{"audio":"` + audioPath + `"}}`,
			wantStatus:   http.StatusAccepted,
			wantCalls:    [2]int{1, 0},
			wantInstance: [2]string{"asr-primary", ""},
		},
		{
			name:         "primary 5xx fails over and the standby gets its own instanceId",
			statusA:      http.StatusInternalServerError,
			body:         `{"model":"stt","request":{"audio":"` + audioPath + `"}}`,
			wantStatus:   http.StatusAccepted,
			wantCalls:    [2]int{1, 1},
			wantInstance: [2]string{"asr-primary", "asr-standby"},
		},
		{
			name:         "primary 409 (instance not READY) fails over",
			statusA:      http.StatusConflict,
			body:         `{"model":"stt","request":{"audio":"` + audioPath + `"}}`,
			wantStatus:   http.StatusAccepted,
			wantCalls:    [2]int{1, 1},
			wantInstance: [2]string{"asr-primary", "asr-standby"},
		},
		{
			name:         "primary 429 (hub shedding) fails over",
			statusA:      http.StatusTooManyRequests,
			body:         `{"model":"stt","request":{"audio":"` + audioPath + `"}}`,
			wantStatus:   http.StatusAccepted,
			wantCalls:    [2]int{1, 1},
			wantInstance: [2]string{"asr-primary", "asr-standby"},
		},
		{
			name:         "a client error is not retried on the standby",
			statusA:      http.StatusBadRequest,
			body:         `{"model":"stt","request":{"audio":"` + audioPath + `"}}`,
			wantStatus:   http.StatusBadRequest,
			wantCalls:    [2]int{1, 0},
			wantInstance: [2]string{"asr-primary", ""},
			wantTried:    1,
			wantMessage:  "Upstream rejected",
		},
		{
			name:         "every target down reports the whole trail",
			statusA:      http.StatusBadGateway,
			statusB:      http.StatusInternalServerError,
			body:         `{"model":"stt","request":{"audio":"` + audioPath + `"}}`,
			wantStatus:   http.StatusServiceUnavailable,
			wantCalls:    [2]int{1, 1},
			wantInstance: [2]string{"asr-primary", "asr-standby"},
			wantTried:    2,
			wantMessage:  "No fan-out backend available for model stt",
		},
		{
			name: "no target knows the instance id yet",
			prepare: func(p *proxy, a, b string) {
				markReady(p.hub, a, "citrinet") // READY, but the poll cache has no id
				markReady(p.hub, b, "citrinet")
			},
			body:        `{"model":"stt","request":{"audio":"` + audioPath + `"}}`,
			wantStatus:  http.StatusServiceUnavailable,
			wantCalls:   [2]int{0, 0},
			wantTried:   2,
			wantMessage: "No fan-out backend available for model stt",
			wantReason:  "no instance id for citrinet",
		},
		{
			name: "primary lacks the service, standby has it",
			prepare: func(p *proxy, a, b string) {
				markReadyIDs(p.hub, a, map[string]string{"breeze": "x"})
				markReadyIDs(p.hub, b, map[string]string{"citrinet": "asr-standby"})
			},
			body:         `{"model":"stt","request":{"audio":"` + audioPath + `"}}`,
			wantStatus:   http.StatusAccepted,
			wantCalls:    [2]int{0, 1},
			wantInstance: [2]string{"", "asr-standby"},
		},
		{
			name:        "unknown alias never reaches a hub",
			body:        `{"model":"whisper","request":{"audio":"` + audioPath + `"}}`,
			wantStatus:  http.StatusNotFound,
			wantCalls:   [2]int{0, 0},
			wantMessage: "No fan-out route for model whisper",
		},
		{
			name:        "missing request object",
			body:        `{"model":"stt"}`,
			wantStatus:  http.StatusBadRequest,
			wantCalls:   [2]int{0, 0},
			wantMessage: `"request"`,
		},
		{
			name:        "request is not an object",
			body:        `{"model":"stt","request":"` + audioPath + `"}`,
			wantStatus:  http.StatusBadRequest,
			wantCalls:   [2]int{0, 0},
			wantMessage: "must be a JSON object",
		},
		{
			name:        "no model alias",
			body:        `{"request":{"audio":"` + audioPath + `"}}`,
			wantStatus:  http.StatusBadRequest,
			wantCalls:   [2]int{0, 0},
			wantMessage: `"model"`,
		},
		{
			name:        "not json",
			body:        `--boundary`,
			wantStatus:  http.StatusBadRequest,
			wantCalls:   [2]int{0, 0},
			wantMessage: "JSON object",
		},
		{
			name:        "empty body",
			body:        ``,
			wantStatus:  http.StatusBadRequest,
			wantCalls:   [2]int{0, 0},
			wantMessage: "JSON object",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			a := newTaskHub(t, statusOr(tc.statusA, http.StatusAccepted), acceptedTask)
			b := newTaskHub(t, statusOr(tc.statusB, http.StatusAccepted), acceptedTask)
			p := newTestProxy(
				[]Hub{{BaseURL: a.srv.URL}, {BaseURL: b.srv.URL}},
				[]Route{sttRouteWithStandby(a.srv.URL, b.srv.URL)},
			)
			if tc.prepare != nil {
				tc.prepare(p, a.srv.URL, b.srv.URL)
			} else {
				markReadyIDs(p.hub, a.srv.URL, map[string]string{"citrinet": "asr-primary"})
				markReadyIDs(p.hub, b.srv.URL, map[string]string{"citrinet": "asr-standby"})
			}

			rec := submitTask(t, p, tc.body)
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if got := [2]int{a.calls, b.calls}; got != tc.wantCalls {
				t.Errorf("calls = %v, want %v", got, tc.wantCalls)
			}
			for i, hub := range []*taskHub{a, b} {
				if tc.wantInstance[i] == "" {
					continue
				}
				if got := hub.seenInstanceID(); got != tc.wantInstance[i] {
					t.Errorf("hub %d saw instanceId %q, want %q", i, got, tc.wantInstance[i])
				}
				// The engine's own request must survive byte-for-byte.
				if got := string(hub.lastRaw["request"]); !strings.Contains(got, audioPath) {
					t.Errorf("hub %d saw request %s, want the audio path verbatim", i, got)
				}
				if _, leaked := hub.lastRaw["model"]; leaked {
					t.Errorf("hub %d was sent a \"model\" field; the hub takes instanceId only", i)
				}
			}
			if tc.wantStatus == http.StatusAccepted {
				if rec.Body.String() != acceptedTask {
					t.Errorf("body = %q, want the hub record verbatim", rec.Body.String())
				}
				return
			}
			env := errorEnvelope(t, rec)
			if !strings.Contains(env["message"].(string), tc.wantMessage) {
				t.Errorf("message = %q, want it to contain %q", env["message"], tc.wantMessage)
			}
			attempts, _ := env["attempts"].([]any)
			if len(attempts) != tc.wantTried {
				t.Fatalf("attempts = %v, want %d entries", attempts, tc.wantTried)
			}
			for _, raw := range attempts {
				reason := raw.(map[string]any)["reason"].(string)
				if tc.wantReason != "" && !strings.Contains(reason, tc.wantReason) {
					t.Errorf("attempt reason = %q, want it to contain %q", reason, tc.wantReason)
				}
			}
		})
	}
}

func statusOr(v, def int) int {
	if v == 0 {
		return def
	}
	return v
}

// A submission that lands must be replayable as a pinned read on the same hub,
// and the headers have to say which one that was.
func TestTaskCreateAdvertisesOrigin(t *testing.T) {
	hub := newTaskHub(t, http.StatusAccepted, acceptedTask)
	p := newTestProxy([]Hub{{BaseURL: hub.srv.URL}}, []Route{sttRoute(hub.srv.URL)})
	markReadyIDs(p.hub, hub.srv.URL, map[string]string{"citrinet": "asr-1"})

	rec := submitTask(t, p, `{"model":"stt","request":{"audio":"/tmp/a.wav"}}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 (body %s)", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("X-Fanout-Hub") != hub.srv.URL {
		t.Errorf("X-Fanout-Hub = %q, want %q (the read-through pin)", rec.Header().Get("X-Fanout-Hub"), hub.srv.URL)
	}
	if rec.Header().Get("X-Fanout-Instance") != "citrinet" {
		t.Errorf("X-Fanout-Instance = %q, want citrinet", rec.Header().Get("X-Fanout-Instance"))
	}
	if rec.Body.String() != acceptedTask {
		t.Errorf("body = %q, want the hub record verbatim", rec.Body.String())
	}
	if hub.lastVerb != http.MethodPost || hub.lastPath != "/api/tasks" {
		t.Errorf("upstream saw %s %s, want POST /api/tasks", hub.lastVerb, hub.lastPath)
	}
}

// The cap covers submission, so a burst of STT spills to the standby exactly
// like TTS does.
func TestTaskCreateInFlightCap(t *testing.T) {
	tests := []struct {
		name        string
		cap         int
		standby     bool
		holdPrimary int
		holdStandby bool
		wantStatus  int
		wantCalls   [2]int
	}{
		{name: "free slot serves the primary", cap: 2, holdPrimary: 1, wantStatus: http.StatusAccepted, wantCalls: [2]int{1, 0}},
		{name: "busy primary spills over", cap: 1, standby: true, holdPrimary: 1, wantStatus: http.StatusAccepted, wantCalls: [2]int{0, 1}},
		{name: "every target busy sheds 429", cap: 1, standby: true, holdPrimary: 1, holdStandby: true, wantStatus: http.StatusTooManyRequests, wantCalls: [2]int{0, 0}},
		{name: "lone busy target sheds 429 too", cap: 1, holdPrimary: 1, wantStatus: http.StatusTooManyRequests, wantCalls: [2]int{0, 0}},
		{name: "cap 0 never sheds", cap: 0, holdPrimary: 3, wantStatus: http.StatusAccepted, wantCalls: [2]int{1, 0}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			a := newTaskHub(t, http.StatusAccepted, acceptedTask)
			b := newTaskHub(t, http.StatusAccepted, acceptedTask)
			route := sttRoute(a.srv.URL)
			hubs := []Hub{{BaseURL: a.srv.URL}}
			if tc.standby {
				route.Targets = append(route.Targets, Target{Hub: b.srv.URL, InstanceName: "citrinet"})
				hubs = append(hubs, Hub{BaseURL: b.srv.URL})
			}
			p := newTestProxy(hubs, []Route{route})
			setCap(p, tc.cap)
			markReadyIDs(p.hub, a.srv.URL, map[string]string{"citrinet": "asr-primary"})
			markReadyIDs(p.hub, b.srv.URL, map[string]string{"citrinet": "asr-standby"})
			holdSlots(t, p, route.Targets[0], tc.holdPrimary)
			if tc.holdStandby {
				holdSlots(t, p, route.Targets[1], 1)
			}

			rec := submitTask(t, p, `{"model":"stt","request":{"audio":"/tmp/a.wav"}}`)
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if got := [2]int{a.calls, b.calls}; got != tc.wantCalls {
				t.Errorf("calls = %v, want %v", got, tc.wantCalls)
			}
			if tc.wantStatus != http.StatusTooManyRequests {
				return
			}
			if got := rec.Header().Get("Retry-After"); got != strconv.Itoa(retryAfterSeconds) {
				t.Errorf("Retry-After = %q, want %q", got, strconv.Itoa(retryAfterSeconds))
			}
			env := errorEnvelope(t, rec)
			if got := env["type"]; got != "rate_limit_error" {
				t.Errorf("type = %v, want rate_limit_error", got)
			}
			if got := env["inFlightCap"]; got != float64(tc.cap) {
				t.Errorf("inFlightCap = %v, want %d", got, tc.cap)
			}
			attempts, _ := env["attempts"].([]any)
			if len(attempts) != len(route.Targets) {
				t.Fatalf("attempts = %v, want every target accounted for", attempts)
			}
		})
	}
}

// A finished submission must give its slot back, or the cap would wedge the
// only ASR host after a couple of transcriptions.
func TestTaskCreateReleasesInFlightSlot(t *testing.T) {
	hub := newTaskHub(t, http.StatusAccepted, acceptedTask)
	p := newTestProxy([]Hub{{BaseURL: hub.srv.URL}}, []Route{sttRoute(hub.srv.URL)})
	setCap(p, 1) // one slot, so a leak shows up on the very next call
	markReadyIDs(p.hub, hub.srv.URL, map[string]string{"citrinet": "asr-1"})

	for i := 1; i <= 2; i++ {
		rec := submitTask(t, p, `{"model":"stt","request":{"audio":"/tmp/a.wav"}}`)
		if rec.Code != http.StatusAccepted {
			t.Fatalf("submission %d: status = %d, want 202 (body %s)", i, rec.Code, rec.Body.String())
		}
	}
	if hub.calls != 2 {
		t.Errorf("upstream calls = %d, want 2", hub.calls)
	}
}

// ---------------------------------------------------------------- 读回

func TestTaskReadThrough(t *testing.T) {
	tests := []struct {
		name       string
		prepare    func(p *proxy, hub *taskHub)
		method     string
		target     string // proxy path + query, with HUB standing for the hub base URL
		hubStatus  int
		hubBody    string
		wantStatus int
		wantVerb   string
		wantPath   string
		wantQuery  string
	}{
		{
			name:       "task status",
			method:     http.MethodGet,
			target:     "/api/tasks/a1b2c3d4?hub=HUB",
			hubBody:    acceptedTask,
			wantStatus: http.StatusOK,
			wantVerb:   http.MethodGet,
			wantPath:   "/api/tasks/a1b2c3d4",
		},
		{
			name:       "result file",
			method:     http.MethodGet,
			target:     "/api/tasks/a1b2c3d4/result?hub=HUB",
			hubBody:    `{"text":"the quick brown fox","timing":{"rtf":0.1}}`,
			wantStatus: http.StatusOK,
			wantVerb:   http.MethodGet,
			wantPath:   "/api/tasks/a1b2c3d4/result",
		},
		{
			name:       "cancel",
			method:     http.MethodDelete,
			target:     "/api/tasks/a1b2c3d4?hub=HUB",
			hubBody:    `{"ok":true,"data":{"id":"a1b2c3d4"}}`,
			wantStatus: http.StatusOK,
			wantVerb:   http.MethodDelete,
			wantPath:   "/api/tasks/a1b2c3d4",
		},
		{
			name:       "list keeps hub filters but drops the pin",
			method:     http.MethodGet,
			target:     "/api/tasks?hub=HUB&active=1&modelId=citrinet_asr",
			hubBody:    "[]",
			wantStatus: http.StatusOK,
			wantVerb:   http.MethodGet,
			wantPath:   "/api/tasks",
			wantQuery:  "active=1&modelId=citrinet_asr",
		},
		{
			name:       "hub 404 stays a 404, not a fan-out envelope",
			method:     http.MethodGet,
			target:     "/api/tasks/deadbeef?hub=HUB",
			hubStatus:  http.StatusNotFound,
			hubBody:    `{"ok":false,"code":"TASK_NOT_FOUND","error":"任务不存在: deadbeef"}`,
			wantStatus: http.StatusNotFound,
			wantVerb:   http.MethodGet,
			wantPath:   "/api/tasks/deadbeef",
		},
		{
			name:       "pin is mandatory",
			method:     http.MethodGet,
			target:     "/api/tasks/a1b2c3d4",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "unknown hub",
			method:     http.MethodGet,
			target:     "/api/tasks/a1b2c3d4?hub=http://elsewhere:18080",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "hub marked down is refused without dialing",
			prepare:    func(p *proxy, hub *taskHub) { markDown(p.hub, hub.srv.URL) },
			method:     http.MethodGet,
			target:     "/api/tasks/a1b2c3d4?hub=HUB",
			wantStatus: http.StatusBadGateway,
		},
		{
			name:       "task id must be a safe path segment",
			method:     http.MethodGet,
			target:     "/api/tasks/not%20a%20task?hub=HUB",
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "cache says up but the socket is gone",
			prepare: func(p *proxy, hub *taskHub) {
				hub.srv.Close() // transport error before any byte is written
			},
			method:     http.MethodGet,
			target:     "/api/tasks/a1b2c3d4?hub=HUB",
			wantStatus: http.StatusBadGateway,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			hub := newTaskHub(t, statusOr(tc.hubStatus, http.StatusOK), tc.hubBody)
			p := newTestProxy([]Hub{{BaseURL: hub.srv.URL}}, []Route{sttRoute(hub.srv.URL)})
			markReadyIDs(p.hub, hub.srv.URL, map[string]string{"citrinet": "asr-1"})
			if tc.prepare != nil {
				tc.prepare(p, hub)
			}

			target := strings.ReplaceAll(tc.target, "HUB", hub.srv.URL)
			req := httptest.NewRequest(tc.method, target, nil)
			rec := httptest.NewRecorder()
			p.handler().ServeHTTP(rec, req)

			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if tc.wantVerb == "" {
				if hub.calls != 0 {
					t.Errorf("hub was called %d times for a request that must not reach it", hub.calls)
				}
				return
			}
			if hub.calls != 1 {
				t.Fatalf("hub calls = %d, want 1", hub.calls)
			}
			if hub.lastVerb != tc.wantVerb || hub.lastPath != tc.wantPath {
				t.Errorf("upstream saw %s %s, want %s %s", hub.lastVerb, hub.lastPath, tc.wantVerb, tc.wantPath)
			}
			if hub.lastQuery != tc.wantQuery {
				t.Errorf("upstream query = %q, want %q", hub.lastQuery, tc.wantQuery)
			}
			if rec.Header().Get("X-Fanout-Hub") != hub.srv.URL {
				t.Errorf("X-Fanout-Hub = %q, want %q", rec.Header().Get("X-Fanout-Hub"), hub.srv.URL)
			}
			// The hub's own body is the answer, so its 404 must not be rewrapped.
			if rec.Body.String() != tc.hubBody {
				t.Errorf("body = %q, want the hub body verbatim %q", rec.Body.String(), tc.hubBody)
			}
		})
	}
}

// The 400 that asks for a pin must tell the caller which hubs exist.
func TestTaskReadPinHintListsHubs(t *testing.T) {
	const hub = "http://a:18080"
	p := newTestProxy([]Hub{{BaseURL: hub}, {BaseURL: "http://b:18080"}}, []Route{sttRoute(hub)})
	rec := httptest.NewRecorder()
	p.handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/tasks/a1b2c3d4", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	env := errorEnvelope(t, rec)
	hubs, _ := env["known_hubs"].([]any)
	if len(hubs) != 2 || hubs[0] != hub {
		t.Errorf("known_hubs = %v, want the config hubs in failover order", hubs)
	}
}

func TestForwardQuery(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"pin only", "hub=http://a:18080", ""},
		{"pin plus filters", "hub=http://a:18080&active=1&modelId=citrinet_asr", "active=1&modelId=citrinet_asr"},
		{"no pin at all", "active=1", "active=1"},
		{"pin spelled Hub is dropped too", "Hub=http://a:18080", ""},
		{"nothing", "", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			in, err := url.ParseQuery(tc.in)
			if err != nil {
				t.Fatalf("parse %q: %v", tc.in, err)
			}
			if got := forwardQuery(in); got != tc.want {
				t.Errorf("forwardQuery(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
