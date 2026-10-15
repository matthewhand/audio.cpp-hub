package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Exercise Hub.handleEventStream, not only its frame-writing helper. A real
// local TCP client reads hello and then stops reading; the resulting stalled
// task event must time out and release the final HTTP subscriber slot.
func TestSSEFullHandlerStalledSocketReclaimsCapacity(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("small TCP socket buffer backpressure is Linux-specific")
	}

	bus := NewEventBus()
	defer bus.Close()
	// Reserve all but one slot. Re-admission proves the actual HTTP handler
	// released its subscriber, rather than merely tolerating another client.
	for i := 0; i < maxSSESubscribers-1; i++ {
		if bus.SubscribeHTTP() == nil {
			t.Fatalf("failed to reserve HTTP slot %d", i)
		}
	}
	srv := httptest.NewUnstartedServer((&Hub{bus: bus}).newHandler())
	srv.Listener = boundedWriteListener{Listener: srv.Listener}
	srv.Start()
	defer srv.Close()

	raw, err := net.DialTimeout("tcp", srv.Listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close() // the test never closes this peer before the timeout
	if err := raw.(*net.TCPConn).SetReadBuffer(4096); err != nil {
		t.Fatal(err)
	}
	// This read deadline is a local safety net, not a way to terminate
	// the server's blocked write (the client does not read after hello).
	if err := raw.SetReadDeadline(time.Now().Add(18 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := fmt.Fprint(raw, "GET /api/events/stream HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(raw), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("first real handler response status=%d, want 200", resp.StatusCode)
	}
	if hello := readSSE(t, bufio.NewReader(resp.Body), 2*time.Second); hello.name != "hello" {
		t.Fatalf("first frame=%q, want hello", hello.name)
	}
	if got := qa135Subscribers(bus); got != maxSSESubscribers {
		t.Fatalf("expected full HTTP subscriber capacity after hello, got %d", got)
	}

	// Saturation is real at the HTTP layer, not just an internal counter.
	check := &http.Client{Timeout: 2 * time.Second}
	denied, err := check.Get(srv.URL + "/api/events/stream")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(denied.Body, 512))
	denied.Body.Close()
	if denied.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 at full SSE capacity, got %d", denied.StatusCode)
	}

	// Exactly one bounded synthetic event (~1 MiB) must saturate the socket.
	// The TCP peer remains connected and completely nonreading throughout.
	before := time.Now()
	bus.Publish(eventTaskStarted, map[string]string{"synthetic": strings.Repeat("x", 1<<20)})
	time.Sleep(250 * time.Millisecond)
	if got := qa135Subscribers(bus); got != maxSSESubscribers {
		t.Fatalf("handler left early after %s (slots=%d); test did not prove a blocked deadline", time.Since(before), got)
	}

	// Poll only the subscription count. Do NOT close the TCP peer, cancel a
	// request, close the bus or forcibly unblock the writer before this point.
	limit := time.NewTimer(sseWriteTimeout + 5*time.Second)
	defer limit.Stop()
	poll := time.NewTicker(20 * time.Millisecond)
	defer poll.Stop()
	var elapsed time.Duration
	for {
		select {
		case <-poll.C:
			if got := qa135Subscribers(bus); got == maxSSESubscribers-1 {
				elapsed = time.Since(before)
				goto reclaimed
			} else if got != maxSSESubscribers {
				t.Fatalf("unexpected subscriber count while blocked: %d", got)
			}
		case <-limit.C:
			t.Fatal("full SSE handler did not reclaim its subscriber by write deadline + 5s")
		}
	}

reclaimed:
	if elapsed < sseWriteTimeout-300*time.Millisecond || elapsed > sseWriteTimeout+4*time.Second {
		t.Fatalf("slot reclaimed in %s, not near %s write deadline", elapsed, sseWriteTimeout)
	}
	// A fresh real HTTP SSE request must be able to occupy the reclaimed slot.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	nextReq, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/events/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	next, err := http.DefaultClient.Do(nextReq)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Body.Close()
	if next.StatusCode != http.StatusOK {
		t.Fatalf("replacement SSE connection status=%d after reclaim, want 200", next.StatusCode)
	}
	if hello := readSSE(t, bufio.NewReader(next.Body), time.Second); hello.name != "hello" {
		t.Fatalf("replacement frame=%q, want hello", hello.name)
	}
	cancel()
	next.Body.Close()
	qa135Eventually(t, func() bool { return qa135Subscribers(bus) == maxSSESubscribers-1 },
		"replacement HTTP SSE subscription was not cleaned up")
	t.Logf("full handler timed out and reclaimed final SSE slot in %s; replacement real HTTP SSE hello succeeded", elapsed)
}
