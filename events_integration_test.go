package main

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func qa135Subscribers(b *EventBus) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.subs)
}
func qa135Eventually(t *testing.T, f func() bool, reason string) {
	t.Helper()
	end := time.Now().Add(2 * time.Second)
	for time.Now().Before(end) {
		if f() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal(reason)
}
func TestEventStreamUnsubscribesOnDisconnect(t *testing.T) {
	bus := NewEventBus()
	defer bus.Close()
	srv := httptest.NewServer((&Hub{bus: bus}).newHandler())
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/api/events/stream", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	ev := readSSE(t, bufio.NewReader(resp.Body), time.Second)
	if ev.name != "hello" {
		t.Fatalf("hello=%q", ev.name)
	}
	qa135Eventually(t, func() bool { return qa135Subscribers(bus) == 1 }, "subscriber was not registered")
	cancel()
	resp.Body.Close()
	qa135Eventually(t, func() bool { return qa135Subscribers(bus) == 0 }, "disconnected subscriber remains in bus")
}
func TestEventStreamUnblocksOnBusClose(t *testing.T) {
	bus := NewEventBus()
	srv := httptest.NewServer((&Hub{bus: bus}).newHandler())
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/api/events/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	reader := bufio.NewReader(resp.Body)
	if e := readSSE(t, reader, time.Second); e.name != "hello" {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() { _, err := io.Copy(io.Discard, reader); done <- err }()
	bus.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("SSE remained blocked after bus.Close")
	}
	qa135Eventually(t, func() bool { return qa135Subscribers(bus) == 0 }, "bus not empty after Close")
}
func TestEventBusSlowSubscriberAndConcurrentDisconnect(t *testing.T) {
	b := NewEventBus()
	slow := b.Subscribe()
	fast := b.Subscribe()
	for i := 0; i < eventBusBuffer+20; i++ {
		b.Publish(eventTaskStarted, map[string]any{"taskId": "t"})
	}
	if b.drops <= 0 {
		t.Fatal("slow subscriber never dropped a full-buffer event")
	}
	if len(fast.ch) != eventBusBuffer {
		t.Fatalf("fast buffer got %d events", len(fast.ch))
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for j := 0; j < 150; j++ {
				sub := b.Subscribe()
				b.Publish(eventTaskStarted, map[string]any{"taskId": n})
				b.Unsubscribe(sub)
			}
		}(i)
	}
	wg.Wait()
	b.Unsubscribe(slow)
	b.Unsubscribe(fast)
	if got := qa135Subscribers(b); got != 0 {
		t.Fatalf("leaked %d subscribers", got)
	}
	b.Close()
}
func TestEventStreamActualTaskLifecycle(t *testing.T) {
	chdirTemp(t)
	bus := NewEventBus()
	defer bus.Close()
	tm := NewTaskManager(NewHistoryManager())
	tm.AddObserver(bus)
	sseSrv := httptest.NewServer((&Hub{bus: bus}).newHandler())
	defer sseSrv.Close()
	fakeEngine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{\"ok\":true}"))
	}))
	defer fakeEngine.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", sseSrv.URL+"/api/events/stream", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	reader := bufio.NewReader(resp.Body)
	if e := readSSE(t, reader, time.Second); e.name != "hello" {
		t.Fatalf("hello=%+v", e)
	}
	inst := &Instance{ID: "qa135", Name: "qa135", ModelID: "nonexistent_model", Port: portOf(t, fakeEngine.URL)}
	task := tm.Submit(inst, map[string]any{"text": "user secret text"}, []byte("{\"text\":\"user secret text\"}"))
	got := map[string]bool{}
	for i := 0; i < 3; i++ {
		e := readSSE(t, reader, 2*time.Second)
		got[e.name] = true
		if !containsTaskID(e.data, task.ID) {
			t.Fatalf("missing task id %s: %+v", task.ID, e)
		}
		if containsTaskID(e.data, "user secret text") {
			t.Fatal("SSE leaked task script text")
		}
	}
	for _, name := range []string{eventTaskQueued, eventTaskStarted, eventTaskFinished} {
		if !got[name] {
			t.Fatalf("missing actual TaskManager event %s: %+v", name, got)
		}
	}
}
func containsTaskID(data, part string) bool {
	for i := 0; i+len(part) <= len(data); i++ {
		if data[i:i+len(part)] == part {
			return true
		}
	}
	return false
}
func BenchmarkEventBusPublishFourSubscribers(b *testing.B) {
	bus := NewEventBus()
	defer bus.Close()
	for j := 0; j < 4; j++ {
		bus.Subscribe()
	}
	payload := map[string]any{"taskId": "t", "instanceId": "i", "status": "RUNNING"}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		bus.Publish(eventTaskStarted, payload)
	}
}

func BenchmarkMemorySamplerRecord(b *testing.B) {
	s := NewMemorySampler(nil, NewTaskManager(NewHistoryManager()), nil)
	now := time.Now()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		s.record("test-instance", now.Add(time.Duration(i)*time.Millisecond), 1024*1024, 0, false, "")
	}
}
