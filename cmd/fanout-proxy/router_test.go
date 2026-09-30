package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------- fixtures

func testConfig(hubs []Hub, routes []Route) *Config {
	cfg := &Config{Hubs: hubs, Routes: routes}
	if err := cfg.normalize(); err != nil {
		panic(err)
	}
	return cfg
}

func newTestProxy(hubs []Hub, routes []Route) *proxy {
	cfg := testConfig(hubs, routes)
	return &proxy{cfg: cfg, hub: newHealthStore(cfg)}
}

// breezeRoute is the real shape: one alias pair, primary + standby.
func breezeRoute(hubA, hubB string) []Route {
	return []Route{{
		Aliases: []string{"breeze", "expressive"},
		Targets: []Target{
			{Hub: hubA, InstanceName: "breeze"},
			{Hub: hubB, InstanceName: "breeze"},
		},
	}}
}

func markReady(s *healthStore, baseURL string, names ...string) {
	insts := make([]map[string]any, 0, len(names))
	for _, n := range names {
		insts = append(insts, map[string]any{"instanceName": n, "status": "READY"})
	}
	s.apply(baseURL, insts, 5*time.Millisecond, nil)
}

func markStarting(s *healthStore, baseURL, name string) {
	s.apply(baseURL, []map[string]any{{"instanceName": name, "status": "STARTING"}}, 5*time.Millisecond, nil)
}

// markDown fails the poll failThreshold times, i.e. what "hub is down" means.
func markDown(s *healthStore, baseURL string) {
	for i := 0; i < failThreshold; i++ {
		s.apply(baseURL, nil, time.Millisecond, errors.New("dial tcp: connection refused"))
	}
}

// ---------------------------------------------------------------- alias 解析

func TestRouteFor(t *testing.T) {
	cfg := testConfig(
		[]Hub{{BaseURL: "http://a:18080"}},
		[]Route{{Aliases: []string{"breeze", "Expressive"}, Targets: []Target{{Hub: "http://a:18080", InstanceName: "breeze"}}}},
	)
	tests := []struct {
		alias string
		want  bool
	}{
		{"breeze", true},
		{"expressive", true}, // case-insensitive
		{"EXPRESSIVE", true}, // case-insensitive
		{" breeze ", false},  // no implicit trimming: the hub does not trim either
		{"breez", false},     // no prefix matching
		{"", false},          // empty never resolves
		{"sanotts", false},   // unknown alias
	}
	for _, tc := range tests {
		if _, got := cfg.routeFor(tc.alias); got != tc.want {
			t.Errorf("routeFor(%q) ok = %v, want %v", tc.alias, got, tc.want)
		}
	}
}

// ---------------------------------------------------------------- 故障转移

func TestPlanTargetsAndPick(t *testing.T) {
	const hubA, hubB = "http://a:18080", "http://b:18080"
	tests := []struct {
		name       string
		prepare    func(s *healthStore)
		wantTarget string // "" means no usable target
		wantSkips  []string
	}{
		{
			name:       "both ready prefers the primary",
			prepare:    func(s *healthStore) { markReady(s, hubA, "breeze"); markReady(s, hubB, "breeze") },
			wantTarget: hubA,
			wantSkips:  []string{"", ""},
		},
		{
			name: "primary down falls over to standby",
			prepare: func(s *healthStore) {
				markDown(s, hubA)
				markReady(s, hubB, "breeze")
			},
			wantTarget: hubB,
			wantSkips:  []string{"hub is down", ""},
		},
		{
			name: "primary instance not READY falls over",
			prepare: func(s *healthStore) {
				markStarting(s, hubA, "breeze")
				markReady(s, hubB, "breeze")
			},
			wantTarget: hubB,
			wantSkips:  []string{"instance is not READY", ""},
		},
		{
			name: "primary lacks the service entirely",
			prepare: func(s *healthStore) {
				markReady(s, hubA, "sanotts")
				markReady(s, hubB, "breeze")
			},
			wantTarget: hubB,
			wantSkips:  []string{"instance is not READY", ""},
		},
		{
			name: "primary recovers after coming back",
			prepare: func(s *healthStore) {
				markDown(s, hubA)
				markReady(s, hubA, "breeze")
				markReady(s, hubB, "breeze")
			},
			wantTarget: hubA,
			wantSkips:  []string{"", ""},
		},
		{
			name: "all targets unusable",
			prepare: func(s *healthStore) {
				markDown(s, hubA)
				markStarting(s, hubB, "breeze")
			},
			wantTarget: "",
			wantSkips:  []string{"hub is down", "instance is not READY"},
		},
		{
			name: "never polled yet is not ready",
			prepare: func(s *healthStore) {
				markReady(s, hubB, "breeze")
			},
			wantTarget: hubB,
			wantSkips:  []string{"hub is down", ""},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := newTestProxy([]Hub{{BaseURL: hubA}, {BaseURL: hubB}}, breezeRoute(hubA, hubB))
			tc.prepare(p.hub)
			plan := planTargets(&p.cfg.Routes[0], p.hub)
			if len(plan) != len(tc.wantSkips) {
				t.Fatalf("plan has %d entries, want %d", len(plan), len(tc.wantSkips))
			}
			for i, c := range plan {
				if c.skip != tc.wantSkips[i] {
					t.Errorf("plan[%d].skip = %q, want %q", i, c.skip, tc.wantSkips[i])
				}
			}
			got, ok := pickTarget(&p.cfg.Routes[0], p.hub)
			if tc.wantTarget == "" {
				if ok {
					t.Fatalf("pickTarget = %s, want no target", got.Hub)
				}
				return
			}
			if !ok || got.Hub != tc.wantTarget {
				t.Errorf("pickTarget = (%s, %v), want %s", got.Hub, ok, tc.wantTarget)
			}
			if got.InstanceName != "breeze" {
				t.Errorf("pickTarget instanceName = %q, want breeze", got.InstanceName)
			}
		})
	}
}

// A single failed poll must not move traffic off a warm primary; two in a row
// must. This is the whole "mark down after 2 failures" contract.
func TestHubMarkedDownAfterTwoPollFailures(t *testing.T) {
	const hubA = "http://a:18080"
	p := newTestProxy([]Hub{{BaseURL: hubA}}, breezeRoute(hubA, hubA))
	p.hub.apply(hubA, []map[string]any{{"instanceName": "breeze", "status": "READY"}}, time.Millisecond, nil)

	for i := 1; i <= 2; i++ {
		p.hub.apply(hubA, nil, time.Millisecond, errors.New("timeout"))
		st, _ := p.hub.hub(hubA)
		if i == 1 && !st.ok {
			t.Error("hub went down after a single poll failure; want one grace poll")
		}
		if i == 2 && st.ok {
			t.Error("hub still up after two consecutive poll failures")
		}
		if st.failures != i {
			t.Errorf("failures = %d, want %d", st.failures, i)
		}
	}

	p.hub.apply(hubA, []map[string]any{{"instanceName": "breeze", "status": "READY"}}, time.Millisecond, nil)
	st, _ := p.hub.hub(hubA)
	if !st.ok || st.failures != 0 || st.lastError != "" {
		t.Errorf("after recovery: ok=%v failures=%d lastError=%q, want ok/failures reset", st.ok, st.failures, st.lastError)
	}
}

// ---------------------------------------------------------------- body 改写

func TestModelExtractAndRewrite(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		wantErr    bool
		wantModel  string
		wantTarget string
		wantSubstr string // must survive the rewrite verbatim
	}{
		{
			name:       "simple",
			body:       `{"model":"breeze","input":"hi"}`,
			wantModel:  "breeze",
			wantTarget: "sanotts",
			wantSubstr: `"input":"hi"`,
		},
		{
			name:       "nested options and extras survive",
			body:       `{"model":"expressive","input":"hi","options":{"instruction":"dry,flat","seed":12345},"voice":"alloy"}`,
			wantModel:  "expressive",
			wantTarget: "breeze",
			wantSubstr: `"options":{"instruction":"dry,flat","seed":12345}`,
		},
		{
			name:       "large integers are not reformatted",
			body:       `{"model":"breeze","input":"hi","meta":9007199254740993}`,
			wantModel:  "breeze",
			wantTarget: "breeze",
			wantSubstr: `"meta":9007199254740993`,
		},
		{
			name:       "reference audio path preserved",
			body:       `{"model":"breeze","voice_ref":"/data/uploads/a.wav","reference_text":"hello there"}`,
			wantModel:  "breeze",
			wantTarget: "breeze",
			wantSubstr: `"/data/uploads/a.wav"`,
		},
		{
			name:    "missing model",
			body:    `{"input":"hi"}`,
			wantErr: true,
		},
		{
			name:    "model is not a string",
			body:    `{"model":42}`,
			wantErr: true,
		},
		{
			name:    "model is empty",
			body:    `{"model":"  "}`,
			wantErr: true,
		},
		{
			name:    "not an object",
			body:    `["breeze"]`,
			wantErr: true,
		},
		{
			name:    "truncated json",
			body:    `{"model":"breeze"`,
			wantErr: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fields, err := decodeBody([]byte(tc.body))
			if err == nil {
				_, err = extractModel(fields)
			}
			if tc.wantErr {
				if err == nil {
					t.Fatal("expected a decode/extract error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("decode/extract: %v", err)
			}
			gotModel, err := extractModel(fields)
			if err != nil {
				t.Fatalf("extractModel: %v", err)
			}
			if gotModel != tc.wantModel {
				t.Errorf("model = %q, want %q", gotModel, tc.wantModel)
			}
			out, err := rewriteModel(fields, tc.wantTarget)
			if err != nil {
				t.Fatalf("rewriteModel: %v", err)
			}
			if !strings.Contains(string(out), `"model":"`+tc.wantTarget+`"`) {
				t.Errorf("rewritten body %s does not carry model %q", out, tc.wantTarget)
			}
			if !strings.Contains(string(out), tc.wantSubstr) {
				t.Errorf("rewritten body %s lost %q", out, tc.wantSubstr)
			}
			// The rewrite must still be a valid object the upstream hub can read.
			var back map[string]any
			if err := json.Unmarshal(out, &back); err != nil {
				t.Errorf("rewritten body is not valid JSON: %v", err)
			}
		})
	}
}

func TestRetryable(t *testing.T) {
	tests := []struct {
		status int
		want   bool
	}{
		{http.StatusBadRequest, false},
		{http.StatusNotFound, false},
		{http.StatusRequestEntityTooLarge, false},
		{http.StatusConflict, true}, // hub: instance still starting
		{http.StatusTooManyRequests, true},
		{http.StatusInternalServerError, true},
		{http.StatusBadGateway, true},
		{http.StatusServiceUnavailable, true},
	}
	for _, tc := range tests {
		if got := retryable(tc.status); got != tc.want {
			t.Errorf("retryable(%d) = %v, want %v", tc.status, got, tc.want)
		}
	}
}

// ---------------------------------------------------------------- 端到端故障转移

// fakeHub is an upstream audio.cpp-hub stand-in that records what it received.
type fakeHub struct {
	srv     *httptest.Server
	status  int
	body    string
	ct      string
	calls   int
	lastRaw map[string]json.RawMessage
}

func newFakeHub(t *testing.T, status int, body, ct string) *fakeHub {
	f := &fakeHub{status: status, body: body, ct: ct}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls++
		if r.URL.Path != "/v1/audio/speech" {
			http.NotFound(w, r)
			return
		}
		raw := make([]byte, r.ContentLength)
		if _, err := r.Body.Read(raw); err != nil && err.Error() != "EOF" {
			t.Errorf("read body: %v", err)
		}
		f.lastRaw = nil
		_ = json.Unmarshal(raw, &f.lastRaw)
		if f.ct != "" {
			w.Header().Set("Content-Type", f.ct)
		}
		w.WriteHeader(f.status)
		_, _ = w.Write([]byte(f.body))
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func post(t *testing.T, p *proxy, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/audio/speech", strings.NewReader(body))
	rec := httptest.NewRecorder()
	p.handler().ServeHTTP(rec, req)
	return rec
}

func errorEnvelope(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out struct {
		Error map[string]any `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("error body is not JSON (%q): %v", rec.Body.String(), err)
	}
	return out.Error
}

func TestSpeechFailover(t *testing.T) {
	const wav = "RIFF-fake-wav-bytes"
	tests := []struct {
		name       string
		primary    *fakeHub
		standby    *fakeHub
		body       string
		wantStatus int
		wantBody   string
		wantCalls  [2]int
		wantTried  int
		wantModel  string // model the responding hub should have seen
	}{
		{
			name:       "primary serves",
			primary:    newFakeHub(t, 200, wav, "audio/wav"),
			standby:    newFakeHub(t, 200, wav, "audio/wav"),
			body:       `{"model":"breeze","input":"hi"}`,
			wantStatus: 200,
			wantBody:   wav,
			wantCalls:  [2]int{1, 0},
			wantModel:  "breeze",
		},
		{
			name:       "primary 500 fails over",
			primary:    newFakeHub(t, 500, `{"error":{"message":"engine died"}}`, "application/json"),
			standby:    newFakeHub(t, 200, wav, "audio/wav"),
			body:       `{"model":"expressive","input":"hi","options":{"instruction":"dry"}}`,
			wantStatus: 200,
			wantBody:   wav,
			wantCalls:  [2]int{1, 1},
			wantTried:  1,
			wantModel:  "breeze",
		},
		{
			name:       "primary 409 (still starting) fails over",
			primary:    newFakeHub(t, 409, `{"error":{"message":"instance not ready"}}`, "application/json"),
			standby:    newFakeHub(t, 200, wav, "audio/wav"),
			body:       `{"model":"breeze","input":"hi"}`,
			wantStatus: 200,
			wantBody:   wav,
			wantCalls:  [2]int{1, 1},
			wantTried:  1,
			wantModel:  "breeze",
		},
		{
			name:       "all targets down reports every hub tried",
			primary:    newFakeHub(t, 502, `bad gateway`, "text/plain"),
			standby:    newFakeHub(t, 500, `{"error":{"message":"engine died"}}`, "application/json"),
			body:       `{"model":"breeze","input":"hi"}`,
			wantStatus: 503,
			wantTried:  2,
			wantCalls:  [2]int{1, 1},
		},
		{
			name:       "client error is not retried on the standby",
			primary:    newFakeHub(t, 400, `{"error":{"message":"multipart not supported"}}`, "application/json"),
			standby:    newFakeHub(t, 200, wav, "audio/wav"),
			body:       `{"model":"breeze","input":"hi"}`,
			wantStatus: 400,
			wantTried:  1,
			wantCalls:  [2]int{1, 0},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := newTestProxy(
				[]Hub{{BaseURL: tc.primary.srv.URL}, {BaseURL: tc.standby.srv.URL}},
				breezeRoute(tc.primary.srv.URL, tc.standby.srv.URL),
			)
			markReady(p.hub, tc.primary.srv.URL, "breeze")
			markReady(p.hub, tc.standby.srv.URL, "breeze")

			rec := post(t, p, tc.body)
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if tc.wantCalls != [2]int{tc.primary.calls, tc.standby.calls} {
				t.Errorf("calls = %v, want %v", [2]int{tc.primary.calls, tc.standby.calls}, tc.wantCalls)
			}
			if tc.wantStatus == 200 {
				if rec.Body.String() != tc.wantBody {
					t.Errorf("body = %q, want %q", rec.Body.String(), tc.wantBody)
				}
				if got := rec.Header().Get("X-Fanout-Instance"); got != tc.wantModel {
					t.Errorf("X-Fanout-Instance = %q, want %q", got, tc.wantModel)
				}
				if rec.Header().Get("X-Fanout-Hub") == "" {
					t.Error("X-Fanout-Hub header missing; agents need it to find history")
				}
				return
			}
			env := errorEnvelope(t, rec)
			attempts, _ := env["attempts"].([]any)
			if len(attempts) != tc.wantTried {
				t.Errorf("attempts = %v, want %d entries", attempts, tc.wantTried)
			}
			if tc.wantStatus == 503 {
				tried, _ := env["hubs_tried"].([]any)
				if len(tried) != 2 {
					t.Errorf("hubs_tried = %v, want both hubs listed", tried)
				}
				if !strings.Contains(env["message"].(string), "breeze") {
					t.Errorf("message = %q, want it to name the model", env["message"])
				}
			}
		})
	}
}

// The failover is driven by the poll cache: an instance that is up on the hub
// but absent/STARTING locally is skipped without touching the wire.
func TestSpeechSkipsHubUnusablePerPollCache(t *testing.T) {
	standby := newFakeHub(t, 200, "wav", "audio/wav")
	primary := newFakeHub(t, 200, "primary-should-not-be-used", "audio/wav")
	p := newTestProxy(
		[]Hub{{BaseURL: primary.srv.URL}, {BaseURL: standby.srv.URL}},
		breezeRoute(primary.srv.URL, standby.srv.URL),
	)
	markReady(p.hub, primary.srv.URL, "sanotts") // up, but no breeze
	markReady(p.hub, standby.srv.URL, "breeze")

	rec := post(t, p, `{"model":"breeze","input":"hi"}`)
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if primary.calls != 0 {
		t.Errorf("primary was called %d times, want 0", primary.calls)
	}
	if got := rec.Header().Get("X-Fanout-Hub"); got != standby.srv.URL {
		t.Errorf("X-Fanout-Hub = %q, want %q", got, standby.srv.URL)
	}
	var seen string
	if err := json.Unmarshal(standby.lastRaw["model"], &seen); err != nil || seen != "breeze" {
		t.Errorf("standby saw model %q (err %v), want breeze", seen, err)
	}
}

func TestSpeechRejectsBadRequests(t *testing.T) {
	hub := newFakeHub(t, 200, "wav", "audio/wav")
	p := newTestProxy([]Hub{{BaseURL: hub.srv.URL}}, breezeRoute(hub.srv.URL, hub.srv.URL))
	markReady(p.hub, hub.srv.URL, "breeze")

	tests := []struct {
		name       string
		body       string
		wantStatus int
	}{
		{"not json", `nope`, http.StatusBadRequest},
		{"no model", `{"input":"hi"}`, http.StatusBadRequest},
		{"unknown alias", `{"model":"whisper","input":"hi"}`, http.StatusNotFound},
		{"empty body", ``, http.StatusBadRequest},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rec := post(t, p, tc.body)
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if hub.calls != 0 {
				t.Errorf("upstream was called for a bad request (%d calls)", hub.calls)
			}
			env := errorEnvelope(t, rec)
			if env["type"] == nil || env["message"] == nil {
				t.Errorf("error envelope = %v, want OpenAI {message,type}", env)
			}
		})
	}
}

// ---------------------------------------------------------------- 只读接口

func TestModelsListsOnlyReadyAliases(t *testing.T) {
	const hubA, hubB = "http://a:18080", "http://b:18080"
	p := newTestProxy(
		[]Hub{{BaseURL: hubA}, {BaseURL: hubB}},
		append(breezeRoute(hubA, hubB), Route{
			Aliases: []string{"citrinet", "stt"},
			Targets: []Target{{Hub: hubA, InstanceName: "citrinet"}},
		}),
	)
	markReady(p.hub, hubA, "breeze", "citrinet")
	markDown(p.hub, hubB)

	rec := httptest.NewRecorder()
	p.handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/models", nil))
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var out struct {
		Object string `json:"object"`
		Data   []struct {
			ID      string `json:"id"`
			OwnedBy string `json:"owned_by"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Object != "list" {
		t.Errorf("object = %q, want list", out.Object)
	}
	var ids []string
	for _, d := range out.Data {
		ids = append(ids, d.ID)
		if d.OwnedBy == "" {
			t.Errorf("model %q has no owned_by", d.ID)
		}
	}
	// breeze/expressive (hub A) and citrinet/stt (hub A) all resolve; nothing
	// depends on the down standby, so every alias stays listed. Order follows
	// the route table, not the alphabet, so clients see a stable preference.
	want := []string{"breeze", "expressive", "citrinet", "stt"}
	if strings.Join(ids, ",") != strings.Join(want, ",") {
		t.Errorf("models = %v, want %v", ids, want)
	}

	// With hub A gone as well, nothing is listed but the call still succeeds.
	markDown(p.hub, hubA)
	rec = httptest.NewRecorder()
	p.handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/models", nil))
	var empty struct {
		Data []any `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &empty); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(empty.Data) != 0 {
		t.Errorf("data = %v, want empty when every hub is down", empty.Data)
	}
}

func TestAggregatedInstances(t *testing.T) {
	const hubA, hubB = "http://a:18080", "http://b:18080"
	p := newTestProxy([]Hub{{BaseURL: hubB}, {BaseURL: hubA}}, breezeRoute(hubA, hubB))
	markReady(p.hub, hubA, "breeze")
	markReady(p.hub, hubB, "sanotts")
	markDown(p.hub, hubA)

	rec := httptest.NewRecorder()
	p.handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/instances", nil))
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var out []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out) != 1 {
		t.Fatalf("instances = %v, want only the up hub's entry", out)
	}
	if out[0]["hub"] != hubB || out[0]["instanceName"] != "sanotts" {
		t.Errorf("instance = %v, want %s/sanotts", out[0], hubB)
	}
}

// A hub is remote input: an older build, or a baseUrl pointed at the wrong
// port, can report instances without a service name. Sorting must not panic.
func TestAggregatedInstancesToleratesMissingInstanceName(t *testing.T) {
	const hubA = "http://a:18080"
	p := newTestProxy([]Hub{{BaseURL: hubA}}, breezeRoute(hubA, hubA))
	p.hub.apply(hubA, []map[string]any{
		{"id": "a1", "status": "READY"},
		{"instanceName": "breeze", "status": "READY"},
	}, 5*time.Millisecond, nil)

	rec := httptest.NewRecorder()
	p.handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/instances", nil))
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var out []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out) != 2 {
		t.Fatalf("instances = %v, want both entries passed through", out)
	}
	if out[0]["instanceName"] != nil || out[1]["instanceName"] != "breeze" {
		t.Errorf("order = %v, want the nameless entry first", out)
	}
}

func TestFarmHealthReportsRoutes(t *testing.T) {
	const hubA, hubB = "http://a:18080", "http://b:18080"
	p := newTestProxy([]Hub{{BaseURL: hubA}, {BaseURL: hubB}}, breezeRoute(hubA, hubB))
	markReady(p.hub, hubA, "breeze")
	markDown(p.hub, hubB)

	rec := httptest.NewRecorder()
	p.handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/farm/health", nil))
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var out struct {
		OK           bool `json:"ok"`
		HubsUp       int  `json:"hubsUp"`
		HubsTotal    int  `json:"hubsTotal"`
		ReadyAliases int  `json:"readyAliases"`
		Hubs         []struct {
			BaseURL string `json:"baseUrl"`
			OK      bool   `json:"ok"`
		} `json:"hubs"`
		Routes []struct {
			Aliases  []string `json:"aliases"`
			Resolved string   `json:"resolved"`
		} `json:"routes"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !out.OK || out.HubsUp != 1 || out.HubsTotal != 2 {
		t.Errorf("ok=%v hubsUp=%d/%d, want true 1/2", out.OK, out.HubsUp, out.HubsTotal)
	}
	if out.ReadyAliases != 2 {
		t.Errorf("readyAliases = %d, want 2 (breeze + expressive)", out.ReadyAliases)
	}
	if len(out.Routes) != 1 || out.Routes[0].Resolved != hubA+"/breeze" {
		t.Errorf("routes = %+v, want resolution to %s/breeze", out.Routes, hubA)
	}
	for _, h := range out.Hubs {
		if h.BaseURL == hubB && h.OK {
			t.Error("down hub reported as up")
		}
	}
}

func TestUnknownEndpointListsSurface(t *testing.T) {
	p := newTestProxy([]Hub{{BaseURL: "http://a:18080"}}, breezeRoute("http://a:18080", "http://a:18080"))
	rec := httptest.NewRecorder()
	p.handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/audio/transcriptions", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	env := errorEnvelope(t, rec)
	if !strings.Contains(env["message"].(string), "/v1/audio/transcriptions") {
		t.Errorf("message = %q, want it to echo the path", env["message"])
	}
	paths, _ := env["endpoints"].([]any)
	if len(paths) != 4 {
		t.Errorf("endpoints = %v, want the 4 served routes", paths)
	}
}

func TestCORSPreflight(t *testing.T) {
	p := newTestProxy([]Hub{{BaseURL: "http://a:18080"}}, breezeRoute("http://a:18080", "http://a:18080"))
	rec := httptest.NewRecorder()
	p.handler().ServeHTTP(rec, httptest.NewRequest(http.MethodOptions, "/v1/audio/speech", nil))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Error("preflight is missing Access-Control-Allow-Origin")
	}
}
