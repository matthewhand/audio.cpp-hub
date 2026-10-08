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
//   - rolling per-instance stats (current / peak / time-weighted average)
//     surfaced on GET /api/instances as the optional "memory" object;
//   - per-task peaks (TaskManager.NoteInstanceSample) that land on the task
//     record as peakRamBytes / peakVramBytes;
//   - "instance.memory" push events for busy instances (SSE).
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
	for _, sm := range samples {
		s.record(sm.instanceID, now, sm.ram, sm.vram, sm.vramKnown, sm.source)
	}
}

// record applies one sample: rolling stats, per-task peaks, and (for busy
// instances) an instance.memory push event.
func (s *MemorySampler) record(instanceID string, now time.Time, ram, vram int64, vramKnown bool, source string) {
	s.mu.Lock()
	st := s.state[instanceID]
	if st == nil {
		st = &memRolling{}
		s.state[instanceID] = st
	}
	busy := s.busy[instanceID]
	st.addSample(now, ram, vram, vramKnown, source)
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
// VRAM was never measured). Must never error because of sampling.
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
	if st.vramKnown {
		out["vramBytes"] = st.lastVRAM
		out["vramPeakBytes"] = st.peakVRAM
		out["vramAvgBytes"] = st.vramAvg()
		out["vramSource"] = st.vramSource
	}
	return out
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
type memRolling struct {
	lastRAM      int64
	lastVRAM     int64
	vramKnown    bool   // sticky: a failed VRAM probe keeps the last known value
	vramSource   string // "drm" | "nvidia-smi"
	peakRAM      int64
	peakVRAM     int64
	ramIntegral  float64 // byte·ms
	vramIntegral float64 // byte·ms
	spanMs       float64 // RAM weighting span
	vramSpanMs   float64 // only intervals where VRAM was already known
	samples      int
	lastTime     time.Time
	hasSample    bool
}

func (r *memRolling) addSample(now time.Time, ram, vram int64, vramKnown bool, source string) {
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
	r.lastTime = now
	r.samples++
	r.hasSample = true
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
		memStr = strings.TrimSpace(memStr)
		if i := strings.IndexAny(memStr, " \t"); i > 0 {
			memStr = memStr[:i] // tolerate a "3690 MiB" suffix
		}
		mib, err := strconv.ParseFloat(memStr, 64)
		if err != nil {
			continue // "[N/A]" and friends
		}
		out[pid] = int64(mib * 1024 * 1024)
	}
	return out
}
