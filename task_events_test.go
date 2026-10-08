package main

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

type captureObs struct {
	mu  sync.Mutex
	evs []taskEvent
}

func (c *captureObs) OnTaskEvent(ev taskEvent) {
	c.mu.Lock()
	c.evs = append(c.evs, ev)
	c.mu.Unlock()
}

func (c *captureObs) has(name string) (taskEvent, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, ev := range c.evs {
		if ev.Name == name {
			return ev, true
		}
	}
	return taskEvent{}, false
}

func waitEvent(t *testing.T, c *captureObs, name string, timeout time.Duration) taskEvent {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if ev, ok := c.has(name); ok {
			return ev
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", name)
	return taskEvent{}
}

func TestTaskLifecycleEventsAndPeaks(t *testing.T) {
	chdirTemp(t)
	hold := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(hold) }) }
	defer release()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-hold
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	tm := NewTaskManager(NewHistoryManager())
	obs := &captureObs{}
	tm.AddObserver(obs)
	inst := &Instance{ID: "i1", Name: "n", ModelID: "nonexistent_model", Port: portOf(t, srv.URL)}
	task := tm.Submit(inst, map[string]any{"text": "hi"}, []byte(`{"text":"hi"}`))

	started := waitEvent(t, obs, eventTaskStarted, 2*time.Second)
	if started.InstanceID != "i1" || started.Category != "other" || started.TaskID != task.ID {
		t.Fatalf("started = %+v", started)
	}
	if _, ok := obs.has(eventTaskQueued); !ok {
		t.Fatal("missing task.queued")
	}

	tm.NoteInstanceSample("i1", 111, 222)
	tm.NoteInstanceSample("i1", 50, -1)
	tm.NoteInstanceSample("i1", 150, 100)
	release()

	got := waitTerminal(t, tm, task.ID, 2*time.Second)
	if got["status"] != "DONE" {
		t.Fatalf("status = %#v", got)
	}
	if got["peakRamBytes"] != float64(150) || got["peakVramBytes"] != float64(222) {
		t.Fatalf("peaks = %#v", got)
	}
	finished := waitEvent(t, obs, eventTaskFinished, 2*time.Second)
	if finished.PeakRam == nil || *finished.PeakRam != 150 || finished.PeakVram == nil || *finished.PeakVram != 222 {
		t.Fatalf("finished peaks = %+v", finished)
	}
}

func TestTaskFailedEvent(t *testing.T) {
	chdirTemp(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()

	tm := NewTaskManager(NewHistoryManager())
	obs := &captureObs{}
	tm.AddObserver(obs)
	inst := &Instance{ID: "i2", Name: "n", ModelID: "nonexistent_model", Port: portOf(t, srv.URL)}
	task := tm.Submit(inst, map[string]any{"text": "hi"}, []byte(`{"text":"hi"}`))

	got := waitTerminal(t, tm, task.ID, 2*time.Second)
	if got["status"] != "FAILED" {
		t.Fatalf("status = %#v", got)
	}
	ev := waitEvent(t, obs, eventTaskFailed, 2*time.Second)
	if ev.Error == "" || ev.TaskID != task.ID {
		t.Fatalf("failed = %+v", ev)
	}
}

func TestCancelQueuedKeepsSiblingRunning(t *testing.T) {
	chdirTemp(t)
	hold := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(hold) }) }
	defer release()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-hold
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	tm := NewTaskManager(NewHistoryManager())
	obs := &captureObs{}
	tm.AddObserver(obs)
	inst := &Instance{ID: "i3", Name: "n", ModelID: "nonexistent_model", Port: portOf(t, srv.URL)}
	first := tm.Submit(inst, map[string]any{"text": "a"}, []byte(`{"text":"a"}`))
	waitEvent(t, obs, eventTaskStarted, 2*time.Second)
	second := tm.Submit(inst, map[string]any{"text": "b"}, []byte(`{"text":"b"}`))
	if !tm.Cancel(second.ID) {
		t.Fatal("cancel returned false")
	}
	ev := waitEvent(t, obs, eventTaskCancelled, 2*time.Second)
	if ev.TaskID != second.ID || !ev.StillRunning {
		t.Fatalf("cancelled = %+v", ev)
	}
	release()
	got := waitTerminal(t, tm, first.ID, 2*time.Second)
	if got["status"] != "DONE" {
		t.Fatalf("first status = %#v", got)
	}
}
