package main

import (
	"encoding/json"
	"testing"
	"time"
)

// Wire contract: frontends should not have to infer the status from event names,
// and backend failure messages may echo user-authored prompts.
func TestQA121SSEPayloadStatusAndPrivacy(t *testing.T) {
	cases := []struct {
		name, status string
		terminal     bool
	}{
		{eventTaskQueued, "QUEUED", false},
		{eventTaskStarted, "RUNNING", false},
		{eventTaskFinished, "DONE", true},
		{eventTaskFailed, "FAILED", true},
		{eventTaskCancelled, "CANCELLED", true},
	}
	bus := NewEventBus()
	defer bus.Close()
	sub := bus.Subscribe()
	defer bus.Unsubscribe(sub)
	peak := int64(123)
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			bus.OnTaskEvent(taskEvent{
				Name: tt.name, TaskID: "task-1", InstanceID: "instance-1",
				ModelID: "model-1", Status: tt.status, DurationMs: 32,
				PeakRam: &peak, Error: "PRIVATE PROMPT echoed by backend",
			})
			select {
			case got := <-sub.ch:
				if got.name != tt.name {
					t.Fatalf("event name %q", got.name)
				}
				var data map[string]any
				if err := json.Unmarshal(got.data, &data); err != nil {
					t.Fatal(err)
				}
				if data["status"] != tt.status || data["taskId"] != "task-1" {
					t.Fatalf("missing authoritative status/task ID: %#v", data)
				}
				if _, ok := data["error"]; ok {
					t.Fatalf("backend error text leaked in SSE: %#v", data)
				}
				if tt.terminal && (data["durationMs"] != float64(32) || data["peakRamBytes"] != float64(123) && tt.name != eventTaskFailed) {
					t.Fatalf("terminal metrics incomplete: %#v", data)
				}
			case <-time.After(time.Second):
				t.Fatal("did not receive SSE event")
			}
		})
	}
}

// A lost GPU probe must not turn a previous reading into a current reading.
func TestQA121UnavailableVRAMNeverPresentedAsCurrent(t *testing.T) {
	bus := NewEventBus()
	defer bus.Close()
	sub := bus.Subscribe()
	defer bus.Unsubscribe(sub)
	sampler := NewMemorySampler(nil, NewTaskManager(NewHistoryManager()), bus)
	id := "synthetic-instance"
	now := time.Unix(1700000000, 0)
	sampler.record(id, now, 100, 2048, true, vramSourceDrm)
	sampler.setBusy(id, true)
	sampler.record(id, now.Add(time.Second), 120, 0, false, "")
	memory := sampler.MemoryJSON(id)
	if _, ok := memory["vramBytes"]; ok {
		t.Fatalf("stale VRAM presented as current: %#v", memory)
	}
	if memory["vramPeakBytes"] != int64(2048) {
		t.Fatalf("historically measured peak should remain valid: %#v", memory)
	}
	select {
	case got := <-sub.ch:
		var payload map[string]any
		if err := json.Unmarshal(got.data, &payload); err != nil {
			t.Fatal(err)
		}
		if got.name != eventInstanceMemory || payload["ramBytes"] != float64(120) {
			t.Fatalf("unexpected memory event: %s %#v", got.name, payload)
		}
		if _, ok := payload["vramBytes"]; ok {
			t.Fatalf("unavailable VRAM leaked as live reading: %#v", payload)
		}
	case <-time.After(time.Second):
		t.Fatal("missing memory event")
	}
}
