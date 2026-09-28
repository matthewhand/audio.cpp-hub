package main

import (
	"math"
	"net/http"
	"sort"
	"time"
)

// stats.go — 用量与性能统计（GET /api/stats）。
//
// 数据来源刻意复用既有持久化，不新增采集点、不迁移 schema：
//   - 历史索引（data/history/<modelId>/index.jsonl）是**无淘汰**的长期资产，
//     用于用量口径：任务数、成功率、生成音频总时长/总字节；
//   - 内存中的 TaskManager 保留最近 finishedKeep 条已完成任务，带三个时间戳，
//     用于性能口径：排队等待、执行耗时、实时率（RTF）。
//
// RTF = 执行秒数 / 生成音频秒数（越小越快；<1 表示比实时快）。
// 仅对同时具备 StartedAt/FinishedAt 与 result.durationSec 的任务计入。

// modelStats 单个模型的聚合结果。
type modelStats struct {
	ModelID      string `json:"modelId"`
	InstanceName string `json:"instanceName,omitempty"`
	Category     string `json:"category,omitempty"`

	// 用量（来自历史索引，无淘汰）
	Total        int     `json:"total"`       // 历史记录总数（含失败）
	OK           int     `json:"ok"`          // 成功数
	Failed       int     `json:"failed"`      // 失败数
	SuccessRate  float64 `json:"successRate"` // ok / total，0..1
	AudioSeconds float64 `json:"audioSeconds"`
	OutputBytes  int64   `json:"outputBytes"`
	LastAt       int64   `json:"lastAt"` // 最近一次时间戳（ms）

	// 性能（来自内存任务的时间戳 + result.durationSec）
	QueueMsP50     float64 `json:"queueMsP50"` // 排队等待中位数（ms）
	RunMsP50       float64 `json:"runMsP50"`   // 执行耗时中位数（ms）
	RunMsP95       float64 `json:"runMsP95"`   // 执行耗时 P95（ms）
	RTFP50         float64 `json:"rtfP50"`     // 实时率中位数
	SamplesForPerf int     `json:"samplesForPerf"`
}

// statsResponse 是 /api/stats 的响应体。
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

// handleStats 返回按模型聚合的用量与性能统计。
func (h *Hub) handleStats(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.Stats())
}

// Stats 聚合历史（用量）与任务（性能），按模型分组。
func (h *Hub) Stats() statsResponse {
	byModel := map[string]*modelStats{}

	// 用量：历史索引（无淘汰）。每个 modelId 一个目录，记录旧→新。
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

	// 性能：内存任务（带时间戳）。按 modelId 收集样本后取分位数。
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
	// 用量大的在前，其次最近使用。
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

// Snapshot 返回历史索引的浅拷贝（modelId → 记录切片副本），锁外聚合。
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

// Snapshot 返回全部任务的快照（含已完成），锁外聚合用。
func (m *TaskManager) Snapshot() []Task {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Task, 0, len(m.tasks))
	for _, t := range m.tasks {
		out = append(out, *t)
	}
	return out
}

// percentile 返回已排序副本上的线性插值分位数（p 取 0..100）。空集返回 0。
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
