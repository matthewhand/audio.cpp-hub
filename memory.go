package main

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// memory.go — per-instance memory usage sampler (RAM + best-effort VRAM).
//
// One goroutine owned by the Hub samples every running audiocpp_server
// process: RAM is the process RSS; VRAM is best-effort and never fails
// anything — Linux DRM fdinfo first, one nvidia-smi query per pass as the
// fallback, unknown when neither source is available.
//
// The samples feed three consumers:
//   - rolling per-instance stats (current / peak / time-weighted average / idle
//     baseline) surfaced on GET /api/instances as the optional "memory" object;
//   - per-task peaks (TaskManager.NoteInstanceSample) that land on the task
//     record as peakRamBytes / peakVramBytes;
//   - "instance.memory" push events for busy instances (SSE).
//
// The idle baseline (ramIdleBytes / vramIdleBytes) is the minimum observed
// while the instance had no RUNNING task — the "what does this model cost at
// rest" number the WebUI bars print next to peak/average. GPU total VRAM
// (vramTotalBytes, the scale of the VRAM bar) is a separate one-shot query:
// nvidia-smi cannot return the compute-apps and the GPU table in a single
// invocation, so the total is fetched once per hub with the same timeout and
// backoff instead of on every pass.
//
// Cadence: ~1s while the instance has a RUNNING task, ~10s while idle. The
// switch is driven by the same in-process task lifecycle signal that feeds the
// SSE bus (taskObserver), not by the HTTP stream.

const (
	eventInstanceMemory = "instance.memory"
	vramSourceDrm       = "drm"
	vramSourceNvidia    = "nvidia-smi"
)

// MemorySampler samples running instance processes and keeps the rolling
// per-instance statistics.
type MemorySampler struct {
	instances *InstanceManager
	tasks     *TaskManager
	bus       *EventBus // optional: nil disables instance.memory events

	mu    sync.Mutex
	state map[string]*memRolling // by instance id, since instance start
	busy  map[string]bool        // instances with a RUNNING task (task events)

	// nvidiaRetryAt is only touched from the sampler goroutine.
	nvidiaRetryAt time.Time // nvidia-smi disabled until (missing / failed)

	// nvTotals is the cached GPU table (index → total VRAM bytes) behind
	// vramTotalBytes; nvTotalsRetryAt backs its one-shot query off. Written by
	// the sampler goroutine under mu, read by MemoryJSON under the same mu.
	nvTotals        map[int]int64
	nvTotalsRetryAt time.Time

	// drmTotals is the same table for AMD (card index → bytes), read from sysfs
	// at most once. Also mu-guarded for the same reason.
	drmTotals     map[int]int64
	drmTotalsDone bool

	wake      chan struct{} // busy-state changes nudge an immediate pass
	stop      chan struct{} // closed by Stop
	done      chan struct{} // closed when the loop exits
	startOnce sync.Once
	stopOnce  sync.Once
	started   atomic.Bool
}

func NewMemorySampler(instances *InstanceManager, tasks *TaskManager, bus *EventBus) *MemorySampler {
	return &MemorySampler{
		instances: instances,
		tasks:     tasks,
		bus:       bus,
		state:     map[string]*memRolling{},
		busy:      map[string]bool{},
		wake:      make(chan struct{}, 1),
		stop:      make(chan struct{}),
		done:      make(chan struct{}),
	}
}

// Start launches the sampling goroutine. On platforms without an RSS source
// (non-Linux) it is a no-op — the memory object simply stays omitted.
func (s *MemorySampler) Start() {
	if !memRSSSupported {
		return
	}
	s.startOnce.Do(func() {
		s.started.Store(true)
		go s.loop()
	})
}

// Stop signals shutdown and waits (bounded) for the loop to exit. No-op when
// the loop never started.
func (s *MemorySampler) Stop() {
	if !memRSSSupported {
		return
	}
	s.stopOnce.Do(func() { close(s.stop) })
	if !s.started.Load() {
		return
	}
	select {
	case <-s.done:
	case <-time.After(3 * time.Second):
	}
}

func (s *MemorySampler) loop() {
	defer close(s.done)
	ticker := time.NewTicker(memSamplerTick)
	defer ticker.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-s.wake:
			s.pass(time.Now())
		case <-ticker.C:
			s.pass(time.Now())
		}
	}
}

// nudge requests an immediate pass (non-blocking; a pass already in flight
// picks the latest busy state up on its next tick anyway).
func (s *MemorySampler) nudge() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// OnTaskEvent implements taskObserver: switches the instance between fast
// (busy) and slow (idle) sampling. This is the internal signal — the HTTP SSE
// stream is just another consumer of the same bus, never the driver.
func (s *MemorySampler) OnTaskEvent(ev taskEvent) {
	switch ev.Name {
	case eventTaskStarted:
		s.setBusy(ev.InstanceID, true)
	case eventTaskFinished, eventTaskFailed, eventTaskCancelled:
		// StillRunning stays true when a different task on this instance is
		// RUNNING (a queued cancel must not drop the fast cadence).
		s.setBusy(ev.InstanceID, ev.StillRunning)
	}
}

func (s *MemorySampler) setBusy(instanceID string, on bool) {
	s.mu.Lock()
	if on != s.busy[instanceID] {
		if on {
			s.busy[instanceID] = true
		} else {
			delete(s.busy, instanceID)
		}
	}
	s.mu.Unlock()
	s.nudge()
}

// intervalLocked returns the sampling interval for one instance (caller holds
// s.mu). The per-instance queue is serial, so at most one RUNNING task at a
// time decides the cadence.
func (s *MemorySampler) intervalLocked(instanceID string) time.Duration {
	if s.busy[instanceID] {
		return memSampleBusyInterval
	}
	return memSampleIdleInterval
}

// sampleInfo is one collected sample before it is recorded.
type sampleInfo struct {
	instanceID string
	pid        int
	ram        int64
	vram       int64
	vramKnown  bool
	source     string
}

// pass samples every due instance: RAM from the platform reader, VRAM from
// DRM fdinfo with a single nvidia-smi fallback query per pass. Instances whose
// RSS cannot be read (process gone) keep their last state; state for
// instances that no longer run is dropped (stats are per instance lifetime).
func (s *MemorySampler) pass(now time.Time) {
	if !memRSSSupported {
		return
	}
	running := s.instances.RunningWithPID()
	s.mu.Lock()
	alive := make(map[string]bool, len(running))
	for _, ip := range running {
		alive[ip.ID] = true
	}
	for id := range s.state {
		if !alive[id] {
			delete(s.state, id)
		}
	}
	due := make([]InstancePID, 0, len(running))
	for _, ip := range running {
		st, ok := s.state[ip.ID]
		if ok && now.Sub(st.lastTime) < s.intervalLocked(ip.ID) {
			continue
		}
		due = append(due, ip)
	}
	s.mu.Unlock()

	samples := make([]sampleInfo, 0, len(due))
	for _, ip := range due {
		ram, ok := procStatusRSSBytes(ip.PID)
		if !ok {
			continue // unreadable / gone: keep the last state
		}
		vram, vOK := procDrmVRAMBytes(ip.PID)
		samples = append(samples, sampleInfo{
			instanceID: ip.ID, pid: ip.PID, ram: ram, vram: vram, vramKnown: vOK,
			source: vramSourceDrm,
		})
	}
	// nvidia-smi fallback: one query per pass at most, only when some due
	// instance got no DRM numbers. A failed/missing binary backs the source
	// off for nvidiaBackoff so it is not respawned every second.
	var nv map[int]int64
	nvQueried := false
	for i := range samples {
		if samples[i].vramKnown {
			continue
		}
		if !nvQueried {
			nv = s.nvidiaOnce(now)
			nvQueried = true
		}
		if nv == nil {
			continue // unavailable (backoff): leave VRAM unknown (sticky)
		}
		used, ok := nv[samples[i].pid]
		if !ok {
			continue // query succeeded but this pid is not a compute app
		}
		samples[i].vram = used
		samples[i].vramKnown = true
		samples[i].source = vramSourceNvidia
	}
	// GPU totals (the scale of the VRAM bar) need a second table that nvidia-smi
	// cannot return together with the compute apps, so it is a one-shot side
	// query — only when the nvidia path is alive, at most once per hub.
	if nvQueried && nv != nil {
		s.nvidiaGpuTotals(now)
	}
	for _, sm := range samples {
		s.record(sm.instanceID, now, sm.ram, sm.vram, sm.vramKnown, sm.source)
	}
}

// record applies one sample: rolling stats, per-task peaks, and (for busy
// instances) an instance.memory push event. Samples taken while no task is
// RUNNING (idle) also feed the idle baselines.
func (s *MemorySampler) record(instanceID string, now time.Time, ram, vram int64, vramKnown bool, source string) {
	s.mu.Lock()
	st := s.state[instanceID]
	if st == nil {
		st = &memRolling{}
		s.state[instanceID] = st
	}
	busy := s.busy[instanceID]
	st.addSample(now, ram, vram, vramKnown, source, !busy)
	vramSticky, vramKnownSticky, vramSourceSticky := st.lastVRAM, st.vramKnown, st.vramSource
	s.mu.Unlock()

	// Per-task peaks for RUNNING tasks of this instance (peaks only grow).
	// vram < 0 means "unknown" and is skipped there.
	taskVram := int64(-1)
	if vramKnownSticky {
		taskVram = vramSticky
	}
	s.tasks.NoteInstanceSample(instanceID, ram, taskVram)

	if busy && s.bus != nil {
		payload := map[string]any{
			"instanceId": instanceID,
			"ramBytes":   ram,
			"ts":         now.UnixMilli(),
		}
		if vramKnownSticky {
			payload["vramBytes"] = vramSticky
			payload["vramSource"] = vramSourceSticky
		}
		s.bus.Publish(eventInstanceMemory, payload)
	}
}

// MemoryJSON returns the optional "memory" object for GET /api/instances.
// nil until the first successful RSS sample — old hubs, non-Linux platforms
// and not-yet-sampled instances omit it entirely (VRAM fields are omitted when
// VRAM was never measured, the idle baselines until an idle sample exists and
// vramTotalBytes when the GPU total is unknowable). Must never error because
// of sampling.
//
// ramSeries / vramSeries are the last memSeriesCap readings (oldest → newest,
// bytes) for the WebUI's sparklines. They are omitted below two points — a
// single sample draws no line — and each ring is an inline array, so the
// per-instance cost does not grow with instance lifetime.
func (s *MemorySampler) MemoryJSON(instanceID string) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.state[instanceID]
	if !ok || !st.hasSample {
		return nil
	}
	out := map[string]any{
		"ramBytes":     st.lastRAM,
		"ramPeakBytes": st.peakRAM,
		"ramAvgBytes":  st.ramAvg(),
		"samples":      st.samples,
		"sampledAt":    st.lastTime.UnixMilli(),
		"busy":         s.busy[instanceID],
	}
	if ram := st.ramRing.snapshot(); len(ram) >= 2 {
		out["ramSeries"] = ram
	}
	if st.ramIdleKnown {
		out["ramIdleBytes"] = st.ramIdleBytes
	}
	if st.vramKnown {
		out["vramBytes"] = st.lastVRAM
		out["vramPeakBytes"] = st.peakVRAM
		out["vramAvgBytes"] = st.vramAvg()
		out["vramSource"] = st.vramSource
		if vram := st.vramRing.snapshot(); len(vram) >= 2 {
			out["vramSeries"] = vram
		}
		if st.vramIdleKnown {
			out["vramIdleBytes"] = st.vramIdleBytes
		}
		if total, ok := s.vramTotalBytesLocked(st.vramSource); ok {
			out["vramTotalBytes"] = total
		}
	}
	return out
}

// vramTotalBytesLocked returns the total VRAM of the GPU this instance runs on
// (caller holds s.mu). Best-effort: it scales the WebUI's VRAM bar and is
// omitted whenever the answer would be a guess. A single GPU needs no
// process→GPU mapping, so a lone card's total is trusted; with several cards
// the process could sit on any of them, so the field stays omitted rather than
// showing a wrong ceiling.
func (s *MemorySampler) vramTotalBytesLocked(source string) (int64, bool) {
	var totals map[int]int64
	switch source {
	case vramSourceNvidia:
		totals = s.nvTotals
	case vramSourceDrm:
		if !s.drmTotalsDone {
			s.drmTotals, s.drmTotalsDone = procDrmVramTotals(), true
		}
		totals = s.drmTotals
	default:
		return 0, false
	}
	if len(totals) != 1 {
		return 0, false
	}
	for _, v := range totals {
		if v > 0 {
			return v, true
		}
	}
	return 0, false
}

// nvidiaGpuTotals fills the cached GPU table (index → total VRAM bytes) by
// querying "nvidia-smi --query-gpu=index,memory.total". Runs at most once per
// hub lifetime: GPU total memory does not change while the box is up, and the
// per-pid query keeps running every pass unchanged. Same timeout and backoff
// as nvidiaOnce — a missing binary is not respawned.
//
// nvidia-smi takes one query target per invocation and cannot return the
// compute-apps and the GPU table together, so the total costs one extra spawn
// once instead of an extra column on an every-pass query. Called from the
// sampler goroutine only; readers take s.mu.
func (s *MemorySampler) nvidiaGpuTotals(now time.Time) {
	if len(s.nvTotals) > 0 || now.Before(s.nvTotalsRetryAt) {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), nvidiaQueryTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "nvidia-smi",
		"--query-gpu=index,memory.total", "--format=csv,noheader,nounits")
	hideChildWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		s.mu.Lock()
		s.nvTotalsRetryAt = now.Add(nvidiaBackoff)
		s.mu.Unlock()
		return
	}
	totals := parseNvidiaGpuTotals(string(out))
	s.mu.Lock()
	s.nvTotals = totals
	s.mu.Unlock()
}

// nvidiaOnce runs nvidia-smi and returns pid -> VRAM bytes for every compute
// app. nil means "unavailable": either backed off after a previous failure or
// the run failed — both disable the source until nvidiaRetryAt.
func (s *MemorySampler) nvidiaOnce(now time.Time) map[int]int64 {
	if now.Before(s.nvidiaRetryAt) {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), nvidiaQueryTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "nvidia-smi",
		"--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits")
	hideChildWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		s.nvidiaRetryAt = now.Add(nvidiaBackoff)
		return nil
	}
	return parseNvidiaSmiOutput(string(out))
}

// memRolling holds the per-instance rolling memory statistics, accumulated
// since the instance started.
//
// The average is TIME-WEIGHTED: each sample's value is weighted by how long
// it held until the next sample (sum(value_i * dt_i) / span). That is the
// honest mean of a piecewise-constant signal — a 1s busy spike does not count
// as much as 10s of idle, and uneven sampling intervals do not skew it. It is
// NOT reset per task; it spans the instance lifetime.
//
// The idle baselines are the complement: the minimum seen while no task was
// RUNNING, i.e. what the model costs at rest. They only ever shrink, and only
// from idle samples — a busy sample must not drag the baseline down or up.
//
// ramRing / vramRing keep the last memSeriesCap readings (oldest → newest) so
// GET /api/instances can hand the WebUI a sparkline of the recent trend. They
// are fixed-size inline arrays: the per-instance overhead is 2 × 60 × 8 bytes
// and never grows with instance lifetime.
type memRolling struct {
	lastRAM       int64
	lastVRAM      int64
	vramKnown     bool   // sticky: a failed VRAM probe keeps the last known value
	vramSource    string // "drm" | "nvidia-smi"
	peakRAM       int64
	peakVRAM      int64
	ramIdleBytes  int64 // min while idle (ramIdleKnown = an idle sample exists)
	ramIdleKnown  bool
	vramIdleBytes int64
	vramIdleKnown bool
	ramIntegral   float64 // byte·ms
	vramIntegral  float64 // byte·ms
	spanMs        float64 // RAM weighting span
	vramSpanMs    float64 // only intervals where VRAM was already known
	samples       int
	lastTime      time.Time
	hasSample     bool

	ramRing  memRing
	vramRing memRing
}

// memRing is a fixed-capacity ring buffer of samples: push appends and drops
// the oldest value once full, snapshot returns the stored values oldest →
// newest. Bounded and allocation-free while filling.
type memRing struct {
	buf  [memSeriesCap]int64
	n    int // number of stored samples (≤ cap)
	head int // index of the oldest stored sample
}

// push records one value, evicting the oldest when the buffer is full.
func (r *memRing) push(v int64) {
	if r.n < len(r.buf) {
		r.buf[(r.head+r.n)%len(r.buf)] = v
		r.n++
		return
	}
	r.buf[r.head] = v
	r.head = (r.head + 1) % len(r.buf)
}

// snapshot returns the stored values oldest → newest (a fresh slice: callers
// hand it to the JSON encoder, so it must not alias the buffer).
func (r *memRing) snapshot() []int64 {
	out := make([]int64, r.n)
	for i := 0; i < r.n; i++ {
		out[i] = r.buf[(r.head+i)%len(r.buf)]
	}
	return out
}

// addSample folds one reading into the rolling stats. idle=true marks a sample
// taken while the instance had no RUNNING task (it updates the idle baselines).
func (r *memRolling) addSample(now time.Time, ram, vram int64, vramKnown bool, source string, idle bool) {
	if r.hasSample {
		dt := float64(now.Sub(r.lastTime).Milliseconds())
		if dt > 0 {
			r.spanMs += dt
			r.ramIntegral += float64(r.lastRAM) * dt
			if r.vramKnown {
				r.vramIntegral += float64(r.lastVRAM) * dt
				r.vramSpanMs += dt
			}
		}
	}
	r.lastRAM = ram
	if ram > r.peakRAM {
		r.peakRAM = ram
	}
	if vramKnown {
		r.lastVRAM = vram
		r.vramKnown = true
		r.vramSource = source
		if vram > r.peakVRAM {
			r.peakVRAM = vram
		}
	}
	if idle {
		if !r.ramIdleKnown || ram < r.ramIdleBytes {
			r.ramIdleBytes = ram
			r.ramIdleKnown = true
		}
		if vramKnown && (!r.vramIdleKnown || vram < r.vramIdleBytes) {
			r.vramIdleBytes = vram
			r.vramIdleKnown = true
		}
	}
	r.lastTime = now
	r.samples++
	r.hasSample = true
	// Recent trend for the WebUI sparklines: RAM every sample, VRAM only while
	// a reading exists (an unknown reading is not a zero).
	r.ramRing.push(ram)
	if vramKnown {
		r.vramRing.push(vram)
	}
}

func (r *memRolling) ramAvg() int64 {
	if r.spanMs <= 0 {
		return r.lastRAM // one sample: the observation itself is the average
	}
	return avgBytes(r.ramIntegral, r.spanMs)
}

func (r *memRolling) vramAvg() int64 {
	if !r.vramKnown {
		return 0
	}
	if r.vramSpanMs <= 0 {
		return r.lastVRAM
	}
	return avgBytes(r.vramIntegral, r.vramSpanMs)
}

// parseLeadingInt reads the integer at the start of s, ignoring a unit suffix
// such as " KiB" or " MiB".
func parseLeadingInt(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	i := 0
	if s[0] == '+' {
		i = 1
	}
	start := i
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == start {
		return 0, false
	}
	n, err := strconv.ParseInt(s[start:i], 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

func avgBytes(integral, spanMs float64) int64 {
	if spanMs <= 0 {
		return 0
	}
	return int64(integral/spanMs + 0.5)
}

// parseVmRSSBytes extracts the VmRSS line from /proc/<pid>/status content.
// Values are in kB (kernel "kB" = 1024 bytes). ok=false when the line is
// absent (kernel thread / permission boundary). Pure: tests run everywhere.
func parseVmRSSBytes(statusContent string) (int64, bool) {
	for _, line := range strings.Split(statusContent, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 || fields[0] != "VmRSS:" {
			continue
		}
		kb, err := strconv.ParseInt(fields[1], 10, 64)
		if err != nil || kb < 0 {
			return 0, false
		}
		return kb * 1024, true
	}
	return 0, false
}

// sumDrmVRAMBytes sums drm-memory-vram (KiB) across fdinfo file contents,
// de-duplicated by drm-client-id: several fds of the same DRM client report
// the same totals (amdgpu), so per-fd counting would double-count. Entries
// without a client id are keyed by fd name. ok=false when no entry carries a
// drm-memory-vram line (no DRM client on this pid → caller falls back to
// nvidia-smi). The kernel prints the value as "<KiB> KiB"; the unit suffix is
// ignored and the number is treated as KiB. Pure: tests run everywhere.
func sumDrmVRAMBytes(fdinfoByName map[string]string) (int64, bool) {
	perClient := map[string]int64{}
	seen := false
	for name, content := range fdinfoByName {
		clientID := ""
		kib := int64(-1)
		for _, line := range strings.Split(content, "\n") {
			key, val, ok := strings.Cut(line, ":")
			if !ok {
				continue
			}
			switch strings.TrimSpace(key) {
			case "drm-client-id":
				clientID = strings.TrimSpace(val)
			case "drm-memory-vram":
				if n, ok := parseLeadingInt(val); ok && n >= 0 {
					kib = n
				}
			}
		}
		if kib < 0 {
			continue // no drm-memory-vram line in this fd
		}
		seen = true
		key := clientID
		if key == "" {
			key = "fd:" + name
		}
		if prev, dup := perClient[key]; !dup || kib > prev {
			perClient[key] = kib
		}
	}
	if !seen {
		return 0, false
	}
	var total int64
	for _, v := range perClient {
		total += v
	}
	return total * 1024, true
}

// parseDrmVramTotal reads one /sys/class/drm/card*/device/mem_info_vram_total
// value: a bare byte count published by amdgpu. ok=false when the file is
// empty or not a positive number (the node also exists on cards without VRAM
// accounting). Pure: tests run everywhere.
func parseDrmVramTotal(content string) (int64, bool) {
	n, err := strconv.ParseInt(strings.TrimSpace(content), 10, 64)
	if err != nil || n <= 0 {
		return 0, false
	}
	return n, true
}

// parseSmiMiB reads one nvidia-smi memory column: a plain MiB number, with an
// optional " MiB" suffix, "N/A" style placeholders rejected. Pure: tests run
// everywhere.
func parseSmiMiB(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if i := strings.IndexAny(s, " \t"); i > 0 {
		s = s[:i] // tolerate a "3690 MiB" suffix
	}
	mib, err := strconv.ParseFloat(s, 64)
	if err != nil || mib < 0 {
		return 0, false
	}
	return int64(mib * 1024 * 1024), true
}

// parseNvidiaSmiOutput parses the CSV of
// "nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits":
// one "pid, MiB" row per compute app. Unparsable rows ("[N/A]",
// "[Not Supported]") are skipped; used_memory is MiB → bytes. Pure: tests run
// everywhere.
func parseNvidiaSmiOutput(output string) map[int]int64 {
	out := map[int]int64{}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if line == "" {
			continue
		}
		pidStr, memStr, ok := strings.Cut(line, ",")
		if !ok {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSpace(pidStr))
		if err != nil || pid <= 0 {
			continue
		}
		bytes, ok := parseSmiMiB(memStr)
		if !ok {
			continue // "[N/A]" and friends
		}
		out[pid] = bytes
	}
	return out
}

// parseNvidiaGpuTotals parses the CSV of
// "nvidia-smi --query-gpu=index,memory.total --format=csv,noheader,nounits":
// one "index, MiB" row per GPU on the box. Unparsable rows are skipped;
// memory.total is MiB → bytes. Pure: tests run everywhere.
func parseNvidiaGpuTotals(output string) map[int]int64 {
	out := map[int]int64{}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if line == "" {
			continue
		}
		idxStr, memStr, ok := strings.Cut(line, ",")
		if !ok {
			continue
		}
		idx, err := strconv.Atoi(strings.TrimSpace(idxStr))
		if err != nil || idx < 0 {
			continue
		}
		bytes, ok := parseSmiMiB(memStr)
		if !ok {
			continue // "[N/A]" and friends
		}
		out[idx] = bytes
	}
	return out
}
