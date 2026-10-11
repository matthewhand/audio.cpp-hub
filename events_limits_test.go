package main

import (
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
