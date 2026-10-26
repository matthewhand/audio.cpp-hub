package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"sync/atomic"
	"time"
)

// Live speech-to-text (#200): streaming-mode instances and a pass-through for the
// audio.cpp engine's POST /v1/audio/transcriptions/live. The client uploads raw PCM in
// a chunked body and reads transcript deltas as SSE while it is still talking, so the
// hub must neither buffer the request nor the response.

const (
	modeOffline   = "offline"
	modeStreaming = "streaming"
	liveRoute     = "/v1/audio/transcriptions/live"
)

// liveIngestKeys maps the hub's camelCase liveIngest keys to the engine's live_ingest keys.
var liveIngestKeys = map[string]string{
	"idleTimeoutMs":  "idle_timeout_ms",
	"totalTimeoutMs": "total_timeout_ms",
	"maxBodyBytes":   "max_body_bytes",
	"maxChunkBytes":  "max_chunk_bytes",
	"sendTimeoutMs":  "send_timeout_ms",
}

// instanceMode normalises an instance's mode: unset means offline.
func instanceMode(m string) string {
	if m == "" {
		return modeOffline
	}
	return m
}

// cardSupportsMode reports whether a models.json card lists mode in its "modes".
func cardSupportsMode(card map[string]any, mode string) bool {
	modes, _ := card["modes"].([]any)
	for _, m := range modes {
		if m == mode {
			return true
		}
	}
	return false
}

// parseInstanceMode validates the optional "mode" and "liveIngest" keys of a
// POST /api/instances body against the model card.
func parseInstanceMode(body, card map[string]any) (string, map[string]int64, error) {
	mode := modeOffline
	if v, ok := body["mode"]; ok && v != nil {
		s, _ := v.(string)
		if s != modeOffline && s != modeStreaming {
			e := newUserError("MODE_INVALID", `mode must be "offline" or "streaming"`)
			e.Params["mode"] = fmt.Sprint(v)
			return "", nil, e
		}
		mode = s
	}
	if mode == modeStreaming && !cardSupportsMode(card, modeStreaming) {
		e := newUserError("MODE_UNSUPPORTED", "this model does not support streaming mode")
		e.Params["modes"] = card["modes"]
		return "", nil, e
	}
	raw, ok := body["liveIngest"]
	if !ok || raw == nil {
		return mode, nil, nil
	}
	if mode != modeStreaming {
		return "", nil, newUserError("LIVE_INGEST_REQUIRES_STREAMING", `liveIngest only applies with "mode":"streaming"`)
	}
	obj, ok := raw.(map[string]any)
	if !ok {
		return "", nil, newUserError("LIVE_INGEST_INVALID", "liveIngest must be an object")
	}
	out := map[string]int64{}
	for k, v := range obj {
		if _, known := liveIngestKeys[k]; !known {
			e := newUserError("LIVE_INGEST_INVALID", "unknown liveIngest key: "+k)
			e.Params["key"] = k
			return "", nil, e
		}
		f, isNum := v.(float64)
		if !isNum || f < 0 || f != math.Trunc(f) || f > math.MaxInt64/2 {
			e := newUserError("LIVE_INGEST_INVALID", "liveIngest."+k+" must be a non-negative integer (0 disables the limit)")
			e.Params["key"] = k
			return "", nil, e
		}
		if k == "maxChunkBytes" && f == 0 {
			e := newUserError("LIVE_INGEST_INVALID", "liveIngest.maxChunkBytes must be positive")
			e.Params["key"] = k
			return "", nil, e
		}
		out[k] = int64(f)
	}
	return mode, out, nil
}

// livePCMBytesPerSec derives the upload's byte rate from the engine's query parameters
// (same defaults: 16 kHz, mono, s16le); 0 when the format is unknown.
func livePCMBytesPerSec(q url.Values) int {
	intOr := func(key string, def int) int {
		s := q.Get(key)
		if s == "" {
			return def
		}
		n, err := strconv.Atoi(s)
		if err != nil || n <= 0 {
			return 0
		}
		return n
	}
	var width int
	switch q.Get("sample_format") {
	case "", "s16le":
		width = 2
	case "f32le":
		width = 4
	default:
		return 0
	}
	return intOr("sample_rate", 16000) * intOr("channels", 1) * width
}

// liveUpstreamClient has no response-header or overall timeout: a live session lasts as
// long as the speaker talks and ends when the client stops or goes away (request context).
var liveUpstreamClient = &http.Client{
	Transport: &http.Transport{
		DialContext:         (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     90 * time.Second,
		DisableCompression:  true,
	},
}

// countingReader counts request bytes as they stream through.
type countingReader struct {
	r io.Reader
	n atomic.Int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n.Add(int64(n))
	return n, err
}

// handleV1Live proxies POST /v1/audio/transcriptions/live?model=<instance>&... to the
// instance unchanged: the request body streams upstream chunked as it arrives, every SSE
// line streams back with a flush, and a client disconnect cancels the upstream request.
// Nothing is buffered to disk and no audio or transcript text is kept.
func (h *Hub) handleV1Live(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		v1Error(w, http.StatusMethodNotAllowed, "Method not allowed: "+r.Method+" (live transcription is POST with a chunked PCM body)")
		return
	}
	rec := requestRecorderFrom(r.Context())
	model := r.URL.Query().Get("model")
	if model == "" {
		v1Error(w, http.StatusBadRequest, "Missing required query parameter: model")
		return
	}
	inst := h.instances.FindByName(model)
	if inst == nil {
		rec.SetRequestedModel(model)
		if h.instances.FindAnyByName(model) != nil {
			v1Error(w, http.StatusConflict, "Model is still starting: "+model)
		} else {
			v1Error(w, http.StatusNotFound, "Model not found: "+model)
		}
		return
	}
	rec.SetInstance(inst)
	if inst.ServerTask != "asr" && inst.ServerTask != "diar" {
		v1Error(w, http.StatusBadRequest, fmt.Sprintf("Instance %q serves task %q; live transcription needs an asr or diar instance", inst.Name, inst.ServerTask))
		return
	}
	if instanceMode(inst.Mode) != modeStreaming {
		v1Error(w, http.StatusBadRequest, fmt.Sprintf(
			`Instance %q runs in %s mode; live transcription needs an instance created with "mode":"streaming" (POST /api/instances)`,
			inst.Name, instanceMode(inst.Mode)))
		return
	}
	rec.markLiveStream()

	// Read the upload while writing the reply, and never time a long session out.
	rc := http.NewResponseController(w)
	_ = rc.EnableFullDuplex()
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})

	body := &countingReader{r: r.Body}
	defer func() { rec.MeasureLiveInput(body.n.Load(), livePCMBytesPerSec(r.URL.Query())) }()
	upstreamURL := fmt.Sprintf("http://127.0.0.1:%d%s", inst.Port, r.URL.RequestURI())
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, upstreamURL, body)
	if err != nil {
		v1Error(w, http.StatusInternalServerError, "Proxy internal error")
		return
	}
	req.ContentLength = -1 // unknown length: sent chunked, flushed per chunk
	copyNonHopHeaders(req.Header, r.Header)
	for _, k := range []string{noArchiveHeader, "Content-Length", "Expect", "Accept-Encoding"} {
		req.Header.Del(k)
	}
	if req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	resp, err := liveUpstreamClient.Do(req)
	if err != nil {
		if r.Context().Err() == nil {
			log.Printf("live transcription to instance #%s failed: %v", inst.ID, err)
			v1Error(w, http.StatusBadGateway, "Failed to reach model instance: "+summarize(err.Error()))
		}
		return
	}
	defer resp.Body.Close()

	copyNonHopHeaders(w.Header(), resp.Header)
	w.Header().Del("Content-Length")
	w.Header().Del("Cache-Control")
	w.Header().Set("X-Accel-Buffering", "no") // tell any reverse proxy in front not to buffer
	w.WriteHeader(resp.StatusCode)
	_ = rc.Flush()
	if resp.StatusCode >= 300 {
		io.Copy(w, resp.Body)
		return
	}
	relaySSE(w, rc, resp.Body, rec)
}

// relaySSE copies an SSE stream line by line with a flush after each line. Lines before
// the first data line (comments, event names) are held and sent with it, so the
// recorded time to first byte is the time to the first transcript event.
func relaySSE(w http.ResponseWriter, rc *http.ResponseController, src io.Reader, rec *reqState) {
	br := bufio.NewReaderSize(src, 16<<10)
	var held []byte
	sawData := false
	for {
		line, err := br.ReadSlice('\n')
		if err == bufio.ErrBufferFull {
			// Oversized line: pass it through in pieces without waiting for its end.
			if len(held) > 0 {
				w.Write(held)
				held = nil
			}
			sawData = true
			if _, werr := w.Write(line); werr != nil {
				return
			}
			continue
		}
		if len(line) > 0 {
			if bytes.HasPrefix(line, []byte("data:")) {
				noteLiveSSEError(line, rec)
				if !sawData {
					sawData = true
					line = append(held, line...)
					held = nil
				}
			} else if !sawData {
				held = append(held, line...)
				line = nil
			}
			if len(line) > 0 {
				if _, werr := w.Write(line); werr != nil {
					return
				}
				_ = rc.Flush()
			}
		}
		if err != nil {
			if len(held) > 0 {
				w.Write(held)
				_ = rc.Flush()
			}
			if err != io.EOF {
				rec.SetError("live stream interrupted: " + summarize(err.Error()))
			}
			return
		}
	}
}

// noteLiveSSEError records an engine "error" event's message (never transcript text).
func noteLiveSSEError(line []byte, rec *reqState) {
	payload := bytes.TrimSpace(bytes.TrimPrefix(line, []byte("data:")))
	if !bytes.Contains(payload, []byte(`"error"`)) {
		return
	}
	var ev struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	}
	if json.Unmarshal(payload, &ev) != nil || ev.Type != "error" {
		return
	}
	msg := ev.Message
	if msg == "" {
		msg = errorTextFromBody(payload)
	}
	rec.SetError(msg)
}

// markLiveStream flags the request as streamed before any reply header is written.
func (s *reqState) markLiveStream() {
	if s == nil {
		return
	}
	s.m.mu.Lock()
	s.streamRequested = true
	s.m.mu.Unlock()
}

// MeasureLiveInput records how much PCM a live upload carried (bytes and, when the
// format is known, seconds of audio). The audio itself is never kept.
func (s *reqState) MeasureLiveInput(n int64, bytesPerSec int) {
	if s == nil {
		return
	}
	s.m.mu.Lock()
	defer s.m.mu.Unlock()
	s.rec.InputBytes = n
	if bytesPerSec > 0 && n > 0 {
		sec := round3(float64(n) / float64(bytesPerSec))
		s.rec.InputAudioSec = &sec
	}
}
