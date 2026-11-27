package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSSEHTTPSubscribersBoundedAndSlotsReusable(t *testing.T) {
	bus := NewEventBus()
	subs := make([]*eventSubscriber, 0, maxSSESubscribers)
	for i := 0; i < maxSSESubscribers; i++ {
		sub := bus.SubscribeHTTP()
		if sub == nil {
			t.Fatalf("rejected HTTP subscriber %d before limit", i)
		}
		subs = append(subs, sub)
	}
	if extra := bus.SubscribeHTTP(); extra != nil {
		t.Fatal("accepted HTTP subscriber above limit")
	}
	bus.Unsubscribe(subs[0])
	bus.Unsubscribe(subs[0]) // idempotent release must not consume a second slot
	reused := bus.SubscribeHTTP()
	if reused == nil {
		t.Fatal("released subscriber slot could not be reused")
	}
	if extra := bus.SubscribeHTTP(); extra != nil {
		t.Fatal("duplicate unsubscribe allowed a subscriber above limit")
	}
	bus.Close()
	if bus.SubscribeHTTP() != nil {
		t.Fatal("admitted an HTTP subscriber after shutdown")
	}
}

func TestSSEHTTPAdmissionConcurrentLimit(t *testing.T) {
	bus := NewEventBus()
	defer bus.Close()
	const attempts = maxSSESubscribers * 3
	var wg sync.WaitGroup
	var mu sync.Mutex
	admitted := make([]*eventSubscriber, 0, maxSSESubscribers)
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if sub := bus.SubscribeHTTP(); sub != nil {
				mu.Lock()
				admitted = append(admitted, sub)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if len(admitted) != maxSSESubscribers {
		t.Fatalf("concurrent admission = %d, want %d", len(admitted), maxSSESubscribers)
	}
	for _, sub := range admitted {
		bus.Unsubscribe(sub)
	}
}

func TestSSEHTTPAtCapacityFallsBackTo503(t *testing.T) {
	bus := NewEventBus()
	defer bus.Close()
	for i := 0; i < maxSSESubscribers; i++ {
		if bus.SubscribeHTTP() == nil {
			t.Fatal("unable to fill SSE slots")
		}
	}
	rec := httptest.NewRecorder()
	(&Hub{bus: bus}).handleEventStream(rec, httptest.NewRequest(http.MethodGet, "/api/events/stream", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("at-capacity status = %d, want 503", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "EVENTS_BUSY") {
		t.Fatalf("at-capacity response did not identify fallback: %s", rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); strings.Contains(got, "text/event-stream") {
		t.Fatalf("rejected connection must not return SSE headers: %q", got)
	}
}

type sseDeadlineRecorder struct {
	*httptest.ResponseRecorder
	deadlines []time.Time
}

func (r *sseDeadlineRecorder) SetWriteDeadline(d time.Time) error {
	r.deadlines = append(r.deadlines, d)
	return nil
}

func TestSSEWriteDeadlineRenewedPerFrame(t *testing.T) {
	w := &sseDeadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
	rc := http.NewResponseController(w)
	before := time.Now()
	if err := writeSSEFrame(w, rc, []byte("event: hello\ndata: {}\n\n")); err != nil {
		t.Fatal(err)
	}
	if len(w.deadlines) != 1 || !w.deadlines[0].After(before) {
		t.Fatalf("first frame deadline not installed: %v", w.deadlines)
	}
	first := w.deadlines[0]
	time.Sleep(2 * time.Millisecond)
	if err := writeSSEFrame(w, rc, []byte(": ping\n\n")); err != nil {
		t.Fatal(err)
	}
	if len(w.deadlines) != 2 || !w.deadlines[1].After(first) {
		t.Fatalf("second frame did not renew deadline: %v", w.deadlines)
	}
	if !strings.Contains(w.Body.String(), "event: hello") || !strings.Contains(w.Body.String(), ": ping") {
		t.Fatalf("frames not flushed: %q", w.Body.String())
	}
}

func TestSSEUnsupportedWriteDeadlineFailsClosed(t *testing.T) {
	bus := NewEventBus()
	defer bus.Close()
	// ResponseRecorder supports flushing but not net.Conn write deadlines.
	// A wrapped production writer without Unwrap is equivalent: allowing an
	// HTTP 200 here would silently disable the SSE resource bound.
	w := httptest.NewRecorder()
	(&Hub{bus: bus}).handleEventStream(w, httptest.NewRequest(http.MethodGet, "/api/events/stream", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("unsupported deadline response=%d, want 503", w.Code)
	}
	if !strings.Contains(w.Body.String(), "EVENTS_DEADLINE_UNSUPPORTED") {
		t.Fatalf("unsupported deadline error missing: %q", w.Body.String())
	}
	if got := w.Header().Get("Content-Type"); strings.Contains(got, "text/event-stream") {
		t.Fatalf("unsupported writer incorrectly advertised SSE: %q", got)
	}
	if got := qa135Subscribers(bus); got != 0 {
		t.Fatalf("unsupported writer leaked %d subscriber slots", got)
	}
	if err := writeSSEFrame(w, http.NewResponseController(w), []byte(": test\\n\\n")); err == nil {
		t.Fatal("writeSSEFrame silently ignored unsupported deadlines")
	}
}

// A deadline failure other than ErrUnsupported must not silently return HTTP
// 200. Real connections may already be broken, so the response is best-effort.
type sseFailedDeadlineRecorder struct {
	*httptest.ResponseRecorder
}

func (r *sseFailedDeadlineRecorder) SetWriteDeadline(time.Time) error {
	return errors.New("synthetic deadline I/O failure -- do not echo to client")
}

func TestSSEDeadlinePreflightFailureReturns503AndReleasesSlot(t *testing.T) {
	bus := NewEventBus()
	defer bus.Close()
	w := &sseFailedDeadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
	(&Hub{bus: bus}).handleEventStream(w, httptest.NewRequest(http.MethodGet, "/api/events/stream", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("failed deadline response=%d, want 503", w.Code)
	}
	if !strings.Contains(w.Body.String(), "EVENTS_DEADLINE_FAILED") {
		t.Fatalf("missing fail-closed error code: %s", w.Body.String())
	}
	if strings.Contains(w.Body.String(), "synthetic deadline I/O failure") {
		t.Fatalf("internal transport error leaked to client")
	}
	if ct := w.Header().Get("Content-Type"); strings.Contains(ct, "text/event-stream") {
		t.Fatalf("failed preflight advertised an SSE stream: %s", ct)
	}
	if got := qa135Subscribers(bus); got != 0 {
		t.Fatalf("failed preflight leaked %d subscriber slots", got)
	}
	if next := bus.SubscribeHTTP(); next == nil {
		t.Fatal("failed preflight left SSE admission unavailable")
	} else {
		bus.Unsubscribe(next)
	}
}

// gatedSSEWriter is a deadline-capable ResponseWriter whose writes block while
// armed. It lets a test hold the SSE handler mid-frame and overflow the
// subscriber queue deterministically, rather than guessing at TCP buffer sizes.
type gatedSSEWriter struct {
	mu      sync.Mutex
	buf     strings.Builder
	armed   bool
	entered chan struct{} // buffered(1): signalled once a write reaches the gate
	release chan struct{} // closed to let blocked writes through
}

func newGatedSSEWriter() *gatedSSEWriter {
	return &gatedSSEWriter{entered: make(chan struct{}, 1), release: make(chan struct{})}
}

func (g *gatedSSEWriter) Header() http.Header              { return http.Header{} }
func (g *gatedSSEWriter) WriteHeader(int)                  {}
func (g *gatedSSEWriter) SetWriteDeadline(time.Time) error { return nil }
func (g *gatedSSEWriter) Flush()                           {}

func (g *gatedSSEWriter) Write(p []byte) (int, error) {
	g.mu.Lock()
	armed := g.armed
	g.mu.Unlock()
	if armed {
		select {
		case g.entered <- struct{}{}:
		default:
		}
		<-g.release
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.buf.Write(p)
}

func (g *gatedSSEWriter) snapshot() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.buf.String()
}

func (g *gatedSSEWriter) arm() {
	g.mu.Lock()
	g.armed = true
	g.mu.Unlock()
}

// A client whose queue overflowed must be told it missed events: otherwise the
// stream is indistinguishable from a quiet one and a lost task transition looks
// like a task that never changed state.
func TestSSEStreamGapFrameReportsMissedEvents(t *testing.T) {
	bus := NewEventBus()
	defer bus.Close()
	w := newGatedSSEWriter()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest(http.MethodGet, "/api/events/stream", nil).WithContext(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		(&Hub{bus: bus}).handleEventStream(w, req)
	}()

	qa135Eventually(t, func() bool { return strings.Contains(w.snapshot(), "event: hello") },
		"SSE hello frame was not written")
	w.arm()
	bus.Publish("first", map[string]int{"i": 0})
	select {
	case <-w.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("handler never blocked on a frame write")
	}

	// The handler is stuck in Write and the queue is empty, so the first
	// eventBusBuffer publishes fill it and the remainder are dropped.
	for i := 0; i < eventBusBuffer; i++ {
		bus.Publish("flood", map[string]int{"i": i})
	}
	const wantDropped = 3
	for i := 0; i < wantDropped; i++ {
		bus.Publish("flood", map[string]int{"i": eventBusBuffer + i})
	}
	if got := bus.Status().Drops; got != wantDropped {
		t.Fatalf("bus drops=%d, want %d (test did not overflow the queue)", got, wantDropped)
	}

	close(w.release)
	qa135Eventually(t, func() bool { return strings.Contains(w.snapshot(), "event: stream.gap") },
		"client was never told about the missed notifications")
	body := w.snapshot()
	if got := strings.Count(body, "event: stream.gap"); got != 1 {
		t.Fatalf("gap frames=%d, want exactly 1: %q", got, body)
	}
	if !strings.Contains(body, `"dropped":3`) {
		t.Fatalf("gap frame does not report the 3 missed events: %q", body)
	}
	// The gap must precede the next delivered event, not trail it: the client
	// has to know the sequence is discontinuous before it applies that event.
	gapAt := strings.Index(body, "event: stream.gap")
	if strings.Index(body, "event: first") > gapAt {
		t.Fatalf("gap frame reported before the frame it follows: %q", body)
	}
	if !strings.Contains(body[gapAt:], "event: flood") {
		t.Fatalf("gap frame was not followed by the next delivered event: %q", body[gapAt:])
	}

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not return after the client disconnected")
	}
}

// The same loss must be visible without a client attached: /api/metrics/summary
// is what an operator polls when the UI quietly stops updating.
func TestEventStreamDropsReportedInMetrics(t *testing.T) {
	bus := NewEventBus()
	defer bus.Close()
	sub := bus.SubscribeHTTP()
	defer bus.Unsubscribe(sub)
	for i := 0; i < eventBusBuffer; i++ {
		bus.Publish("flood", map[string]int{"i": i})
	}
	bus.Publish("flood", map[string]int{"i": eventBusBuffer}) // queue full -> dropped

	w := httptest.NewRecorder()
	(&Hub{bus: bus}).handleMetricsSummary(w, httptest.NewRequest(http.MethodGet, "/api/metrics/summary", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("metrics summary status=%d body=%q", w.Code, w.Body.String())
	}
	var body struct {
		Events EventStreamStatus `json:"events"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode metrics summary: %v", err)
	}
	if body.Events.Subscribers != 1 || body.Events.Capacity != maxSSESubscribers || body.Events.Drops != 1 {
		t.Fatalf("events metrics = %+v, want 1 subscriber, capacity %d, 1 drop", body.Events, maxSSESubscribers)
	}
}
