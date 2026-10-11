package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

type qa121OrderedObserver struct {
	entered chan struct{}
	release chan struct{}
	mu      sync.Mutex
	names   []string
}

func (o *qa121OrderedObserver) OnTaskEvent(ev taskEvent) {
	if ev.Name == eventTaskQueued {
		select {
		case <-o.entered:
		default:
			close(o.entered)
		}
		<-o.release
	}
	o.mu.Lock()
	o.names = append(o.names, ev.Name)
	o.mu.Unlock()
}
func (o *qa121OrderedObserver) snapshot() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]string(nil), o.names...)
}
func TestQA121QueuedSSECannotBeOvertakenByStarted(t *testing.T) {
	chdirTemp(t)
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{\"ok\":true}"))
	}))
	defer engine.Close()
	tm := NewTaskManager(NewHistoryManager())
	observer := &qa121OrderedObserver{entered: make(chan struct{}), release: make(chan struct{})}
	tm.AddObserver(observer)
	var once sync.Once
	release := func() { once.Do(func() { close(observer.release) }) }
	defer release()
	inst := &Instance{ID: "order-1", Name: "Synthetic", ModelID: "nonexistent_model", Port: portOf(t, engine.URL)}
	done := make(chan *Task, 1)
	go func() {
		done <- tm.Submit(inst, map[string]any{"text": "synthetic"}, json.RawMessage("{\"text\":\"synthetic\"}"))
	}()
	select {
	case <-observer.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("task.queued observer not reached")
	}
	// The worker is already enqueued but may not emit started until queued
	// notification finishes. Blocking the observer makes this deterministic.
	time.Sleep(40 * time.Millisecond)
	for _, name := range observer.snapshot() {
		if name == eventTaskStarted || name == eventTaskFinished {
			t.Fatalf("worker overtook queued event: %v", observer.snapshot())
		}
	}
	release()
	var task *Task
	select {
	case task = <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Submit deadlocked after release")
	}
	if got := waitTerminal(t, tm, task.ID, 2*time.Second); got["status"] != "DONE" {
		t.Fatalf("terminal status=%v", got)
	}
	ordered := observer.snapshot()
	expected := []string{eventTaskQueued, eventTaskStarted, eventTaskFinished}
	if len(ordered) != len(expected) {
		t.Fatalf("transitions=%v", ordered)
	}
	for i, name := range expected {
		if ordered[i] != name {
			t.Fatalf("transitions=%v want=%v", ordered, expected)
		}
	}
}
