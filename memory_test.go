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
	r.addSample(t0, 100, 0, false, "", false)
	if r.ramAvg() != 100 {
		t.Fatalf("single-sample ram avg = %d", r.ramAvg())
	}
	if r.vramAvg() != 0 {
		t.Fatalf("unknown vram avg = %d", r.vramAvg())
	}

	r.addSample(t0.Add(time.Second), 200, 1000, true, vramSourceNvidia, false)
	if r.ramAvg() != 100 {
		t.Fatalf("after 1s ram avg = %d, want 100", r.ramAvg())
	}
	if r.vramAvg() != 1000 {
		t.Fatalf("first vram sample avg = %d", r.vramAvg())
	}

	// 10s at the previous values: ram (100*1s + 200*10s) / 11s = 190.909 → 191.
	// VRAM span only covers the interval where VRAM was already known: 1000.
	r.addSample(t0.Add(11*time.Second), 200, 5000, true, vramSourceNvidia, false)
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

func TestMemRollingIdleBaseline(t *testing.T) {
	var r memRolling
	t0 := time.Unix(1_700_000_000, 0)
	// Idle samples only: the baselines track the minimum, and a single sample
	// already counts as one.
	r.addSample(t0, 500, 3000, true, vramSourceDrm, true)
	r.addSample(t0.Add(time.Second), 400, 2500, true, vramSourceDrm, true)
	r.addSample(t0.Add(2*time.Second), 450, 2800, true, vramSourceDrm, true)
	if r.ramIdleBytes != 400 || !r.ramIdleKnown {
		t.Fatalf("ram idle = %d known=%v", r.ramIdleBytes, r.ramIdleKnown)
	}
	if r.vramIdleBytes != 2500 || !r.vramIdleKnown {
		t.Fatalf("vram idle = %d known=%v", r.vramIdleBytes, r.vramIdleKnown)
	}

	// Busy samples must not move the baseline in either direction, and VRAM
	// readings that first appear while busy are not idle readings at all.
	r.addSample(t0.Add(3*time.Second), 900, 9000, true, vramSourceDrm, false)
	r.addSample(t0.Add(4*time.Second), 100, 9000, true, vramSourceDrm, false)
	if r.ramIdleBytes != 400 || r.vramIdleBytes != 2500 {
		t.Fatalf("busy samples moved the idle baseline: ram=%d vram=%d", r.ramIdleBytes, r.vramIdleBytes)
	}

	// An idle sample without a VRAM reading leaves the VRAM baseline alone.
	r.addSample(t0.Add(5*time.Second), 350, 0, false, "", true)
	if r.ramIdleBytes != 350 {
		t.Fatalf("ram idle = %d, want 350", r.ramIdleBytes)
	}
	if r.vramIdleBytes != 2500 {
		t.Fatalf("vram idle = %d, want the last known 2500", r.vramIdleBytes)
	}
}

func TestSamplerIdleBaselineFollowsBusy(t *testing.T) {
	chdirTemp(t)
	im := NewInstanceManager(18090, 8080)
	s := NewMemorySampler(im, NewTaskManager(NewHistoryManager()), nil)
	t0 := time.Unix(1_700_000_000, 0)

	// A task starts: the sample taken while it RUNNING is busy, so it must not
	// create an idle baseline at all.
	s.OnTaskEvent(taskEvent{Name: eventTaskStarted, InstanceID: "a"})
	s.record("a", t0, 900, 9000, true, vramSourceDrm)
	if m := s.MemoryJSON("a"); m != nil {
		if _, ok := m["ramIdleBytes"]; ok {
			t.Fatalf("a busy sample must not create an idle baseline: %#v", m)
		}
	}

	// Task over, back to idle sampling: the baseline appears from the idle
	// minimum only.
	s.OnTaskEvent(taskEvent{Name: eventTaskFinished, InstanceID: "a"})
	s.record("a", t0.Add(10*time.Second), 400, 4000, true, vramSourceDrm)
	m := s.MemoryJSON("a")
	if m["ramIdleBytes"] != int64(400) || m["vramIdleBytes"] != int64(4000) {
		t.Fatalf("idle baseline = %#v", m)
	}
	if m["ramPeakBytes"] != int64(900) || m["vramPeakBytes"] != int64(9000) {
		t.Fatalf("busy peaks must stay = %#v", m)
	}
}

func TestParseNvidiaGpuTotals(t *testing.T) {
	out := parseNvidiaGpuTotals("0, 8192\n1, 4096\n2, [N/A]\n\n")
	if len(out) != 2 {
		t.Fatalf("parsed %d rows: %#v", len(out), out)
	}
	if out[0] != 8192*1024*1024 || out[1] != 4096*1024*1024 {
		t.Fatalf("totals = %#v", out)
	}
	if len(parseNvidiaGpuTotals("")) != 0 {
		t.Fatal("empty output should be an empty map")
	}
	if len(parseNvidiaGpuTotals("garbage\n0, notanumber\n")) != 0 {
		t.Fatal("unparsable rows should be skipped")
	}
}

func TestParseDrmVramTotal(t *testing.T) {
	if got, ok := parseDrmVramTotal("8589934592\n"); !ok || got != 8589934592 {
		t.Fatalf("total = %d ok=%v", got, ok)
	}
	for _, bad := range []string{"", "  ", "0", "-1", "n/a"} {
		if _, ok := parseDrmVramTotal(bad); ok {
			t.Fatalf("%q should not parse as a VRAM total", bad)
		}
	}
}

func TestVramTotalBytesSingleGpuOnly(t *testing.T) {
	s := NewMemorySampler(nil, nil, nil)

	// No query yet / no totals: unknown.
	if _, ok := s.vramTotalBytesLocked(vramSourceNvidia); ok {
		t.Fatal("no totals yet should be unknown")
	}
	// Several GPUs: the process could be on any of them, so no ceiling.
	s.nvTotals = map[int]int64{0: 8 * 1024 * 1024 * 1024, 1: 16 * 1024 * 1024 * 1024}
	if _, ok := s.vramTotalBytesLocked(vramSourceNvidia); ok {
		t.Fatal("several GPUs must stay unknown")
	}
	// Exactly one GPU: no mapping needed.
	s.nvTotals = map[int]int64{0: 8 * 1024 * 1024 * 1024}
	if got, ok := s.vramTotalBytesLocked(vramSourceNvidia); !ok || got != 8*1024*1024*1024 {
		t.Fatalf("single GPU total = %d ok=%v", got, ok)
	}
	// DRM sources never read the nvidia table.
	if _, ok := s.vramTotalBytesLocked(vramSourceDrm); ok {
		t.Fatal("DRM must not use the nvidia totals")
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
	// No task is RUNNING in this test, so the very first sample is already an
	// idle one: the baseline appears with it (busy samples are covered by
	// TestSamplerIdleBaselineFollowsBusy).
	if memObj["ramIdleBytes"] != float64(100) {
		t.Fatalf("ram idle baseline = %#v", memObj["ramIdleBytes"])
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
	// No task is RUNNING here (busy comes from task events), so both samples
	// are idle and the baselines equal the minimum of the two.
	if memObj["ramIdleBytes"] != float64(100) || memObj["vramIdleBytes"] != float64(4096) {
		t.Fatalf("idle baselines = %#v", memObj)
	}

	// The GPU total is the scale of the VRAM bar: single GPU yes, several no.
	mem.nvTotals = map[int]int64{0: 8 * 1024 * 1024 * 1024, 1: 16 * 1024 * 1024 * 1024}
	body = getInstances(t, handler)
	raw, _ = json.Marshal(body[0]["memory"])
	memObj = nil
	if err := json.Unmarshal(raw, &memObj); err != nil {
		t.Fatal(err)
	}
	if _, ok := memObj["vramTotalBytes"]; ok {
		t.Fatalf("several GPUs must not invent a ceiling: %#v", memObj)
	}
	mem.nvTotals = map[int]int64{0: 8 * 1024 * 1024 * 1024}
	body = getInstances(t, handler)
	raw, _ = json.Marshal(body[0]["memory"])
	memObj = nil
	if err := json.Unmarshal(raw, &memObj); err != nil {
		t.Fatal(err)
	}
	if memObj["vramTotalBytes"] != float64(8*1024*1024*1024) {
		t.Fatalf("vram total = %#v", memObj["vramTotalBytes"])
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
