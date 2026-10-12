package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"
)

// events.go — in-process task lifecycle event bus + SSE push
// (GET /api/events/stream).
//
// Until now the hub had no push channel at all: GET /api/events was just the
// polled instance log window, and task progress was poll-only. This file adds
// the push half:
//
//   - EventBus fans out named events to per-subscriber buffered channels.
//     Publishing never blocks: a slow subscriber whose buffer is full simply
//     misses that event (task execution must never wait on UI). The same bus
//     feeds both HTTP SSE subscribers and in-process consumers (currently the
//     memory sampler's fast/slow switching, see memory.go).
//   - Task status transitions (task.go) notify taskObserver implementations
//     with a locked snapshot; the EventBus is the observer that turns them
//     into SSE frames.
//
// SSE is hub-local by design: cmd/fanout-proxy deliberately does NOT proxy
// this stream (see docs/agent-api.md) — the events are transient push
// notifications, not addressable per-hub resources.

// Named events (the SSE "event:" field).
const (
	eventTaskQueued    = "task.queued"
	eventTaskStarted   = "task.started"
	eventTaskFinished  = "task.finished"
	eventTaskFailed    = "task.failed"
	eventTaskCancelled = "task.cancelled"
)

// taskEvent is a snapshot of one task status transition. Built under the
// TaskManager lock so observers never touch a live *Task outside it.
type taskEvent struct {
	Name         string // task.queued / task.started / task.finished / task.failed / task.cancelled
	TaskID       string
	InstanceID   string
	ModelID      string
	Category     string
	Status       string
	DurationMs   int64  // StartedAt -> FinishedAt (0 when not started/finished)
	Error        string // failure summary on FAILED
	PeakRam      *int64 // peak memory observed while RUNNING (sampler; nil = never sampled)
	PeakVram     *int64
	StillRunning bool // after this transition, the instance still has a RUNNING task
}

// taskObserver receives task lifecycle notifications. Implementations are
// called synchronously on the task execution path and must return quickly
// (EventBus.Publish is non-blocking).
type taskObserver interface {
	OnTaskEvent(ev taskEvent)
}

// sseEvent is one named event with pre-marshaled JSON data.
type sseEvent struct {
	name string
	data []byte
}

// EventBus is the in-process fan-out: one buffered channel per subscriber,
// events are dropped for slow subscribers.
type EventBus struct {
	mu     sync.Mutex
	subs   map[*eventSubscriber]struct{}
	drops  int64 // cumulative drops for slow subscribers (diagnostics only)
	closed bool
}

// eventSubscriber is the receiving end of one subscription.
type eventSubscriber struct {
	ch chan sseEvent
}

func NewEventBus() *EventBus {
	return &EventBus{subs: map[*eventSubscriber]struct{}{}}
}

// Subscribe registers a subscriber (buffered to eventBusBuffer events).
func (b *EventBus) Subscribe() *eventSubscriber {
	sub := &eventSubscriber{ch: make(chan sseEvent, eventBusBuffer)}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		close(sub.ch)
		return sub
	}
	b.subs[sub] = struct{}{}
	return sub
}

// SubscribeHTTP admits only a bounded number of live SSE clients. Queue bounds
// alone do not bound HTTP connections, goroutines or per-client write state.
// The capacity check and registration share the EventBus mutex so concurrent
// connections cannot oversubscribe the limit. A nil return means full/closed.
func (b *EventBus) SubscribeHTTP() *eventSubscriber {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed || len(b.subs) >= maxSSESubscribers {
		return nil
	}
	sub := &eventSubscriber{ch: make(chan sseEvent, eventBusBuffer)}
	b.subs[sub] = struct{}{}
	return sub
}

// Unsubscribe removes a subscriber (called by the SSE handler on client
// disconnect). Idempotent.
func (b *EventBus) Unsubscribe(sub *eventSubscriber) {
	if sub == nil {
		return
	}
	b.mu.Lock()
	delete(b.subs, sub)
	b.mu.Unlock()
}

// Publish broadcasts one named event: the payload is marshaled once, then
// delivered non-blocking per subscriber; a full buffer drops the event for
// that subscriber only. Marshal failures are ignored.
func (b *EventBus) Publish(name string, payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	ev := sseEvent{name: name, data: data}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	for sub := range b.subs {
		select {
		case sub.ch <- ev:
		default:
			b.drops++
		}
	}
}

// Close closes every subscriber channel (used on process shutdown: the SSE
// handlers see the closed channel and return, so srv.Shutdown does not have
// to hit its 15s timeout to unstick hanging event streams). Publish becomes a
// no-op afterwards.
func (b *EventBus) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.closed = true
	for sub := range b.subs {
		close(sub.ch)
		delete(b.subs, sub)
	}
}

// OnTaskEvent implements taskObserver: turns a task snapshot into the SSE
// payload and broadcasts it.
func (b *EventBus) OnTaskEvent(ev taskEvent) {
	payload := map[string]any{
		"taskId":     ev.TaskID,
		"instanceId": ev.InstanceID,
		"modelId":    ev.ModelID,
		"category":   ev.Category,
		"status":     ev.Status,
		"ts":         time.Now().UnixMilli(),
	}
	switch ev.Name {
	case eventTaskFinished:
		payload["ok"] = true
	case eventTaskFailed:
		payload["ok"] = false
	}
	// Terminal metrics are facts about *observed* work, not estimated values.
	if ev.Name == eventTaskFinished || ev.Name == eventTaskFailed || ev.Name == eventTaskCancelled {
		payload["durationMs"] = ev.DurationMs
		if ev.PeakRam != nil {
			payload["peakRamBytes"] = *ev.PeakRam
		}
		if ev.PeakVram != nil {
			payload["peakVramBytes"] = *ev.PeakVram
		}
	}
	// Error messages may echo private prompts; clients fetch authoritative task state.
	b.Publish(ev.Name, payload)
}

// writeSSEFrame renews a finite write deadline on every frame. There is no
// global HTTP WriteTimeout because the stream itself may remain open for hours.
// Never silently ignore an unsupported deadline: doing so could leave a
// wrapped HTTP writer blocked indefinitely. The handler checks support before
// sending HTTP 200. A stalled client is disconnected on deadline expiry.
func writeSSEFrame(w http.ResponseWriter, rc *http.ResponseController, frame []byte) error {
	if err := rc.SetWriteDeadline(time.Now().Add(sseWriteTimeout)); err != nil {
		return err
	}
	if _, err := w.Write(frame); err != nil {
		return err
	}
	return rc.Flush()
}

// handleEventStream serves GET /api/events/stream — the SSE push channel.
// A "hello" event is sent on connect, a ": ping" comment keeps the connection
// alive every ssePingInterval, and task lifecycle events arrive as named
// "task.*" events. The subscriber is detached as soon as the client
// disconnects (r.Context done).
//
// Flushing through the wrapper chain: securityHeaders / csrfProtect are plain
// handler middlewares that pass the original ResponseWriter through (they are
// not writer wrappers), so http.NewResponseController(w) still reaches the
// real Flusher — no Unwrap plumbing is needed here. main.go deliberately sets
// no WriteTimeout (stream durations are unbounded), which is what makes the
// long-lived SSE connection possible.
func (h *Hub) handleEventStream(w http.ResponseWriter, r *http.Request) {
	if h.bus == nil {
		errJSON(w, http.StatusServiceUnavailable, "EVENTS_UNAVAILABLE", nil, "event stream is not available")
		return
	}
	// Subscribe before hello so a task event published while the hello frame
	// is flushing is queued instead of dropped on the floor.
	sub := h.bus.SubscribeHTTP()
	if sub == nil {
		errJSON(w, http.StatusServiceUnavailable, "EVENTS_BUSY", nil, "event stream capacity reached or shutting down; use /api/tasks polling")
		return
	}
	defer h.bus.Unsubscribe(sub)
	rc := http.NewResponseController(w)
	// Reject response wrappers that cannot enforce per-frame write deadlines.
	// Checking before WriteHeader avoids advertising a successful but unbounded
	// stream. The normal net/http writer supports this; unknown wrappers must
	// implement Unwrap or SetWriteDeadline.
	if err := rc.SetWriteDeadline(time.Now().Add(sseWriteTimeout)); err != nil {
		if errors.Is(err, errors.ErrUnsupported) {
			errJSON(w, http.StatusServiceUnavailable, "EVENTS_DEADLINE_UNSUPPORTED", nil, "event stream requires write deadline support; use /api/tasks polling")
		}
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if err := writeSSEFrame(w, rc, []byte("event: hello\ndata: {}\n\n")); err != nil {
		return
	}
	ping := time.NewTicker(ssePingInterval)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done(): // client disconnected
			return
		case ev, ok := <-sub.ch:
			if !ok { // EventBus.Close on process shutdown
				return
			}
			if err := writeSSEFrame(w, rc, []byte("event: "+ev.name+"\ndata: "+string(ev.data)+"\n\n")); err != nil {
				return
			}
		case <-ping.C:
			if err := writeSSEFrame(w, rc, []byte(": ping\n\n")); err != nil {
				return
			}
		}
	}
}
