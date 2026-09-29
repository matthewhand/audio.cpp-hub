package main

import (
	"math"
	"net/http"
	"sort"
	"time"
)

// stats.go — usage & performance statistics (GET /api/stats).
//
// Deliberately derives from data that is already persisted: no new capture
// points, no schema migration.
//   - The history index (data/history/<modelId>/index.jsonl) is the long-term,
//     never-evicted asset. It supplies the usage figures: task counts, success
//     rate, total generated audio seconds and bytes.
//   - The in-memory TaskManager keeps the most recent `finishedKeep` finished
//     tasks with their three timestamps, and supplies the performance figures:
//     queue wait, run time and real-time factor (RTF).
//
// RTF = run seconds / generated-audio seconds. Lower is faster; below 1 means
// faster than real time. Only tasks that have both StartedAt/FinishedAt and
// result.durationSec are counted.

// modelStats holds the aggregate figures for a single model.
type modelStats struct {
	ModelID      string `json:"modelId"`
	InstanceName string `json:"instanceName,omitempty"`
	Category     string `json:"category,omitempty"`

	// Usage (from the never-evicted history index)
	Total        int     `json:"total"`       // history records, failures included
	OK           int     `json:"ok"`          // succeeded
	Failed       int     `json:"failed"`      // failed
	SuccessRate  float64 `json:"successRate"` // ok / total, 0..1
	AudioSeconds float64 `json:"audioSeconds"`
	OutputBytes  int64   `json:"outputBytes"`
	LastAt       int64   `json:"lastAt"` // most recent timestamp (ms)

	// Performance (from in-memory task timestamps + result.durationSec)
	QueueMsP50     float64 `json:"queueMsP50"` // median queue wait (ms)
	RunMsP50       float64 `json:"runMsP50"`   // median run time (ms)
	RunMsP95       float64 `json:"runMsP95"`   // P95 run time (ms)
	RTFP50         float64 `json:"rtfP50"`     // median real-time factor
	SamplesForPerf int     `json:"samplesForPerf"`
}

// statsResponse is the /api/stats response body.
type statsResponse struct {
	GeneratedAt int64        `json:"generatedAt"`
	Totals      statsTotals  `json:"totals"`
	Models      []modelStats `json:"models"`
}

type statsTotals struct {
	Models       int     `json:"models"`
	Total        int     `json:"total"`
	OK           int     `json:"ok"`
	Failed       int     `json:"failed"`
	SuccessRate  float64 `json:"successRate"`
	AudioSeconds float64 `json:"audioSeconds"`
	OutputBytes  int64   `json:"outputBytes"`
}

// handleStats returns the per-model usage and performance aggregate.
func (h *Hub) handleStats(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.Stats())
}

// Stats aggregates history (usage) and tasks (performance), grouped by model.
func (h *Hub) Stats() statsResponse {
	byModel := map[string]*modelStats{}

	// Usage: the history index (never evicted). One directory per modelId,
	// records ordered oldest -> newest.
	for modelID, recs := range h.history.Snapshot() {
		ms := byModel[modelID]
		if ms == nil {
			ms = &modelStats{ModelID: modelID}
			byModel[modelID] = ms
		}
		for _, rec := range recs {
			ms.Total++
			if ok, _ := rec["ok"].(bool); ok {
				ms.OK++
			} else {
				ms.Failed++
			}
			if ms.InstanceName == "" {
				if name, _ := rec["instanceName"].(string); name != "" {
					ms.InstanceName = name
				}
			}
			if ms.Category == "" {
				if cat, _ := rec["category"].(string); cat != "" {
					ms.Category = cat
				}
			}
			if t, ok := toInt64(rec["time"]); ok && t > ms.LastAt {
				ms.LastAt = t
			}
			if res, ok := rec["result"].(map[string]any); ok {
				if d, ok := toFloat(res["durationSec"]); ok {
					ms.AudioSeconds += d
				}
				if b, ok := toInt64(res["size"]); ok {
					ms.OutputBytes += b
				}
			}
		}
	}

	// Performance: in-memory tasks (they carry timestamps). Collect samples
	// per modelId, then take percentiles.
	type sample struct {
		queueMs float64
		runMs   float64
		rtf     float64
		hasRtf  bool
	}
	samples := map[string][]sample{}
	for _, t := range h.tasks.Snapshot() {
		if t.StartedAt == nil || t.FinishedAt == nil {
			continue
		}
		s := sample{
			queueMs: float64(*t.StartedAt - t.CreatedAt),
			runMs:   float64(*t.FinishedAt - *t.StartedAt),
		}
		if t.Result != nil {
			if d, ok := toFloat(t.Result["durationSec"]); ok && d > 0 {
				s.rtf = (s.runMs / 1000) / d
				s.hasRtf = true
			}
		}
		samples[t.ModelID] = append(samples[t.ModelID], s)
	}
	for modelID, list := range samples {
		ms := byModel[modelID]
		if ms == nil {
			ms = &modelStats{ModelID: modelID}
			byModel[modelID] = ms
		}
		queue := make([]float64, 0, len(list))
		run := make([]float64, 0, len(list))
		rtf := make([]float64, 0, len(list))
		for _, s := range list {
			queue = append(queue, s.queueMs)
			run = append(run, s.runMs)
			if s.hasRtf {
				rtf = append(rtf, s.rtf)
			}
		}
		ms.SamplesForPerf = len(list)
		ms.QueueMsP50 = round3(percentile(queue, 50))
		ms.RunMsP50 = round3(percentile(run, 50))
		ms.RunMsP95 = round3(percentile(run, 95))
		ms.RTFP50 = round3(percentile(rtf, 50))
	}

	out := statsResponse{GeneratedAt: time.Now().UnixMilli()}
	models := make([]modelStats, 0, len(byModel))
	for _, ms := range byModel {
		if ms.Total > 0 {
			ms.SuccessRate = round3(float64(ms.OK) / float64(ms.Total))
		}
		ms.AudioSeconds = round3(ms.AudioSeconds)
		models = append(models, *ms)
	}
	// Heaviest usage first, then most recently used.
	sort.SliceStable(models, func(i, j int) bool {
		if models[i].Total != models[j].Total {
			return models[i].Total > models[j].Total
		}
		return models[i].LastAt > models[j].LastAt
	})
	out.Models = models
	out.Totals.Models = len(models)
	for _, ms := range models {
		out.Totals.Total += ms.Total
		out.Totals.OK += ms.OK
		out.Totals.Failed += ms.Failed
		out.Totals.AudioSeconds += ms.AudioSeconds
		out.Totals.OutputBytes += ms.OutputBytes
	}
	out.Totals.AudioSeconds = round3(out.Totals.AudioSeconds)
	if out.Totals.Total > 0 {
		out.Totals.SuccessRate = round3(float64(out.Totals.OK) / float64(out.Totals.Total))
	}
	return out
}

// Snapshot returns a shallow copy of the history index (modelId -> copy of the
// record slice) so aggregation can run outside the lock.
func (m *HistoryManager) Snapshot() map[string][]map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string][]map[string]any, len(m.index))
	for k, v := range m.index {
		cp := make([]map[string]any, len(v))
		copy(cp, v)
		out[k] = cp
	}
	return out
}

// Snapshot returns a snapshot of every task (including finished ones) so
// aggregation can run outside the lock.
func (m *TaskManager) Snapshot() []Task {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Task, 0, len(m.tasks))
	for _, t := range m.tasks {
		out = append(out, *t)
	}
	return out
}

// percentile returns a linearly interpolated percentile (p in 0..100) over a
// sorted copy of vals. Returns 0 for an empty set.
func percentile(vals []float64, p float64) float64 {
	if len(vals) == 0 {
		return 0
	}
	sorted := make([]float64, len(vals))
	copy(sorted, vals)
	sort.Float64s(sorted)
	if len(sorted) == 1 {
		return sorted[0]
	}
	rank := (p / 100) * float64(len(sorted)-1)
	lo := int(math.Floor(rank))
	hi := int(math.Ceil(rank))
	if lo < 0 {
		lo = 0
	}
	if hi >= len(sorted) {
		hi = len(sorted) - 1
	}
	frac := rank - float64(lo)
	return sorted[lo] + frac*(sorted[hi]-sorted[lo])
}

func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	default:
		return 0, false
	}
}

func toInt64(v any) (int64, bool) {
	f, ok := toFloat(v)
	if !ok {
		return 0, false
	}
	return int64(f), true
}
