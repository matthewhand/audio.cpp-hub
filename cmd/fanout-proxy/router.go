package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// httpError is a non-2xx response from an upstream hub. Kept small so the
// failover log can name the hub without dumping a body; detail carries the
// trimmed upstream body, which is what a caller needs when the request (not the
// backend) was the problem.
type httpError struct {
	status int
	url    string
	detail string
}

func (e *httpError) Error() string {
	return fmt.Sprintf("upstream %s returned %d", e.url, e.status)
}

// upstreamMessage digs the engine's own message out of an OpenAI-shaped error
// body, falling back to the trimmed body when it is not one.
func (e *httpError) upstreamMessage() string {
	var env struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(e.detail), &env) == nil && strings.TrimSpace(env.Error.Message) != "" {
		return strings.TrimSpace(env.Error.Message)
	}
	return e.detail
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

// rawString reads a top-level string field; ok is false when it is missing or
// not a string.
func rawString(fields map[string]json.RawMessage, key string) (string, bool) {
	raw, ok := fields[key]
	if !ok {
		return "", false
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return "", false
	}
	return s, true
}

// rawBool reads a top-level bool field; JSON "true"/true are both accepted (the
// hub accepts both, so the proxy must not disagree).
func rawBool(fields map[string]json.RawMessage, key string) (bool, bool) {
	raw, ok := fields[key]
	if !ok {
		return false, false
	}
	var b bool
	if json.Unmarshal(raw, &b) == nil {
		return b, true
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s == "true", true
	}
	return false, false
}

// rewriteField returns body with one top-level field replaced. Every other field
// keeps its original bytes, so options, voice_ref and unknown extras survive.
func rewriteField(fields map[string]json.RawMessage, key, value string) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	out := make(map[string]json.RawMessage, len(fields))
	for k, v := range fields {
		out[k] = v
	}
	out[key] = encoded
	return json.Marshal(out)
}

// rewriteModel returns body with the top-level "model" replaced by the upstream
// service name. Other fields keep their original bytes.
func rewriteModel(fields map[string]json.RawMessage, instanceName string) ([]byte, error) {
	return rewriteField(fields, "model", instanceName)
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

// pickTarget returns the first usable target of a route in config order. It is
// the poll-cache view used by GET /v1/models and /farm/health: for a
// round_robin route that is only "one usable target", not the next request's
// choice.
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

// ---------------------------------------------------------------- 转发循环

// readJSONBody reads the request body under the shared ceiling and decodes it as
// a JSON object, writing the 413 / 400 itself.
func (p *proxy) readJSONBody(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, bool) {
	body, err := io.ReadAll(io.LimitReader(r.Body, p.cfg.MaxBodyBytes+1))
	if err != nil {
		openAIError(w, http.StatusBadRequest, "Cannot read request body", nil)
		return nil, false
	}
	if int64(len(body)) > p.cfg.MaxBodyBytes {
		openAIError(w, http.StatusRequestEntityTooLarge, "Request body too large", nil)
		return nil, false
	}
	fields, err := decodeBody(body)
	if err != nil {
		openAIError(w, http.StatusBadRequest, `Body must be a JSON object with a "model" field`, nil)
		return nil, false
	}
	return fields, true
}

// routeByModel resolves the body's "model" alias to its route, writing the 400 /
// 404 itself. The alias is echoed back because errors and logs should name what
// the caller asked for.
func (p *proxy) routeByModel(w http.ResponseWriter, fields map[string]json.RawMessage) (*Route, string, bool) {
	alias, err := extractModel(fields)
	if err != nil {
		openAIError(w, http.StatusBadRequest, err.Error(), map[string]any{"known_models": p.cfg.aliases()})
		return nil, "", false
	}
	rt, ok := p.cfg.routeFor(alias)
	if !ok {
		openAIError(w, http.StatusNotFound, "No fan-out route for model "+alias,
			map[string]any{"known_models": p.cfg.aliases()})
		return nil, "", false
	}
	return rt, alias, true
}

// tryTarget is one attempt against one usable target: build the upstream body
// and forward it. Returning an error means "this target did not work, try the
// next"; once it has written to w it must report Streamed.
type tryTarget func(w http.ResponseWriter, r *http.Request, target Target) (forwardResult, error)

// forwardWithFailover walks the route's targets in order (round-robin picks the
// first one, failover uses config order) until one answers.
// It owns the failover story shared by every forwarded endpoint: skip reasons,
// the per-origin in-flight cap (a busy target spills to the standby), the
// non-retryable 4xx short-circuit, and the terminal 429 / 503. Once any response
// byte has reached the client there is nothing to retry, so every retryable
// outcome has to surface before that.
func (p *proxy) forwardWithFailover(w http.ResponseWriter, r *http.Request, alias string, rt *Route, tryOne tryTarget) {
	attempts := []attempt{}
	busy := 0  // targets skipped only because they sit at their in-flight cap
	tried := 0 // targets that were actually contacted (or failed while being prepared)
	lastErr := ""
	// A failover route keeps config order; a round_robin route picks by weight
	// and leaves the other usable targets behind it as its own failover list.
	for _, c := range p.bal.order(rt, planTargets(rt, p.hub)) {
		if c.skip != "" {
			attempts = append(attempts, attempt{Hub: c.target.Hub, InstanceName: c.target.InstanceName, Reason: c.skip})
			continue
		}
		// One slot per in-flight forward on this origin instance, so a noisy
		// client cannot pin an engine while the farm looks healthy.
		key := targetKey(c.target)
		if !p.lim.acquire(key) {
			attempts = append(attempts, attempt{Hub: c.target.Hub, InstanceName: c.target.InstanceName, Reason: busyReason(p.cfg.MaxInFlightPerTarget)})
			busy++
			continue
		}
		tried++
		res, err := func() (forwardResult, error) {
			defer p.lim.release(key)
			return tryOne(w, r, c.target)
		}()
		switch {
		case err != nil && res.Streamed:
			// Upstream was already streaming; the client is mid-download, so
			// there is nothing left to fail over to.
			p.counts.recordFailed(c.target)
			log.Printf("fanout: client stream from %s/%s broke: %v", c.target.Hub, c.target.InstanceName, err)
			return
		case err != nil:
			p.counts.recordFailed(c.target)
			reason := err.Error()
			lastErr = reason
			var he *httpError
			if errors.As(err, &he) {
				// A phoneme ceiling is a property of the input, not of this backend:
				// every other target would refuse it identically, and answering 503
				// would blame the farm for a request it must fix.
				if inputLimitDetail(he.detail) {
					attempts = append(attempts, attempt{Hub: c.target.Hub, InstanceName: c.target.InstanceName, Reason: reason})
					openAIError(w, http.StatusBadRequest, he.upstreamMessage(), map[string]any{
						"attempts": attempts,
						"hint":     inputLimitHint(rt),
					})
					return
				}
				if !retryable(he.status) {
					attempts = append(attempts, attempt{Hub: c.target.Hub, InstanceName: c.target.InstanceName, Reason: reason})
					openAIError(w, he.status, "Upstream rejected the request: "+reason, map[string]any{"attempts": attempts})
					return
				}
			}
			attempts = append(attempts, attempt{Hub: c.target.Hub, InstanceName: c.target.InstanceName, Reason: reason})
		default:
			p.counts.recordServed(c.target)
			log.Printf("fanout: %s -> %s/%s", alias, c.target.Hub, c.target.InstanceName)
			return
		}
	}

	// Every usable target was busy: this is load shedding, not an outage, so
	// say 429 with a Retry-After instead of a misleading 503.
	if busy > 0 && busy == len(attempts) {
		w.Header().Set("Retry-After", strconv.Itoa(retryAfterSeconds))
		openAIError(w, http.StatusTooManyRequests,
			"All fan-out backends for model "+alias+" are at their in-flight cap",
			map[string]any{"attempts": attempts, "hubs_tried": hubList(attempts), "inFlightCap": p.cfg.MaxInFlightPerTarget})
		return
	}

	// A target answered and failed: the farm is up and the request is the
	// problem, so 502 (bad gateway) with the trail. 503 is reserved for "there
	// was nothing to try", which is what an agent should retry or escalate on.
	if tried > 0 {
		openAIError(w, http.StatusBadGateway,
			"Fan-out backend failed for model "+alias,
			map[string]any{"attempts": attempts, "hubs_tried": hubList(attempts), "lastError": lastErr})
		return
	}

	openAIError(w, http.StatusServiceUnavailable,
		"No fan-out backend available for model "+alias,
		map[string]any{"attempts": attempts, "hubs_tried": hubList(attempts), "inFlightCap": p.cfg.MaxInFlightPerTarget})
}

// inputLimitMarkers are engine error texts that mean "no backend can synthesise
// this text", not "this backend is unhealthy". They come from the engine, so
// the list stays short and specific; a match short-circuits the failover walk and
// answers 400 with the engine's own message.
var inputLimitMarkers = []string{
	"phoneme sequence has",              // sanoTTS token ceiling (207 incl. BOS/EOS)
	"trained for at most",               // the same ceiling, other phrasing
	"phonemization produced no symbols", // sanoTTS phonemizer gave up (long text)
	"input text is too long",
}

// inputLimitDetail reports whether an upstream error body says the input itself
// is unsupported.
func inputLimitDetail(detail string) bool {
	for _, m := range inputLimitMarkers {
		if strings.Contains(detail, m) {
			return true
		}
	}
	return false
}

// inputLimitHint tells the caller what to do about it, naming the route's chunk
// budget when it has one.
func inputLimitHint(rt *Route) string {
	if rt != nil && rt.MaxInputChars > 0 {
		return "Shorten the input or send it in pieces: this route splits speech input at " +
			strconv.Itoa(rt.MaxInputChars) + " characters by sentence, so a single unbroken run of digits or symbols can still exceed the engine's phoneme ceiling"
	}
	return "Shorten the input: the model cannot synthesise this text, and no other fan-out target can either"
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

// forwardResult is the outcome of one forward at one target.
type forwardResult struct {
	// Streamed is set when upstream answered and the body was already relayed,
	// i.e. there is nothing left to fail over to.
	Streamed bool
}

// relayUpstream POSTs body to one hub at path and streams the response to w. The
// response is only written once upstream headers are known good, which is what
// makes failover possible at all.
func relayUpstream(w http.ResponseWriter, r *http.Request, target Target, path string, body []byte) (forwardResult, error) {
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, target.Hub+path, bytes.NewReader(body))
	if err != nil {
		return forwardResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.ContentLength = int64(len(body))
	// Client disconnects must abort the upstream generation, not leak it.
	resp, err := forwardClient.Do(req)
	if err != nil {
		return forwardResult{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		io.Copy(io.Discard, resp.Body) // drain for keep-alive
		return forwardResult{}, &httpError{status: resp.StatusCode, url: target.Hub + ": " + summarize(detail), detail: summarize(detail)}
	}

	h := w.Header()
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		h.Set("Content-Type", ct)
	}
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		h.Set("Content-Length", cl)
	}
	copyFanoutHeaders(h, resp.Header)
	h.Set("X-Fanout-Hub", target.Hub)
	if target.InstanceName != "" {
		h.Set("X-Fanout-Instance", target.InstanceName)
	}
	w.WriteHeader(resp.StatusCode)
	_, err = io.CopyBuffer(flushWriter{w: w}, resp.Body, make([]byte, 32<<10))
	return forwardResult{Streamed: true}, err
}

// fanoutHeaderPrefixes are the upstream headers worth repeating at :18082:
// the engine's timing (X-Audiocpp-*), the hub request id and stream mode
// (X-Hub-*) and the PCM framing hints (X-Audio-*). Without them a caller of the
// fan-out cannot see how long an engine took or correlate a take with the hub
// request log. Everything else upstream sets is hop-by-hop, a security header
// this proxy already applies itself, or CORS.
var fanoutHeaderPrefixes = []string{"X-Audiocpp-", "X-Hub-", "X-Audio-"}

// exposedHeaders lists what a browser may read from a fan-out response. CORS
// only exposes safelisted headers by default, so the hub's own
// Access-Control-Expose-Headers (which names the same values) is not enough
// once the response comes through here.
const exposedHeaders = "X-Fanout-Hub, X-Fanout-Instance, X-Fanout-Chunks, X-Fanout-Wall-Ms, " +
	"X-Audiocpp-Wall-Ms, X-Audiocpp-Audio-Duration-Ms, X-Audiocpp-Rtf, X-Hub-Request-Id, X-Hub-Stream"

// copyFanoutHeaders copies the passthrough prefixes and re-states the CORS
// expose list. It never copies Content-Type or Content-Length: the caller sets
// those itself.
func copyFanoutHeaders(dst, src http.Header) {
	for k, vs := range src {
		// The prefixes are all X-* application headers, so none of them can be
		// hop-by-hop (Connection, Transfer-Encoding, ...) and no further guard is
		// needed here.
		if !hasFanoutPrefix(k) {
			continue
		}
		for _, v := range vs {
			dst.Add(k, v)
		}
	}
	dst.Set("Access-Control-Expose-Headers", exposedHeaders)
}

func hasFanoutPrefix(name string) bool {
	for _, p := range fanoutHeaderPrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
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
