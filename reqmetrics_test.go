package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeClock drives RequestMetrics deterministically in unit tests.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func newTestMetrics(start time.Time) (*RequestMetrics, *fakeClock) {
	clk := &fakeClock{t: start}
	m := NewRequestMetrics(start)
	m.now = clk.now
	m.probe = func(*Instance) (bool, bool) { return false, false }
	return m, clk
}

func TestSanitizeClientTag(t *testing.T) {
	cases := map[string]string{
		"":                       "",
		"   ":                    "",
		"reachy-mini":            "reachy-mini",
		" reachy/1.2@lab ":       "reachy/1.2@lab",
		"bad tag\n<script>":      "bad_tag__script_",
		"a:b+c=d.e_f":            "a:b+c=d.e_f",
		strings.Repeat("x", 100): strings.Repeat("x", clientTagMaxLen),
		"émoji🙂":                 "_moji_",
	}
	for in, want := range cases {
		if got := sanitizeClientTag(in); got != want {
			t.Errorf("sanitizeClientTag(%q) = %q; want %q", in, got, want)
		}
	}
}

func TestCallerIPHonoursForwardedForOnlyFromLoopback(t *testing.T) {
	cases := []struct{ remote, xff, want string }{
		{"10.1.2.3:5555", "203.0.113.9", "10.1.2.3"},
		{"127.0.0.1:5555", "203.0.113.9, 127.0.0.1", "203.0.113.9"},
		{"127.0.0.1:5555", "", "127.0.0.1"},
		{"[::1]:5555", "not-an-ip", "::1"},
		{"[::1]:5555", " 2001:db8::1 ", "2001:db8::1"},
	}
	for _, c := range cases {
		r := httptest.NewRequest("POST", "/v1/audio/speech", nil)
		r.RemoteAddr = c.remote
		if c.xff != "" {
			r.Header.Set("X-Forwarded-For", c.xff)
		}
		if got := callerIP(r); got != c.want {
			t.Errorf("callerIP(remote=%s xff=%q) = %q; want %q", c.remote, c.xff, got, c.want)
		}
	}
}

func TestPercentileNearestRank(t *testing.T) {
	v := []int64{10, 1, 9, 2, 8, 3, 7, 4, 6, 5}
	if p := rankPercentile(v, 0.5); p != 5 {
		t.Errorf("p50 = %d; want 5", p)
	}
	if p := rankPercentile(v, 0.9); p != 9 {
		t.Errorf("p90 = %d; want 9", p)
	}
	if p := rankPercentile([]int64{42}, 0.9); p != 42 {
		t.Errorf("single p90 = %d; want 42", p)
	}
}

func TestRequestRingNewestFirstAndCapped(t *testing.T) {
	m, clk := newTestMetrics(time.Now().Add(-time.Hour))
	inst := &Instance{ID: "a1", Name: "kokoro", ModelID: "kokoro", ServerTask: "tts", Status: "READY"}
	for i := 0; i < requestRingCap+5; i++ {
		r := httptest.NewRequest("POST", "/v1/audio/speech", nil)
		rec := m.Begin(r, "/v1/audio/speech")
		rec.SetInstance(inst)
		rw := rec.Wrap(httptest.NewRecorder())
		rw.WriteHeader(200)
		clk.advance(time.Millisecond)
		rec.Finish()
	}
	got := m.Recent("kokoro", 1000, false)
	if len(got) != requestRingCap {
		t.Fatalf("ring holds %d; want %d", len(got), requestRingCap)
	}
	for i := 1; i < len(got); i++ {
		if got[i-1].StartMs < got[i].StartMs {
			t.Fatalf("not newest first at %d", i)
		}
	}
	if got[0].ID == got[1].ID {
		t.Fatal("ids must be unique")
	}
}

func TestMeterChunkTimelineFlagsGapsAndUnderrun(t *testing.T) {
	m, clk := newTestMetrics(time.Now().Add(-time.Hour))
	inst := &Instance{ID: "a1", Name: "ming3-tts", ModelID: "ming3_tts", ServerTask: "tts", Status: "READY"}
	r := httptest.NewRequest("POST", "/v1/audio/speech", nil)
	rec := m.Begin(r, "/v1/audio/speech")
	rec.SetInstance(inst)
	rec.streamRequested = true
	rw := rec.Wrap(httptest.NewRecorder())
	rw.Header().Set("Content-Type", "audio/wav")
	clk.advance(400 * time.Millisecond)
	rw.WriteHeader(200)
	// 8 kHz mono PCM16 = 16000 B/s. Header (44) + 0.1 s.
	w := pcmWAV(8000, 800, 1)
	rw.Write(w[:44])
	rw.Write(w[44:]) // coalesced into the same chunk
	clk.advance(50 * time.Millisecond)
	rw.Write(make([]byte, 1600)) // +0.1 s, gap 50 ms: fine
	clk.advance(350 * time.Millisecond)
	rw.Write(make([]byte, 3200)) // +0.2 s after a 350 ms gap: flagged, and the player ran dry
	clk.advance(10 * time.Millisecond)
	rec.Finish()

	got := m.Recent("ming3-tts", 1, true)[0]
	if !got.Streamed || got.Status != 200 {
		t.Fatalf("streamed=%v status=%d", got.Streamed, got.Status)
	}
	if len(got.Chunks) != 3 {
		t.Fatalf("chunks = %+v; want 3 (writes within the coalesce window merge)", got.Chunks)
	}
	if got.Chunks[0].AtMs != 400 || got.Chunks[0].Bytes != 44+1600 {
		t.Errorf("first chunk %+v", got.Chunks[0])
	}
	if got.Chunks[2].GapMs != 350 || !got.Chunks[2].Slow || got.Chunks[1].Slow {
		t.Errorf("gap flags wrong: %+v", got.Chunks)
	}
	if got.GapsOver100ms != 1 || got.MaxGapMs != 350 {
		t.Errorf("gapsOver100ms=%d maxGapMs=%d", got.GapsOver100ms, got.MaxGapMs)
	}
	if got.FirstAudioMs == nil || *got.FirstAudioMs != 400 || got.TTFBMs == nil || *got.TTFBMs != 400 {
		t.Errorf("first audio/ttfb wrong: %v %v", got.FirstAudioMs, got.TTFBMs)
	}
	if got.OutputAudioSec == nil || *got.OutputAudioSec != 0.4 {
		t.Errorf("output audio = %v; want 0.4", got.OutputAudioSec)
	}
	// Played 0.2 s by 400 ms after first audio; chunk 3 arrived at +400 ms → -200 ms headroom.
	if got.MinHeadroomMs == nil || *got.MinHeadroomMs != -200 || !got.Underrun {
		t.Errorf("headroom = %v underrun=%v; want -200/true", got.MinHeadroomMs, got.Underrun)
	}
	if got.TotalMs == nil || *got.TotalMs != 810 || got.RTF == nil || *got.RTF != 2.025 {
		t.Errorf("total=%v rtf=%v", got.TotalMs, got.RTF)
	}
}

func TestQueueWaitAndColdLoadFlags(t *testing.T) {
	m, clk := newTestMetrics(time.Now().Add(-time.Hour))
	probes := 0
	m.probe = func(*Instance) (bool, bool) { probes++; return false, true } // engine says not loaded
	inst := &Instance{ID: "a1", Name: "kokoro", ModelID: "kokoro", ServerTask: "tts", Status: "READY"}

	r1 := httptest.NewRequest("POST", "/v1/audio/speech", nil)
	a := m.Begin(r1, "/v1/audio/speech")
	a.SetInstance(inst)
	aw := a.Wrap(httptest.NewRecorder())
	clk.advance(100 * time.Millisecond)
	b := m.Begin(httptest.NewRequest("POST", "/v1/audio/speech", nil), "/v1/audio/speech")
	b.SetInstance(inst) // a is in flight: no probe, inherits a's load
	bw := b.Wrap(httptest.NewRecorder())
	if probes != 1 {
		t.Fatalf("probes = %d; want 1 (only when idle)", probes)
	}
	st := m.instanceSnapshot("kokoro")
	if st.inFlight != 2 {
		t.Fatalf("inflight = %d", st.inFlight)
	}
	clk.advance(900 * time.Millisecond)
	aw.WriteHeader(200)
	aw.Write([]byte("x"))
	a.Finish() // a ends at +1000 ms
	clk.advance(300 * time.Millisecond)
	bw.WriteHeader(200)
	bw.Write([]byte("y"))
	b.Finish()

	got := m.Recent("kokoro", 2, false)
	newest, oldest := got[0], got[1]
	if oldest.ColdLoad == nil || !*oldest.ColdLoad || oldest.ColdLoadSource != "engine" {
		t.Errorf("first request should be a cold load: %+v %q", oldest.ColdLoad, oldest.ColdLoadSource)
	}
	if newest.ColdLoad == nil || *newest.ColdLoad {
		t.Errorf("second request was queued behind the load, not a cold load itself: %v", newest.ColdLoad)
	}
	if newest.QueueWaitMs == nil || *newest.QueueWaitMs != 900 || newest.InFlightAtStart != 1 {
		t.Errorf("queue wait = %v inflightAtStart=%d; want 900/1", newest.QueueWaitMs, newest.InFlightAtStart)
	}
	if oldest.QueueWaitMs == nil || *oldest.QueueWaitMs != 0 {
		t.Errorf("idle request queue wait = %v; want 0", oldest.QueueWaitMs)
	}
	if m.instanceSnapshot("kokoro").lastColdLoadAt.IsZero() {
		t.Error("last cold load time not recorded")
	}
}

func TestRestartOverlapFlag(t *testing.T) {
	start := time.Now()
	m, clk := newTestMetrics(start)
	inst := &Instance{ID: "a1", Name: "kokoro", ServerTask: "tts", Status: "READY",
		CreatedAt: start.Add(-time.Hour).UTC().Format("2006-01-02T15:04:05.000Z")}
	clk.advance(30 * time.Second)
	rec := m.Begin(httptest.NewRequest("POST", "/v1/audio/speech", nil), "/v1/audio/speech")
	rec.SetInstance(inst)
	rec.Wrap(httptest.NewRecorder()).WriteHeader(200)
	rec.Finish()
	got := m.Recent("kokoro", 1, false)[0]
	if !got.NearRestart || got.RestartReason != "hub" || got.HubUptimeMsAtStart != 30000 {
		t.Errorf("near restart=%v reason=%q uptime=%d", got.NearRestart, got.RestartReason, got.HubUptimeMsAtStart)
	}

	clk.advance(10 * time.Minute)
	inst2 := &Instance{ID: "a2", Name: "kokoro", ServerTask: "tts", Status: "READY",
		CreatedAt: clk.now().Add(-time.Hour).UTC().Format("2006-01-02T15:04:05.000Z")}
	rec = m.Begin(httptest.NewRequest("POST", "/v1/audio/speech", nil), "/v1/audio/speech")
	rec.SetInstance(inst2)
	rec.Wrap(httptest.NewRecorder()).WriteHeader(200)
	rec.Finish()
	got = m.Recent("kokoro", 1, false)[0]
	if !got.NearRestart || got.RestartReason != "instance-replaced" {
		t.Errorf("instance id change must flag: %v %q", got.NearRestart, got.RestartReason)
	}
}

// --- end-to-end through the /v1 proxy ---

type obsEngine struct {
	mu      sync.Mutex
	headers []http.Header
	loaded  bool
}

func (e *obsEngine) handler(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && r.URL.Path == "/v1/models" {
		e.mu.Lock()
		loaded := e.loaded
		e.mu.Unlock()
		writeJSON(w, 200, map[string]any{"object": "list", "data": []any{map[string]any{"id": "x", "loaded": loaded}}})
		return
	}
	io.Copy(io.Discard, r.Body)
	e.mu.Lock()
	e.headers = append(e.headers, r.Header.Clone())
	e.loaded = true
	e.mu.Unlock()
	switch r.URL.Path {
	case "/v1/audio/transcriptions":
		writeJSON(w, 200, map[string]any{"text": "ok"})
	case "/v1/audio/speech":
		w.Header().Set("Content-Type", "audio/wav")
		w.Write(pcmWAV(8000, 8000, 3)) // 1.0 s
	default:
		w.WriteHeader(404)
	}
}

func newObsHub(t *testing.T, e *obsEngine, modelID, task string) (*Hub, string) {
	t.Helper()
	chdirTemp(t)
	engine := httptest.NewServer(http.HandlerFunc(e.handler))
	t.Cleanup(engine.Close)
	h := &Hub{cfg: HubConfig{ProxyMaxBodyBytes: 1 << 20}, instances: NewInstanceManager(18090, 8080), history: NewHistoryManager()}
	h.metrics = NewRequestMetrics(time.Now().Add(-time.Hour))
	idle := 60000
	dev := 1
	h.instances.items["m1"] = &Instance{ID: "m1", Name: strings.ReplaceAll(modelID, "_", "-"), ModelID: modelID,
		EngineFamily: modelID, ServerTask: task, Status: "READY", Port: portOf(t, engine.URL),
		Backend: "vulkan", Device: &dev, IdleUnloadMs: &idle,
		CreatedAt: time.Now().Add(-time.Hour).UTC().Format("2006-01-02T15:04:05.000Z")}
	hub := httptest.NewServer(h.newHandler())
	t.Cleanup(hub.Close)
	return h, hub.URL
}

func getJSON(t *testing.T, url string, v any) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("GET %s: %d %s", url, resp.StatusCode, b)
	}
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		t.Fatal(err)
	}
}

func TestV1ProxyRecordsMetadataNeverText(t *testing.T) {
	e := &obsEngine{}
	_, url := newObsHub(t, e, "kokoro", "tts")
	secret := "the quick brown fox whispers a secret 你好"
	resp := postSpeech(t, url, `{"model":"kokoro","input":"`+secret+`","voice":"af"}`,
		map[string]string{"X-Client": "reachy-mini/2", "X-Hub-No-Archive": "1"})
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	reqID := resp.Header.Get("X-Hub-Request-Id")
	if resp.StatusCode != 200 || reqID == "" {
		t.Fatalf("status %d request id %q", resp.StatusCode, reqID)
	}
	if len(e.headers) != 1 || e.headers[0].Get("X-Client") != "" {
		t.Fatalf("X-Client is hub-only and must not reach the engine: %v", e.headers)
	}

	resp2, _ := http.Get(url + "/api/metrics/recent?instance=kokoro&limit=5&chunks=1")
	raw, _ := io.ReadAll(resp2.Body)
	resp2.Body.Close()
	if strings.Contains(string(raw), "secret") || strings.Contains(string(raw), "你好") {
		t.Fatalf("request log must never hold the input text: %s", raw)
	}
	var out struct {
		Requests []RequestRecord `json:"requests"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || len(out.Requests) != 1 {
		t.Fatalf("decode %v: %s", err, raw)
	}
	got := out.Requests[0]
	if got.ID != reqID || got.Client != "reachy-mini/2" || got.Instance != "kokoro" || got.ModelFamily != "kokoro" ||
		got.Route != "/v1/audio/speech" || got.Task != "tts" || got.CallerIP != "127.0.0.1" {
		t.Errorf("identity fields wrong: %+v", got)
	}
	if got.InputChars == nil || *got.InputChars != len([]rune(secret)) || got.InputBytes == 0 {
		t.Errorf("input chars = %v; want %d", got.InputChars, len([]rune(secret)))
	}
	if got.Status != 200 || got.Streamed || got.InFlight || got.OutputAudioSec == nil || *got.OutputAudioSec != 1.0 {
		t.Errorf("result fields wrong: status=%d streamed=%v out=%v", got.Status, got.Streamed, got.OutputAudioSec)
	}
	if got.TotalMs == nil || got.FirstAudioMs == nil || got.RTF == nil || got.ColdLoad == nil || !*got.ColdLoad {
		t.Errorf("timing/cold fields missing: %+v", got)
	}

	var one RequestRecord
	getJSON(t, url+"/api/metrics/requests/"+reqID, &one)
	if one.ID != reqID {
		t.Errorf("detail lookup returned %q", one.ID)
	}
}

func TestV1ProxyRecordsASRInputSeconds(t *testing.T) {
	e := &obsEngine{loaded: true}
	_, url := newObsHub(t, e, "parakeet", "asr")
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	mw.WriteField("model", "parakeet")
	fw, _ := mw.CreateFormFile("file", "a.wav")
	fw.Write(pcmWAV(16000, 32000, 1)) // 2.0 s
	mw.Close()
	resp, err := http.Post(url+"/v1/audio/transcriptions", mw.FormDataContentType(), &body)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	var out struct {
		Requests []RequestRecord `json:"requests"`
	}
	getJSON(t, url+"/api/metrics/recent", &out)
	got := out.Requests[0]
	if got.InputAudioSec == nil || *got.InputAudioSec != 2.0 || got.Task != "asr" {
		t.Fatalf("input audio = %v task=%q", got.InputAudioSec, got.Task)
	}
	if got.RTF == nil || got.OutputAudioSec != nil || got.ColdLoad == nil || *got.ColdLoad {
		t.Errorf("asr rtf=%v out=%v cold=%v", got.RTF, got.OutputAudioSec, got.ColdLoad)
	}
}

func TestV1ProxyRecordsUnroutedErrors(t *testing.T) {
	_, url := newObsHub(t, &obsEngine{}, "kokoro", "tts")
	resp := postSpeech(t, url, `{"model":"nope","input":"hi"}`, nil)
	resp.Body.Close()
	var out struct {
		Requests []RequestRecord `json:"requests"`
	}
	getJSON(t, url+"/api/metrics/recent?instance=_unrouted", &out)
	if len(out.Requests) != 1 {
		t.Fatalf("got %d", len(out.Requests))
	}
	got := out.Requests[0]
	if got.Status != 404 || got.Instance != "nope" || !strings.Contains(got.Error, "Model not found") {
		t.Errorf("unrouted record %+v", got)
	}
}

func TestV1ChunkedStreamRecordsTimelineAndSegments(t *testing.T) {
	e := &chunkEngine{}
	h, url := newChunkHub(t, e, "ming3_tts")
	h.metrics = NewRequestMetrics(time.Now().Add(-time.Hour))
	h.metrics.probe = func(*Instance) (bool, bool) { return true, true }
	body := `{"model":"ming3-tts","input":"` + threeSentences + `","stream":true,"stream_format":"sse"}`
	resp := postSpeech(t, url, body, map[string]string{"X-Client": "reachy"})
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	id := resp.Header.Get("X-Hub-Request-Id")
	var got RequestRecord
	getJSON(t, url+"/api/metrics/requests/"+id, &got)
	if !got.Streamed || got.StreamMode != "sentence-chunked" || got.Status != 200 {
		t.Fatalf("streamed=%v mode=%q status=%d", got.Streamed, got.StreamMode, got.Status)
	}
	if len(got.Segments) != 4 || got.Segments[0].Chars == 0 {
		t.Errorf("segments = %+v; want 4 with char counts", got.Segments)
	}
	if len(got.Chunks) == 0 || got.FirstAudioMs == nil {
		t.Errorf("chunks=%d firstAudio=%v", len(got.Chunks), got.FirstAudioMs)
	}
	// 4 chunks × 400 samples @ 8 kHz = 0.2 s, counted from the SSE PCM, not base64 bytes.
	if got.OutputAudioSec == nil || *got.OutputAudioSec != 0.2 {
		t.Errorf("output audio = %v; want 0.2", got.OutputAudioSec)
	}
}

func TestMetricsSummaryReportsInstanceStatusAndPercentiles(t *testing.T) {
	e := &obsEngine{}
	_, url := newObsHub(t, e, "kokoro", "tts")
	var sum MetricsSummary
	getJSON(t, url+"/api/metrics/summary", &sum)
	if len(sum.Instances) != 1 {
		t.Fatalf("instances = %+v", sum.Instances)
	}
	is := sum.Instances[0]
	if is.State != "cold" || is.StateSource != "engine" || is.Device != "vulkan:1" || is.IdleUnloadMs == nil {
		t.Errorf("cold status wrong: %+v", is)
	}
	for i := 0; i < 3; i++ {
		resp := postSpeech(t, url, `{"model":"kokoro","input":"hello"}`, nil)
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}
	getJSON(t, url+"/api/metrics/summary", &sum)
	is = sum.Instances[0]
	if is.State != "loaded" || is.LastUseAt == 0 || is.UnloadInMs == nil || *is.UnloadInMs <= 0 || is.LastColdLoadAt == 0 {
		t.Errorf("loaded status wrong: %+v", is)
	}
	w15 := is.Windows["15m"]
	if w15.Count != 3 || w15.Errors != 0 || w15.ColdLoads != 1 || w15.FirstAudioP50Ms == nil || w15.TotalP90Ms == nil {
		t.Errorf("15m window wrong: %+v", w15)
	}
	if sum.HubStartedAt == 0 || sum.HubUptimeMs < 3600000-5000 {
		t.Errorf("hub start/uptime wrong: %d %d", sum.HubStartedAt, sum.HubUptimeMs)
	}
}

type failingWriter struct{ *httptest.ResponseRecorder }

func (failingWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

// A client that hangs up right after reading a complete Content-Length body
// cancels the request context before Finish runs; that is not an abort.
func TestClientAbortedOnlyWhenReplyIncomplete(t *testing.T) {
	m, _ := newTestMetrics(time.Now().Add(-time.Hour))
	inst := &Instance{ID: "a1", Name: "kokoro", ModelID: "kokoro", ServerTask: "tts", Status: "READY"}
	run := func(name string, w http.ResponseWriter, contentLength string, body []byte, cancel bool) bool {
		t.Helper()
		ctx, stop := context.WithCancel(context.Background())
		defer stop()
		r := httptest.NewRequest("POST", "/v1/audio/speech", nil).WithContext(ctx)
		rec := m.Begin(r, "/v1/audio/speech")
		rec.SetInstance(inst)
		rw := rec.Wrap(w)
		if contentLength != "" {
			rw.Header().Set("Content-Length", contentLength)
		}
		rw.WriteHeader(200)
		_, _ = rw.Write(body)
		if cancel {
			stop()
		}
		rec.Finish()
		return m.Recent("kokoro", 1, false)[0].ClientAborted
	}
	body := []byte("0123456789")
	if run("complete", httptest.NewRecorder(), "10", body, true) {
		t.Error("complete Content-Length reply then hang-up: want clientAborted=false")
	}
	if !run("short", httptest.NewRecorder(), "20", body, true) {
		t.Error("hang-up before Content-Length was delivered: want clientAborted=true")
	}
	if !run("chunked", httptest.NewRecorder(), "", body, true) {
		t.Error("hang-up while the handler was still streaming: want clientAborted=true")
	}
	if !run("write error", failingWriter{httptest.NewRecorder()}, "", body, false) {
		t.Error("write to client failed: want clientAborted=true")
	}
	if run("normal", httptest.NewRecorder(), "", body, false) {
		t.Error("normal reply: want clientAborted=false")
	}
}
