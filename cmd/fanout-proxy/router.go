package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// httpError is a non-2xx response from an upstream hub. Kept small so the
// failover log can name the hub without dumping a body.
type httpError struct {
	status int
	url    string
}

func (e *httpError) Error() string {
	return fmt.Sprintf("upstream %s returned %d", e.url, e.status)
}

// ---------------------------------------------------------------- model 字段

// decodeBody parses a JSON object body into raw per-field bytes. Using
// json.RawMessage keeps every untouched field (options, voice_ref, unknown
// OpenAI extras) byte-identical, so a rewrite can never reformat or round a
// caller value.
func decodeBody(body []byte) (map[string]json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return nil, err
	}
	if fields == nil {
		return nil, errors.New("body is not a JSON object")
	}
	return fields, nil
}

// extractModel reads the top-level "model" of a request body. The upstream hub
// routes /v1/* the same way (JSON only; multipart cannot be inspected).
func extractModel(fields map[string]json.RawMessage) (string, error) {
	raw, ok := fields["model"]
	if !ok {
		return "", errors.New(`request body has no "model" field`)
	}
	var name string
	if err := json.Unmarshal(raw, &name); err != nil {
		return "", errors.New(`"model" must be a string`)
	}
	if strings.TrimSpace(name) == "" {
		return "", errors.New(`"model" must not be empty`)
	}
	return name, nil
}

// rewriteModel returns body with the top-level "model" replaced by the upstream
// service name. Other fields keep their original bytes.
func rewriteModel(fields map[string]json.RawMessage, instanceName string) ([]byte, error) {
	encoded, err := json.Marshal(instanceName)
	if err != nil {
		return nil, err
	}
	out := make(map[string]json.RawMessage, len(fields))
	for k, v := range fields {
		out[k] = v
	}
	out["model"] = encoded
	return json.Marshal(out)
}

// ---------------------------------------------------------------- 目标选择

// candidate is one route target plus why it is (not) usable right now.
type candidate struct {
	target Target
	skip   string // empty means usable
}

// plan annotates every target of a route with the reason it is being skipped,
// using the poll cache. Targets in order are tried in order.
func planTargets(rt *Route, s *healthStore) []candidate {
	out := make([]candidate, 0, len(rt.Targets))
	for _, t := range rt.Targets {
		c := candidate{target: t}
		st, ok := s.hub(t.Hub)
		switch {
		case !ok:
			c.skip = "hub is not in config"
		case !st.ok:
			c.skip = "hub is down"
		case !st.ready(t.InstanceName):
			c.skip = "instance is not READY"
		}
		out = append(out, c)
	}
	return out
}

// pickTarget returns the first usable target of a route.
func pickTarget(rt *Route, s *healthStore) (Target, bool) {
	for _, c := range planTargets(rt, s) {
		if c.skip == "" {
			return c.target, true
		}
	}
	return Target{}, false
}

// ---------------------------------------------------------------- 并发上限

// retryAfterSeconds is the Retry-After hint on a 429. A slot frees as soon as
// an in-flight synthesis finishes, so seconds, not minutes.
const retryAfterSeconds = 5

// limiter caps how many speech forwards may be in flight per origin target
// (hub base URL + service name). Hub task queues are serial, so without a cap
// one noisy agent occupies a target's single engine slot and everyone else
// queues behind it invisibly. A target at its cap is treated like any other
// unusable target — the request spills to the standby — so only a route whose
// every usable target is busy answers 429 (docs/fanout-design.md follow-up 2).
//
// cap <= 0 means unlimited. All methods are nil-safe: a zero-value limiter
// degrades to "no cap" rather than panicking a LAN tool.
type limiter struct {
	mu   sync.Mutex
	cap  int
	used map[string]int // target key -> forwards in flight
}

func newLimiter(maxInFlight int) *limiter {
	return &limiter{cap: maxInFlight, used: make(map[string]int)}
}

// targetKey identifies one origin target for concurrency accounting.
func targetKey(t Target) string { return t.Hub + "/" + t.InstanceName }

// acquire reserves one slot for key. false means the target is at its cap and
// the caller must not send anything upstream.
func (l *limiter) acquire(key string) bool {
	if l == nil || l.cap <= 0 {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.used[key] >= l.cap {
		return false
	}
	l.used[key]++
	return true
}

// release gives a slot back. An extra or unmatched release is dropped instead
// of going negative, which would silently re-open the cap.
func (l *limiter) release(key string) {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if n := l.used[key] - 1; n > 0 {
		l.used[key] = n
	} else {
		delete(l.used, key)
	}
}

// inFlight is the current count for key, reported by GET /farm/health.
func (l *limiter) inFlight(key string) int {
	if l == nil {
		return 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.used[key]
}

// busyReason is the skip reason recorded when a target is at its cap.
func busyReason(cap int) string {
	return "at in-flight cap (" + strconv.Itoa(cap) + ")"
}

// ---------------------------------------------------------------- 转发

// forwardClient has no timeout on purpose: TTS generation is unbounded, and a
// client that walks away cancels through the request context instead.
var forwardClient = &http.Client{
	Transport: &http.Transport{
		MaxIdleConnsPerHost: 16,
		IdleConnTimeout:     90 * time.Second,
	},
}

var pollClientOnce sync.Once
var pollClientHTTP *http.Client

func pollClient() *http.Client {
	pollClientOnce.Do(func() { pollClientHTTP = &http.Client{} })
	return pollClientHTTP
}

// retryable reports whether a failed attempt may still succeed on the next
// target: transport errors, 5xx, and the hub's "instance not READY" 409 all
// mean "this backend is not serving right now". Client errors (400 etc.) do
// not — the same body would fail everywhere, so fail fast.
func retryable(status int) bool {
	return status == http.StatusConflict || status == http.StatusTooManyRequests || status >= 500
}

// attempt is one tried backend, reported back to the caller on total failure.
type attempt struct {
	Hub          string `json:"hub"`
	InstanceName string `json:"instanceName"`
	Reason       string `json:"reason"`
}

// speechResult is the outcome of a forwarded speech request.
type speechResult struct {
	// Streamed is set when upstream answered and the body was already relayed.
	Streamed bool
	Attempt  attempt
}

// relaySpeech forwards body to one hub and streams the response to w. The
// response is only written once upstream headers are known good, which is what
// makes failover possible at all.
func relaySpeech(w http.ResponseWriter, r *http.Request, target Target, body []byte) (speechResult, error) {
	url := target.Hub + "/v1/audio/speech"
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return speechResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.ContentLength = int64(len(body))
	// Client disconnects must abort the upstream generation, not leak it.
	resp, err := forwardClient.Do(req)
	if err != nil {
		return speechResult{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		io.Copy(io.Discard, resp.Body) // drain for keep-alive
		return speechResult{}, &httpError{status: resp.StatusCode, url: target.Hub + ": " + summarize(detail)}
	}

	h := w.Header()
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		h.Set("Content-Type", ct)
	}
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		h.Set("Content-Length", cl)
	}
	h.Set("X-Fanout-Hub", target.Hub)
	h.Set("X-Fanout-Instance", target.InstanceName)
	w.WriteHeader(resp.StatusCode)
	_, err = io.CopyBuffer(flushWriter{w: w}, resp.Body, make([]byte, 32<<10))
	return speechResult{Streamed: true}, err
}

// summarize trims an upstream error body down to a loggable one-liner.
func summarize(body []byte) string {
	s := strings.TrimSpace(string(body))
	if s == "" {
		return "empty body"
	}
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	return s
}

// flushWriter flushes after every chunk so streaming formats (SSE) and slow
// WAV responses reach the client as they arrive.
type flushWriter struct{ w http.ResponseWriter }

func (fw flushWriter) Write(p []byte) (int, error) {
	n, err := fw.w.Write(p)
	if n > 0 {
		if f, ok := fw.w.(http.Flusher); ok {
			f.Flush()
		}
	}
	return n, err
}
