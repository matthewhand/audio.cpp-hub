package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestParseVmRSSBytes(t *testing.T) {
	got, ok := parseVmRSSBytes("Name:\tfoo\nVmRSS:\t  1234 kB\nVmSize:\t9999 kB\n")
	if !ok || got != 1234*1024 {
		t.Fatalf("VmRSS = %d ok=%v", got, ok)
	}
	if _, ok := parseVmRSSBytes("Name:\tfoo\nVmSize:\t1 kB\n"); ok {
		t.Fatal("missing VmRSS should be unsupported")
	}
	if _, ok := parseVmRSSBytes("VmRSS:\t-1 kB\n"); ok {
		t.Fatal("negative VmRSS should be unsupported")
	}
}

func TestSumDrmVRAMBytesDedup(t *testing.T) {
	fds := map[string]string{
		"3": "pos:\t0\ndrm-client-id:\t7\ndrm-memory-vram:\t1000 KiB\n",
		"4": "drm-client-id:\t7\ndrm-memory-vram:\t1000 KiB\n",
		"5": "drm-client-id:\t8\ndrm-memory-vram:\t500 KiB\n",
	}
	got, ok := sumDrmVRAMBytes(fds)
	if !ok || got != (1000+500)*1024 {
		t.Fatalf("dedup sum = %d ok=%v", got, ok)
	}

	// Same client, disagreeing totals: keep the larger reading.
	maxed, ok := sumDrmVRAMBytes(map[string]string{
		"1": "drm-client-id:\t1\ndrm-memory-vram:\t100 KiB\n",
		"2": "drm-client-id:\t1\ndrm-memory-vram:\t250 KiB\n",
	})
	if !ok || maxed != 250*1024 {
		t.Fatalf("max-dedup = %d ok=%v", maxed, ok)
	}

	// No client id: each fd counts on its own.
	plain, ok := sumDrmVRAMBytes(map[string]string{
		"a": "drm-memory-vram:\t10 KiB\n",
		"b": "drm-memory-vram:\t20 KiB\n",
	})
	if !ok || plain != 30*1024 {
		t.Fatalf("no-client sum = %d ok=%v", plain, ok)
	}

	if _, ok := sumDrmVRAMBytes(map[string]string{"9": "pos:\t0\ndrm-client-id:\t3\n"}); ok {
		t.Fatal("fdinfo without drm-memory-vram is not a VRAM reading")
	}
}

func TestParseNvidiaSmiOutput(t *testing.T) {
	out := parseNvidiaSmiOutput("123, 3690\n456, 100 MiB\nbad, 1\n789, [N/A]\n\n")
	if len(out) != 2 {
		t.Fatalf("parsed %d rows: %#v", len(out), out)
	}
	if out[123] != 3690*1024*1024 || out[456] != 100*1024*1024 {
		t.Fatalf("bytes = %#v", out)
	}
	if len(parseNvidiaSmiOutput("")) != 0 {
		t.Fatal("empty output should be an empty map")
	}
}

func TestMemRollingTimeWeighted(t *testing.T) {
	var r memRolling
	t0 := time.Unix(1_700_000_000, 0)
	r.addSample(t0, 100, 0, false, "")
	if r.ramAvg() != 100 {
		t.Fatalf("single-sample ram avg = %d", r.ramAvg())
	}
	if r.vramAvg() != 0 {
		t.Fatalf("unknown vram avg = %d", r.vramAvg())
	}

	r.addSample(t0.Add(time.Second), 200, 1000, true, vramSourceNvidia)
	if r.ramAvg() != 100 {
		t.Fatalf("after 1s ram avg = %d, want 100", r.ramAvg())
	}
	if r.vramAvg() != 1000 {
		t.Fatalf("first vram sample avg = %d", r.vramAvg())
	}

	// 10s at the previous values: ram (100*1s + 200*10s) / 11s = 190.909 → 191.
	// VRAM span only covers the interval where VRAM was already known: 1000.
	r.addSample(t0.Add(11*time.Second), 200, 5000, true, vramSourceNvidia)
	if r.ramAvg() != 191 {
		t.Fatalf("ram avg = %d, want 191", r.ramAvg())
	}
	if r.vramAvg() != 1000 {
		t.Fatalf("vram avg = %d, want 1000", r.vramAvg())
	}
	if r.peakRAM != 200 || r.peakVRAM != 5000 {
		t.Fatalf("peaks ram=%d vram=%d", r.peakRAM, r.peakVRAM)
	}
	if r.vramSource != vramSourceNvidia || r.samples != 3 {
		t.Fatalf("source=%s samples=%d", r.vramSource, r.samples)
	}
}

func TestInstanceListMemoryJSON(t *testing.T) {
	chdirTemp(t)
	im := NewInstanceManager(18090, 8080)
	inst := &Instance{
		ID: "mem-1", Name: "mem", ModelID: "nonexistent_model", Port: 1,
		Backend: "cpu", Status: "READY", CreatedAt: "2026-01-01T00:00:00Z",
		done: make(chan struct{}),
	}
	im.mu.Lock()
	im.items[inst.ID] = inst
	im.mu.Unlock()

	tm := NewTaskManager(NewHistoryManager())
	mem := NewMemorySampler(im, tm, nil)
	hub := &Hub{instances: im, tasks: tm, mem: mem}
	handler := hub.newHandler()

	body := getInstances(t, handler)
	if _, ok := body[0]["memory"]; ok {
		t.Fatalf("memory present before the first sample: %#v", body[0]["memory"])
	}

	t0 := time.Unix(1_700_000_000, 0)
	mem.record(inst.ID, t0, 100, 0, false, "")
	body = getInstances(t, handler)
	raw, _ := json.Marshal(body[0]["memory"])
	var memObj map[string]any
	if err := json.Unmarshal(raw, &memObj); err != nil {
		t.Fatal(err)
	}
	if memObj["ramBytes"] != float64(100) || memObj["ramAvgBytes"] != float64(100) {
		t.Fatalf("ram sample = %#v", memObj)
	}
	if _, ok := memObj["vramBytes"]; ok {
		t.Fatalf("vram should be omitted until known: %#v", memObj)
	}
	if memObj["busy"] != false || memObj["samples"] != float64(1) {
		t.Fatalf("meta = %#v", memObj)
	}

	mem.record(inst.ID, t0.Add(time.Second), 200, 4096, true, vramSourceNvidia)
	body = getInstances(t, handler)
	raw, _ = json.Marshal(body[0]["memory"])
	memObj = nil
	if err := json.Unmarshal(raw, &memObj); err != nil {
		t.Fatal(err)
	}
	if memObj["vramBytes"] != float64(4096) || memObj["vramSource"] != vramSourceNvidia {
		t.Fatalf("vram sample = %#v", memObj)
	}
	if memObj["ramPeakBytes"] != float64(200) || memObj["vramPeakBytes"] != float64(4096) {
		t.Fatalf("peaks = %#v", memObj)
	}
}

func getInstances(t *testing.T, handler http.Handler) []map[string]any {
	t.Helper()
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/instances", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/instances %d: %s", rec.Code, rec.Body.String())
	}
	var body []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body) != 1 {
		t.Fatalf("instances = %#v", body)
	}
	return body
}

func TestSamplerBusyFollowsStillRunning(t *testing.T) {
	s := NewMemorySampler(nil, nil, nil)
	s.OnTaskEvent(taskEvent{Name: eventTaskStarted, InstanceID: "a"})
	s.mu.Lock()
	busy := s.busy["a"]
	s.mu.Unlock()
	if !busy {
		t.Fatal("task.started should switch the instance to fast sampling")
	}
	s.OnTaskEvent(taskEvent{Name: eventTaskCancelled, InstanceID: "a", StillRunning: true})
	s.mu.Lock()
	busy = s.busy["a"]
	s.mu.Unlock()
	if !busy {
		t.Fatal("a queued cancel must not drop fast sampling while another task is RUNNING")
	}
	s.OnTaskEvent(taskEvent{Name: eventTaskFinished, InstanceID: "a"})
	s.mu.Lock()
	_, busy = s.busy["a"]
	s.mu.Unlock()
	if busy {
		t.Fatal("task.finished with StillRunning false should return to idle sampling")
	}
}
