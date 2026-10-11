package main

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestEventBusCloseIsSafe(t *testing.T) {
	b := NewEventBus()
	b.Close()
	b.Close()
	sub := b.Subscribe()
	b.Publish(eventTaskStarted, map[string]any{"taskId": "t"})
	if _, ok := <-sub.ch; ok {
		t.Fatal("subscribe after Close should return an already-closed channel")
	}
}

func TestEventStreamHelloAndTaskEvent(t *testing.T) {
	bus := NewEventBus()
	defer bus.Close()
	srv := httptest.NewServer((&Hub{bus: bus}).newHandler())
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/events/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Fatalf("content-type %q", ct)
	}

	rd := bufio.NewReader(resp.Body)
	hello := readSSE(t, rd, 3*time.Second)
	if hello.name != "hello" {
		t.Fatalf("first event = %#v", hello)
	}
	bus.Publish(eventTaskStarted, map[string]any{
		"taskId": "t1", "instanceId": "i1", "modelId": "m", "category": "other",
	})
	ev := readSSE(t, rd, 3*time.Second)
	if ev.name != eventTaskStarted || !strings.Contains(ev.data, `"taskId":"t1"`) {
		t.Fatalf("task event = %#v", ev)
	}
	cancel()
}

func TestEventStreamUnavailableWithoutBus(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Hub{}).newHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/events/stream", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("nil bus status %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "EVENTS_UNAVAILABLE") {
		t.Fatalf("body %s", rec.Body.String())
	}
}

type sseFrame struct {
	name string
	data string
}

func readSSE(t *testing.T, rd *bufio.Reader, d time.Duration) sseFrame {
	t.Helper()
	type result struct {
		frame sseFrame
		err   error
	}
	ch := make(chan result, 1)
	go func() {
		var name, data string
		for {
			line, err := rd.ReadString('\n')
			if err != nil {
				ch <- result{err: err}
				return
			}
			line = strings.TrimRight(line, "\r\n")
			if line == "" {
				if name != "" || data != "" {
					ch <- result{frame: sseFrame{name: name, data: data}}
					return
				}
				continue
			}
			if strings.HasPrefix(line, ":") {
				continue
			}
			if rest, ok := strings.CutPrefix(line, "event:"); ok {
				name = strings.TrimSpace(rest)
			} else if rest, ok := strings.CutPrefix(line, "data:"); ok {
				data = strings.TrimSpace(rest)
			}
		}
	}()
	select {
	case r := <-ch:
		if r.err != nil {
			t.Fatal(r.err)
		}
		return r.frame
	case <-time.After(d):
		t.Fatal("timed out waiting for an SSE frame")
		return sseFrame{}
	}
}
