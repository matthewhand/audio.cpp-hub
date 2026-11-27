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

// healthyMarkerViolation is the intended assertion shared by the positive case
// and the withheld-marker control. It reports why a post-saturation marker did
// not reach the healthy peer before the stalled peer's write deadline, using
// both measured clocks: from the saturation write (when the deadline was armed)
// and from the marker publish. nil means the healthy stream was not delayed.
func healthyMarkerViolation(saturatedAt, publishedAt, deliveredAt time.Time, name, data, marker string, deadline time.Duration) error {
	if name != eventTaskFinished || !strings.Contains(data, marker) {
		return fmt.Errorf("healthy peer marker frame=%q data=%q", name, data)
	}
	fromSaturation := deliveredAt.Sub(saturatedAt)
	fromPublish := deliveredAt.Sub(publishedAt)
	if fromSaturation >= deadline {
		return fmt.Errorf("marker reached the healthy peer %s after saturation (from publish %s), at/after the %s stalled write deadline",
			fromSaturation, fromPublish, deadline)
	}
	if fromPublish >= deadline {
		return fmt.Errorf("marker reached the healthy peer %s after publish, at/after the %s stalled write deadline",
			fromPublish, deadline)
	}
	return nil
}

// TestSSEHealthyPeerReceivesWhileStalledPeerBlocked is the two-peer companion
// to TestSSEFullHandlerStalledSocketReclaimsCapacity: one real HTTP SSE reader
// stops reading after hello, a second real HTTP SSE reader keeps draining, and
// an event published after the first peer's socket is saturated must reach the
// healthy reader before the stalled peer's per-frame write deadline. The
// stalled subscriber must then time out and give its admission slot back.
func TestSSEHealthyPeerReceivesWhileStalledPeerBlocked(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("small TCP socket buffer backpressure is Linux-specific")
	}

	bus := NewEventBus()
	defer bus.Close()
	srv := httptest.NewUnstartedServer((&Hub{bus: bus}).newHandler())
	srv.Listener = boundedWriteListener{Listener: srv.Listener}
	srv.Start()
	defer srv.Close()

	// Stalled peer: read the hello frame over real TCP, then never read again.
	stalled, err := net.DialTimeout("tcp", srv.Listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer stalled.Close()
	if err := stalled.(*net.TCPConn).SetReadBuffer(4096); err != nil {
		t.Fatal(err)
	}
	if err := stalled.SetReadDeadline(time.Now().Add(sseWriteTimeout + 8*time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := fmt.Fprint(stalled, "GET /api/events/stream HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	stalledResp, err := http.ReadResponse(bufio.NewReader(stalled), nil)
	if err != nil {
		t.Fatal(err)
	}
	if stalledResp.StatusCode != http.StatusOK {
		t.Fatalf("stalled peer status=%d, want 200", stalledResp.StatusCode)
	}
	if hello := readSSE(t, bufio.NewReader(stalledResp.Body), 2*time.Second); hello.name != "hello" {
		t.Fatalf("stalled peer first frame=%q, want hello", hello.name)
	}

	// Healthy peer: real HTTP stream whose frames are read throughout.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/events/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	healthy, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer healthy.Body.Close()
	if healthy.StatusCode != http.StatusOK {
		t.Fatalf("healthy peer status=%d, want 200", healthy.StatusCode)
	}
	healthyRd := bufio.NewReader(healthy.Body)
	if hello := readSSE(t, healthyRd, 2*time.Second); hello.name != "hello" {
		t.Fatalf("healthy peer first frame=%q, want hello", hello.name)
	}

	// Barrier: both subscriptions are registered before anything is published.
	qa135Eventually(t, func() bool { return qa135Subscribers(bus) == 2 },
		"both SSE subscriptions were not registered before publish")

	// Saturate the stalled socket with one ~1 MiB frame. The healthy peer is
	// the only reader that will drain it. The stalled handler arms its per-frame
	// write deadline when it starts this write, so all later timings are taken
	// from here.
	saturated := time.Now()
	bus.Publish(eventTaskStarted, map[string]string{"synthetic": strings.Repeat("x", 1<<20)})
	time.Sleep(250 * time.Millisecond)
	if got := qa135Subscribers(bus); got != 2 {
		t.Fatalf("stalled handler left early after %s (slots=%d); socket was not blocked", time.Since(saturated), got)
	}
	if frame := readSSE(t, healthyRd, 3*time.Second); !strings.Contains(frame.data, "synthetic") {
		t.Fatalf("healthy peer saturation frame=%q", frame.name)
	}

	// Post-saturation marker: published while the stalled peer is still blocked
	// inside its write.
	const marker = "healthy-after-stalled-saturation"
	published := time.Now()
	bus.Publish(eventTaskFinished, map[string]string{"marker": marker})
	frame := readSSE(t, healthyRd, 2*time.Second)
	deliveredAt := time.Now()
	if err := healthyMarkerViolation(saturated, published, deliveredAt, frame.name, frame.data, marker, sseWriteTimeout); err != nil {
		t.Fatal(err)
	}
	fromSaturation := deliveredAt.Sub(saturated)
	fromPublish := deliveredAt.Sub(published)
	if fromPublish > 2*time.Second {
		t.Fatalf("healthy peer marker delivery took %s after publish; a stalled peer delayed the healthy stream", fromPublish)
	}
	t.Logf("healthy peer received the post-saturation marker %s after saturation (%s after publish); stalled write deadline is %s from saturation",
		fromSaturation, fromPublish, sseWriteTimeout)

	// The stalled peer must now time out and release its admitted slot.
	limit := time.NewTimer(sseWriteTimeout + 5*time.Second)
	defer limit.Stop()
	poll := time.NewTicker(20 * time.Millisecond)
	defer poll.Stop()
	var reclaimed time.Duration
	for {
		select {
		case <-poll.C:
			switch got := qa135Subscribers(bus); got {
			case 1:
				reclaimed = time.Since(saturated)
				goto reclaimedSlot
			case 2:
			default:
				t.Fatalf("unexpected subscriber count while waiting for reclaim: %d", got)
			}
		case <-limit.C:
			t.Fatal("stalled peer did not release its SSE slot by write deadline + 5s")
		}
	}

reclaimedSlot:
	if reclaimed < sseWriteTimeout-300*time.Millisecond || reclaimed > sseWriteTimeout+4*time.Second {
		t.Fatalf("stalled slot reclaimed in %s, not near %s write deadline", reclaimed, sseWriteTimeout)
	}
	t.Logf("stalled slot reclaimed after %s; healthy peer still subscribed", reclaimed)

	cancel()
	healthy.Body.Close()
	qa135Eventually(t, func() bool { return qa135Subscribers(bus) == 0 },
		"healthy subscriber slot was not released on disconnect")
}

// TestSSEControlWithheldHealthyMarkerFailsDeadline is the deterministic
// negative control for the assertion above. It runs the same two-peer setup but
// withholds the marker until after the stalled peer's write deadline: the
// marker is published only once the stalled slot has already been reclaimed.
// The marker still reaches the draining healthy peer, so this is a real
// late-delivery observation, not an injected error. The intended assertion must
// reject it, and notably only the saturation-relative check can: measured from
// publish the marker arrives in microseconds, which is why that check alone
// would have passed the control.
func TestSSEControlWithheldHealthyMarkerFailsDeadline(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("small TCP socket buffer backpressure is Linux-specific")
	}

	bus := NewEventBus()
	defer bus.Close()
	srv := httptest.NewUnstartedServer((&Hub{bus: bus}).newHandler())
	srv.Listener = boundedWriteListener{Listener: srv.Listener}
	srv.Start()
	defer srv.Close()

	stalled, err := net.DialTimeout("tcp", srv.Listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer stalled.Close()
	if err := stalled.(*net.TCPConn).SetReadBuffer(4096); err != nil {
		t.Fatal(err)
	}
	if err := stalled.SetReadDeadline(time.Now().Add(sseWriteTimeout + 8*time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := fmt.Fprint(stalled, "GET /api/events/stream HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	stalledResp, err := http.ReadResponse(bufio.NewReader(stalled), nil)
	if err != nil {
		t.Fatal(err)
	}
	if stalledResp.StatusCode != http.StatusOK {
		t.Fatalf("stalled peer status=%d, want 200", stalledResp.StatusCode)
	}
	if hello := readSSE(t, bufio.NewReader(stalledResp.Body), 2*time.Second); hello.name != "hello" {
		t.Fatalf("stalled peer first frame=%q, want hello", hello.name)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/events/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	healthy, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer healthy.Body.Close()
	if healthy.StatusCode != http.StatusOK {
		t.Fatalf("healthy peer status=%d, want 200", healthy.StatusCode)
	}
	healthyRd := bufio.NewReader(healthy.Body)
	if hello := readSSE(t, healthyRd, 2*time.Second); hello.name != "hello" {
		t.Fatalf("healthy peer first frame=%q, want hello", hello.name)
	}
	qa135Eventually(t, func() bool { return qa135Subscribers(bus) == 2 },
		"both SSE subscriptions were not registered before publish")

	saturated := time.Now()
	bus.Publish(eventTaskStarted, map[string]string{"synthetic": strings.Repeat("x", 1<<20)})
	time.Sleep(250 * time.Millisecond)
	if got := qa135Subscribers(bus); got != 2 {
		t.Fatalf("stalled handler left early after %s (slots=%d); socket was not blocked", time.Since(saturated), got)
	}
	if frame := readSSE(t, healthyRd, 3*time.Second); !strings.Contains(frame.data, "synthetic") {
		t.Fatalf("healthy peer saturation frame=%q", frame.name)
	}

	// Withhold the healthy marker until the stalled write deadline has passed
	// and the stalled slot has been reclaimed.
	limit := time.NewTimer(sseWriteTimeout + 5*time.Second)
	defer limit.Stop()
	poll := time.NewTicker(20 * time.Millisecond)
	defer poll.Stop()
	reclaimed := false
	for !reclaimed {
		select {
		case <-poll.C:
			switch got := qa135Subscribers(bus); got {
			case 1:
				reclaimed = true
			case 2:
			default:
				t.Fatalf("unexpected subscriber count while withholding: %d", got)
			}
		case <-limit.C:
			t.Fatal("stalled peer did not release its SSE slot before the control could publish")
		}
	}

	const marker = "withheld-until-after-stalled-deadline"
	published := time.Now()
	bus.Publish(eventTaskFinished, map[string]string{"marker": marker})
	frame := readSSE(t, healthyRd, 2*time.Second)
	deliveredAt := time.Now()
	err = healthyMarkerViolation(saturated, published, deliveredAt, frame.name, frame.data, marker, sseWriteTimeout)
	if err == nil {
		t.Fatalf("withheld marker was accepted: delivered %s after saturation and %s after publish; the assertion did not fail",
			deliveredAt.Sub(saturated), deliveredAt.Sub(published))
	}
	t.Logf("negative control: intended assertion rejected the withheld marker: %v", err)
	t.Logf("negative control clocks: %s after saturation, %s after publish; %s couldn't catch this because it measures from publish",
		deliveredAt.Sub(saturated), deliveredAt.Sub(published), "publish-relative timing")

	cancel()
	healthy.Body.Close()
	qa135Eventually(t, func() bool { return qa135Subscribers(bus) == 0 },
		"healthy subscriber slot was not released on disconnect")
}
