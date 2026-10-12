package main

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Reserve all but one slot internally, then exercise the final slot over a
// real loopback HTTP connection. This catches admission/cleanup regressions
// that an httptest.ResponseRecorder-only saturation test cannot detect.
func TestSSEHTTPNetworkCapacityAndDisconnectReclaim(t *testing.T) {
	bus := NewEventBus()
	for i := 0; i < maxSSESubscribers-1; i++ {
		if bus.SubscribeHTTP() == nil {
			t.Fatalf("premature admission refusal at %d", i)
		}
	}
	server := httptest.NewServer((&Hub{bus: bus}).newHandler())
	defer server.Close()
	defer bus.Close() // stop active handlers before server.Close

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/api/events/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	live, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer live.Body.Close()
	if live.StatusCode != http.StatusOK {
		t.Fatalf("first real HTTP stream status=%d", live.StatusCode)
	}
	if got := live.Header.Get("Content-Type"); !strings.Contains(got, "text/event-stream") {
		t.Fatalf("stream content-type=%q", got)
	}
	if ev := readSSE(t, bufio.NewReader(live.Body), time.Second); ev.name != "hello" {
		t.Fatalf("SSE handshake=%q, want hello", ev.name)
	}
	if got := qa135Subscribers(bus); got != maxSSESubscribers {
		t.Fatalf("network stream did not occupy final slot: %d", got)
	}
	client := &http.Client{Timeout: time.Second}
	denied, err := client.Get(server.URL + "/api/events/stream")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(io.LimitReader(denied.Body, 1024))
	denied.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if denied.StatusCode != http.StatusServiceUnavailable || !strings.Contains(string(body), "EVENTS_BUSY") {
		t.Fatalf("saturated real HTTP response: code=%d body=%q", denied.StatusCode, body)
	}
	cancel()
	live.Body.Close()
	qa135Eventually(t, func() bool { return qa135Subscribers(bus) == maxSSESubscribers-1 },
		"disconnect did not reclaim SSE subscriber slot")

	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	req2, err := http.NewRequestWithContext(ctx2, http.MethodGet, server.URL+"/api/events/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	defer recovered.Body.Close()
	if recovered.StatusCode != http.StatusOK {
		t.Fatalf("new stream after reclaim=%d, want 200", recovered.StatusCode)
	}
	if ev := readSSE(t, bufio.NewReader(recovered.Body), time.Second); ev.name != "hello" {
		t.Fatalf("recovered stream handshake=%q", ev.name)
	}
	cancel2()
	recovered.Body.Close()
	qa135Eventually(t, func() bool { return qa135Subscribers(bus) == maxSSESubscribers-1 },
		"recovered network stream did not release slot")
}
