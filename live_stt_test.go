package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Live speech-to-text through the hub (#200): streaming-mode instances and the
// /v1/audio/transcriptions/live pass-through to the audio.cpp engine.

// --- server.json / instance JSON ---

func TestWriteServerJSONModeAndLiveIngest(t *testing.T) {
	path := filepath.Join(t.TempDir(), "server.json")
	model := func(p StartParams) map[string]any {
		t.Helper()
		if err := writeServerJSON(path, 18090, p, "m"); err != nil {
			t.Fatal(err)
		}
		var root struct {
			Models []map[string]any `json:"models"`
		}
		data, _ := os.ReadFile(path)
		if err := json.Unmarshal(data, &root); err != nil || len(root.Models) != 1 {
			t.Fatalf("server.json %s: %v", data, err)
		}
		return root.Models[0]
	}
	if got := model(StartParams{Backend: "cpu"}); got["mode"] != "offline" || got["live_ingest"] != nil {
		t.Fatalf("default must stay offline with no live_ingest: %v", got)
	}
	got := model(StartParams{Backend: "cpu", Mode: "streaming",
		LiveIngest: map[string]int64{"idleTimeoutMs": 60000, "maxChunkBytes": 65536, "totalTimeoutMs": 0}})
	if got["mode"] != "streaming" {
		t.Fatalf("mode = %v; want streaming", got["mode"])
	}
	li, _ := got["live_ingest"].(map[string]any)
	if li["idle_timeout_ms"] != float64(60000) || li["max_chunk_bytes"] != float64(65536) || li["total_timeout_ms"] != float64(0) || len(li) != 3 {
		t.Fatalf("live_ingest = %v; want snake_case engine keys", li)
	}
}

func TestInstanceJSONExposesMode(t *testing.T) {
	m := NewInstanceManager(18090, 8080)
	if out := m.ToJSON(&Instance{ID: "a"}, 0); out["mode"] != "offline" || out["liveIngest"] != nil {
		t.Errorf("unset mode must read offline: %v", out)
	}
	out := m.ToJSON(&Instance{ID: "b", Mode: "streaming", LiveIngest: map[string]int64{"idleTimeoutMs": 5000}}, 0)
	if out["mode"] != "streaming" {
		t.Errorf("mode = %v", out["mode"])
	}
	if li, _ := out["liveIngest"].(map[string]int64); li["idleTimeoutMs"] != 5000 {
		t.Errorf("liveIngest = %v", out["liveIngest"])
	}
}

func TestParseInstanceModeValidation(t *testing.T) {
	streamCard := map[string]any{"modes": []any{"offline", "streaming"}}
	offlineCard := map[string]any{"modes": []any{"offline"}}
	cases := []struct {
		name string
		card map[string]any
		body string
		mode string
		code string
	}{
		{"absent defaults offline", streamCard, `{}`, "offline", ""},
		{"explicit offline", offlineCard, `{"mode":"offline"}`, "offline", ""},
		{"streaming allowed", streamCard, `{"mode":"streaming","liveIngest":{"idleTimeoutMs":30000,"maxChunkBytes":65536}}`, "streaming", ""},
		{"unknown mode", streamCard, `{"mode":"realtime"}`, "", "MODE_INVALID"},
		{"non-string mode", streamCard, `{"mode":1}`, "", "MODE_INVALID"},
		{"card lacks streaming", offlineCard, `{"mode":"streaming"}`, "", "MODE_UNSUPPORTED"},
		{"liveIngest needs streaming", streamCard, `{"liveIngest":{"idleTimeoutMs":1}}`, "", "LIVE_INGEST_REQUIRES_STREAMING"},
		{"negative limit", streamCard, `{"mode":"streaming","liveIngest":{"idleTimeoutMs":-1}}`, "", "LIVE_INGEST_INVALID"},
		{"zero chunk", streamCard, `{"mode":"streaming","liveIngest":{"maxChunkBytes":0}}`, "", "LIVE_INGEST_INVALID"},
		{"unknown key", streamCard, `{"mode":"streaming","liveIngest":{"bogus":1}}`, "", "LIVE_INGEST_INVALID"},
		{"fractional", streamCard, `{"mode":"streaming","liveIngest":{"idleTimeoutMs":1.5}}`, "", "LIVE_INGEST_INVALID"},
		{"not object", streamCard, `{"mode":"streaming","liveIngest":5}`, "", "LIVE_INGEST_INVALID"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var body map[string]any
			if err := json.Unmarshal([]byte(c.body), &body); err != nil {
				t.Fatal(err)
			}
			mode, li, err := parseInstanceMode(body, c.card)
			if got := instErrCode(err); got != c.code {
				t.Fatalf("code = %q; want %q (err %v)", got, c.code, err)
			}
			if c.code == "" && mode != c.mode {
				t.Fatalf("mode = %q; want %q", mode, c.mode)
			}
			if c.name == "streaming allowed" && (li["idleTimeoutMs"] != 30000 || li["maxChunkBytes"] != 65536) {
				t.Fatalf("liveIngest = %v", li)
			}
		})
	}
}

func TestInstanceStartRejectsBadMode(t *testing.T) {
	chdirTemp(t)
	weights := filepath.Join(t.TempDir(), "w.gguf")
	os.WriteFile(weights, []byte("x"), 0644)
	h := &Hub{cfg: HubConfig{ProxyMaxBodyBytes: 1 << 20}, instances: NewInstanceManager(18090, 8080)}
	hub := httptest.NewServer(h.newHandler())
	defer hub.Close()
	for _, c := range []struct {
		body map[string]any
		code string
	}{
		{map[string]any{"modelId": "parakeet_tdt", "weightsPath": weights, "mode": "turbo"}, "MODE_INVALID"},
		{map[string]any{"modelId": "fish_drama3", "weightsPath": weights, "mode": "streaming"}, "MODE_UNSUPPORTED"},
	} {
		raw, _ := json.Marshal(c.body)
		resp, err := http.Post(hub.URL+"/api/instances", "application/json", bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		out, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(out), c.code) {
			t.Errorf("%v: status %d body %s; want 400 %s", c.body, resp.StatusCode, out, c.code)
		}
	}
}

// --- catalog ---

func TestVoxtralRealtimeCard(t *testing.T) {
	assertASRCard(t, "voxtral_realtime", "voxtral_realtime", []any{"offline", "streaming"})
	if findPackageFamily("voxtral_realtime") == nil {
		t.Fatal("voxtral_realtime lost its download packages")
	}
}

func TestKrokoASRCard(t *testing.T) {
	assertASRCard(t, "kroko_asr", "kroko_asr", []any{"offline", "streaming"})
}

// Cards must not under-report streaming the engine's model spec declares.
func TestStreamingASRCardsMatchEngine(t *testing.T) {
	for _, id := range []string{"nemotron_asr", "parakeet_tdt", "higgs_audio_stt", "qwen3_asr", "moss_transcribe_diarize", "voxtral_realtime", "kroko_asr"} {
		model := findModel(id)
		if model == nil {
			t.Errorf("%s not registered", id)
			continue
		}
		if !cardSupportsMode(model, "streaming") {
			t.Errorf("%s modes = %v; engine spec declares streaming", id, model["modes"])
		}
	}
}

// --- /v1/audio/transcriptions/live ---

// liveEngine imitates audiocpp_server's live route: one SSE delta per received
// 3200-byte PCM chunk (100 ms of 16 kHz s16le), written and flushed before the
// next chunk is read.
type liveEngine struct {
	mu        sync.Mutex
	query     string
	header    http.Header
	chunked   bool
	got       int64
	bodyErr   error
	done      chan struct{}
	failFirst bool
}

func newLiveEngine() *liveEngine { return &liveEngine{done: make(chan struct{})} }

func (e *liveEngine) handler(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/v1/audio/transcriptions/live" || r.Method != http.MethodPost {
		w.WriteHeader(404) // e.g. the hub's /v1/models health probe
		return
	}
	defer close(e.done)
	e.mu.Lock()
	e.query = r.URL.RawQuery
	e.header = r.Header.Clone()
	e.chunked = len(r.TransferEncoding) > 0 && r.TransferEncoding[0] == "chunked"
	e.mu.Unlock()
	if e.failFirst {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(400)
		w.Write([]byte(`{"error":{"message":"model is not configured for streaming"}}`))
		return
	}
	http.NewResponseController(w).EnableFullDuplex()
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(200)
	w.(http.Flusher).Flush()
	buf := make([]byte, 3200)
	n := 0
	for {
		_, err := io.ReadFull(r.Body, buf)
		if err != nil {
			e.mu.Lock()
			if err != io.EOF {
				e.bodyErr = err
			}
			e.mu.Unlock()
			break
		}
		n++
		e.mu.Lock()
		e.got += int64(len(buf))
		e.mu.Unlock()
		fmt.Fprintf(w, "data: {\"type\":\"transcript.text.delta\",\"delta\":\" zebra%d\"}\n\n", n)
		w.(http.Flusher).Flush()
	}
	e.mu.Lock()
	failed := e.bodyErr != nil
	e.mu.Unlock()
	if failed {
		return
	}
	fmt.Fprintf(w, "data: {\"type\":\"transcript.text.done\",\"text\":\"zebra words\"}\n\ndata: [DONE]\n\n")
}

func newLiveHub(t *testing.T, e *liveEngine, mode, status string) (*Hub, string) {
	t.Helper()
	chdirTemp(t)
	engine := httptest.NewServer(http.HandlerFunc(e.handler))
	t.Cleanup(engine.Close)
	h := &Hub{cfg: HubConfig{ProxyMaxBodyBytes: 1 << 10}, instances: NewInstanceManager(18090, 8080), history: NewHistoryManager()}
	h.metrics = NewRequestMetrics(time.Now().Add(-time.Hour))
	h.instances.items["m1"] = &Instance{ID: "m1", Name: "bark3-live", ModelID: "parakeet_tdt", EngineFamily: "parakeet_tdt",
		ServerTask: "asr", Status: status, Port: portOf(t, engine.URL), Backend: "vulkan", Mode: mode,
		CreatedAt: time.Now().Add(-time.Hour).UTC().Format("2006-01-02T15:04:05.000Z")}
	hub := httptest.NewServer(h.newHandler())
	t.Cleanup(hub.Close)
	return h, hub.URL
}

const liveQuery = "/v1/audio/transcriptions/live?model=bark3-live&sample_rate=16000&channels=1&sample_format=s16le&language=en"

// startLive opens a chunked live upload; the caller writes PCM into the pipe.
func startLive(t *testing.T, ctx context.Context, url string) (*io.PipeWriter, *http.Response) {
	t.Helper()
	pr, pw := io.Pipe()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url+liveQuery, pr)
	if err != nil {
		t.Fatal(err)
	}
	req.ContentLength = -1
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-Client", "mic-test/1")
	req.Header.Set("X-Hub-No-Archive", "1")
	type result struct {
		resp *http.Response
		err  error
	}
	ch := make(chan result, 1)
	go func() {
		resp, err := http.DefaultClient.Do(req)
		ch <- result{resp, err}
	}()
	// The engine answers headers before any audio arrives, so the response must
	// come back while the upload is still open.
	select {
	case r := <-ch:
		if r.err != nil {
			t.Fatal(r.err)
		}
		return pw, r.resp
	case <-time.After(5 * time.Second):
		t.Fatal("no response headers while upload open: hub is buffering the request")
	}
	return nil, nil
}

func readEvent(t *testing.T, br *bufio.Reader) string {
	t.Helper()
	type res struct {
		line string
		err  error
	}
	ch := make(chan res, 1)
	go func() {
		for {
			line, err := br.ReadString('\n')
			if err != nil || strings.HasPrefix(line, "data:") {
				ch <- res{strings.TrimSpace(line), err}
				return
			}
		}
	}()
	select {
	case r := <-ch:
		if r.err != nil {
			t.Fatalf("read event: %v", r.err)
		}
		return r.line
	case <-time.After(5 * time.Second):
		t.Fatal("no SSE event within 5s: hub is buffering the response")
	}
	return ""
}

func TestLiveTranscriptionFullDuplexPassThrough(t *testing.T) {
	e := newLiveEngine()
	_, url := newLiveHub(t, e, "streaming", "READY")
	pw, resp := startLive(t, context.Background(), url)
	defer resp.Body.Close()
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("status %d content-type %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	reqID := resp.Header.Get("X-Hub-Request-Id")
	if reqID == "" {
		t.Fatal("missing X-Hub-Request-Id")
	}
	br := bufio.NewReader(resp.Body)
	chunk := make([]byte, 3200) // 100 ms of 16 kHz s16le mono
	const chunks = 5            // 2000 bytes is over the 1 KiB buffered-proxy limit: no spill, no 413
	for i := 1; i <= chunks; i++ {
		if _, err := pw.Write(chunk); err != nil {
			t.Fatal(err)
		}
		// Lockstep: delta i must reach the client before chunk i+1 is sent.
		if ev := readEvent(t, br); !strings.Contains(ev, fmt.Sprintf("zebra%d", i)) {
			t.Fatalf("event %d = %q", i, ev)
		}
		if entries, _ := os.ReadDir(v1CacheDir); len(entries) > 0 {
			t.Fatalf("live audio spilled to disk: %d files in %s", len(entries), v1CacheDir)
		}
	}
	pw.Close()
	if ev := readEvent(t, br); !strings.Contains(ev, "transcript.text.done") {
		t.Fatalf("final event %q", ev)
	}
	if ev := readEvent(t, br); ev != "data: [DONE]" {
		t.Fatalf("terminator %q", ev)
	}
	io.Copy(io.Discard, br)
	<-e.done

	e.mu.Lock()
	if !e.chunked || e.got != chunks*3200 {
		t.Errorf("engine saw chunked=%v bytes=%d", e.chunked, e.got)
	}
	if !strings.Contains(e.query, "model=bark3-live") || !strings.Contains(e.query, "sample_rate=16000") || !strings.Contains(e.query, "language=en") {
		t.Errorf("query not forwarded: %q", e.query)
	}
	if e.header.Get("X-Client") != "" || e.header.Get("X-Hub-No-Archive") != "" {
		t.Errorf("hub-only headers leaked to engine: %v", e.header)
	}
	e.mu.Unlock()

	var rec RequestRecord
	deadline := time.Now().Add(2 * time.Second)
	for {
		getJSON(t, url+"/api/metrics/requests/"+reqID, &rec)
		if !rec.InFlight || time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if rec.InFlight || rec.Status != 200 || !rec.Streamed || rec.Task != "asr" || rec.Instance != "bark3-live" ||
		rec.Client != "mic-test/1" || rec.Route != "/v1/audio/transcriptions/live" {
		t.Errorf("record identity wrong: %+v", rec)
	}
	if rec.TTFBMs == nil || rec.InputBytes != chunks*3200 || rec.InputAudioSec == nil || *rec.InputAudioSec != 0.5 {
		t.Errorf("record input/timing wrong: ttfb=%v bytes=%d sec=%v", rec.TTFBMs, rec.InputBytes, rec.InputAudioSec)
	}
	raw, _ := json.Marshal(rec)
	if strings.Contains(string(raw), "zebra") {
		t.Fatalf("request log must never hold transcript text: %s", raw)
	}
}

func TestLiveTranscriptionClientDisconnectReachesEngine(t *testing.T) {
	e := newLiveEngine()
	_, url := newLiveHub(t, e, "streaming", "READY")
	ctx, cancel := context.WithCancel(context.Background())
	pw, resp := startLive(t, ctx, url)
	defer resp.Body.Close()
	br := bufio.NewReader(resp.Body)
	pw.Write(make([]byte, 3200))
	readEvent(t, br)
	pw.Write(make([]byte, 1000)) // partial chunk, then the client vanishes
	cancel()
	select {
	case <-e.done:
	case <-time.After(5 * time.Second):
		t.Fatal("engine never noticed the client went away")
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.bodyErr == nil {
		t.Fatal("engine read a clean EOF; an aborted upload must not look like a finished one")
	}
}

func TestLiveTranscriptionErrors(t *testing.T) {
	post := func(url, path string) (int, string) {
		resp, err := http.Post(url+path, "application/octet-stream", strings.NewReader("pcm"))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	t.Run("offline instance", func(t *testing.T) {
		e := newLiveEngine()
		_, url := newLiveHub(t, e, "", "READY")
		code, body := post(url, liveQuery)
		if code != 400 || !strings.Contains(body, `\"mode\":\"streaming\"`) || !strings.Contains(body, "bark3-live") {
			t.Fatalf("got %d %s; want 400 naming the instance and how to fix it", code, body)
		}
	})
	t.Run("missing model", func(t *testing.T) {
		_, url := newLiveHub(t, newLiveEngine(), "streaming", "READY")
		if code, body := post(url, "/v1/audio/transcriptions/live?sample_rate=16000"); code != 400 || !strings.Contains(body, "model") {
			t.Fatalf("got %d %s", code, body)
		}
	})
	t.Run("unknown model", func(t *testing.T) {
		_, url := newLiveHub(t, newLiveEngine(), "streaming", "READY")
		if code, _ := post(url, "/v1/audio/transcriptions/live?model=nope"); code != 404 {
			t.Fatalf("got %d", code)
		}
	})
	t.Run("starting", func(t *testing.T) {
		_, url := newLiveHub(t, newLiveEngine(), "streaming", "STARTING")
		if code, _ := post(url, liveQuery); code != 409 {
			t.Fatalf("got %d", code)
		}
	})
	t.Run("engine rejection relayed", func(t *testing.T) {
		e := newLiveEngine()
		e.failFirst = true
		_, url := newLiveHub(t, e, "streaming", "READY")
		if code, body := post(url, liveQuery); code != 400 || !strings.Contains(body, "not configured for streaming") {
			t.Fatalf("got %d %s", code, body)
		}
	})
	t.Run("GET", func(t *testing.T) {
		_, url := newLiveHub(t, newLiveEngine(), "streaming", "READY")
		resp, err := http.Get(url + liveQuery)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 405 {
			t.Fatalf("got %d", resp.StatusCode)
		}
	})
}

func TestLiveInputAudioSeconds(t *testing.T) {
	for _, c := range []struct {
		q    string
		n    int64
		want float64
	}{
		{"model=x", 32000, 1},
		{"model=x&sample_rate=8000&channels=2&sample_format=f32le", 64000, 1},
		{"model=x&sample_format=mp3", 32000, -1},
		{"model=x&sample_rate=abc", 32000, -1},
	} {
		if got := livePCMBytesPerSec(mustQuery(t, c.q)); (c.want < 0 && got != 0) || (c.want > 0 && float64(c.n)/float64(got) != c.want) {
			t.Errorf("%s: bytes/sec %d", c.q, got)
		}
	}
}

func mustQuery(t *testing.T, q string) map[string][]string {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/v1/audio/transcriptions/live?"+q, nil)
	return r.URL.Query()
}
