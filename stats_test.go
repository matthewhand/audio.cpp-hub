package main

import (
	"testing"
)

// TestStatsAggregatesHistoryAndTasks 覆盖 /api/stats 的核心聚合：
// 用量来自历史索引（无淘汰），性能来自内存任务的时间戳与 result.durationSec。
func TestStatsAggregatesHistoryAndTasks(t *testing.T) {
	t.Chdir(t.TempDir())

	h := NewHistoryManager()
	tm := NewTaskManager(h)
	hub := &Hub{history: h, tasks: tm}

	// 直接注入历史索引（等价于已落盘并 replay）：
	// model A 两条（1 成功 1 失败），model B 一条成功。
	h.mu.Lock()
	h.index["model-a"] = []map[string]any{
		{
			"taskId": "t1", "time": int64(1000), "instanceName": "instA", "category": "tts", "ok": true,
			"result": map[string]any{"durationSec": 2.0, "size": 1000},
		},
		{
			"taskId": "t2", "time": int64(2000), "instanceName": "instA", "category": "tts", "ok": false,
		},
	}
	h.index["model-b"] = []map[string]any{
		{
			"taskId": "t3", "time": int64(3000), "instanceName": "instB", "category": "tts", "ok": true,
			"result": map[string]any{"durationSec": 4.0, "size": 2000},
		},
	}
	h.mu.Unlock()

	// 任务：model-a 一条完成，排队 500ms、执行 1000ms、音频 2.0s → RTF 0.5。
	started := int64(1500)
	finished := int64(2500)
	tm.mu.Lock()
	tm.tasks["t1"] = &Task{
		ID: "t1", ModelID: "model-a", Category: "tts", Status: "DONE",
		CreatedAt: 1000, StartedAt: &started, FinishedAt: &finished,
		Result: map[string]any{"durationSec": 2.0, "size": 1000},
	}
	tm.mu.Unlock()

	got := hub.Stats()

	if got.Totals.Total != 3 {
		t.Fatalf("totals.total = %d, want 3", got.Totals.Total)
	}
	if got.Totals.OK != 2 || got.Totals.Failed != 1 {
		t.Fatalf("totals ok/failed = %d/%d, want 2/1", got.Totals.OK, got.Totals.Failed)
	}
	if got.Totals.AudioSeconds != 6.0 {
		t.Fatalf("totals.audioSeconds = %v, want 6", got.Totals.AudioSeconds)
	}
	if got.Totals.OutputBytes != 3000 {
		t.Fatalf("totals.outputBytes = %d, want 3000", got.Totals.OutputBytes)
	}
	// 成功率 2/3 → 0.667（round3）
	if got.Totals.SuccessRate != 0.667 {
		t.Fatalf("totals.successRate = %v, want 0.667", got.Totals.SuccessRate)
	}
	if len(got.Models) != 2 {
		t.Fatalf("models = %d, want 2", len(got.Models))
	}
	// 用量大的在前：model-a(2) 先于 model-b(1)
	if got.Models[0].ModelID != "model-a" {
		t.Fatalf("first model = %s, want model-a", got.Models[0].ModelID)
	}

	// 性能：model-a 一个样本 → queue=500, run=1000, rtf=0.5
	a := got.Models[0]
	if a.SamplesForPerf != 1 {
		t.Fatalf("model-a samples = %d, want 1", a.SamplesForPerf)
	}
	if a.QueueMsP50 != 500 {
		t.Fatalf("model-a queueP50 = %v, want 500", a.QueueMsP50)
	}
	if a.RunMsP50 != 1000 {
		t.Fatalf("model-a runP50 = %v, want 1000", a.RunMsP50)
	}
	if a.RTFP50 != 0.5 {
		t.Fatalf("model-a rtfP50 = %v, want 0.5", a.RTFP50)
	}
	// 失败那条计入了 total，但没有 result → 不计入 audioSeconds（保持 2.0）
	if a.AudioSeconds != 2.0 {
		t.Fatalf("model-a audioSeconds = %v, want 2", a.AudioSeconds)
	}
}

// TestPercentileInterpolates 覆盖分位数插值边界。
func TestPercentileInterpolates(t *testing.T) {
	cases := []struct {
		vals []float64
		p    float64
		want float64
	}{
		{nil, 50, 0},
		{[]float64{5}, 50, 5},
		{[]float64{1, 3}, 50, 2},
		{[]float64{1, 2, 3, 4}, 50, 2.5},
		{[]float64{1, 2, 3, 4}, 100, 4},
		{[]float64{1, 2, 3, 4}, 0, 1},
	}
	for _, c := range cases {
		if got := percentile(c.vals, c.p); got != c.want {
			t.Errorf("percentile(%v, %v) = %v, want %v", c.vals, c.p, got, c.want)
		}
	}
}
