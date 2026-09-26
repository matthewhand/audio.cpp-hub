package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestFinalizeTTS 覆盖同步/异步共用的 TTS 收尾逻辑：缺失/空音频的错误态与成功态。
func TestFinalizeTTS(t *testing.T) {
	chdirTemp(t)
	// 注意：NewHistoryManager 的 replay 会清扫残留 .resp.tmp，须先建管理器再落临时文件。
	hist := NewHistoryManager()
	dir := filepath.Join("data", "history", "index_tts2")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	inst := &Instance{ID: "i1", Name: "tts", ModelID: "index_tts2"}

	// 成功：合法 base64 WAV → result 填充、wav 落盘、errMsg 为空。
	okTmp := filepath.Join(dir, "ok.resp.tmp")
	payload, _ := json.Marshal(map[string]any{"audio": base64.StdEncoding.EncodeToString(minimalWAV())})
	if err := os.WriteFile(okTmp, payload, 0644); err != nil {
		t.Fatal(err)
	}
	result, errMsg := finalizeTTS(hist, inst, map[string]any{"text": "hi"}, "ok", okTmp)
	if errMsg != "" {
		t.Fatalf("成功路径 errMsg=%q，期望空", errMsg)
	}
	if result == nil || result["file"] != "ok.wav" {
		t.Fatalf("成功路径 result=%v", result)
	}
	if result["sampleRate"] != 8000 || result["channels"] != 1 {
		t.Fatalf("WAV 元数据错误: %v", result)
	}
	if !isRegularFile(filepath.Join(dir, "ok.wav")) {
		t.Fatalf("成功路径应写出 wav")
	}

	// 失败：临时文件缺失 → errMsg 非空且 result 为 nil。
	if result, errMsg = finalizeTTS(hist, inst, nil, "missing", filepath.Join(dir, "missing.resp.tmp")); errMsg == "" || result != nil {
		t.Fatalf("缺失临时文件应失败: result=%v errMsg=%q", result, errMsg)
	} else if !strings.Contains(errMsg, "结果音频提取失败") {
		t.Fatalf("错误文案不符: %q", errMsg)
	}

	// 空音频：响应无 "audio" 字段 → 专用文案、result 为 nil。
	emptyTmp := filepath.Join(dir, "empty.resp.tmp")
	if err := os.WriteFile(emptyTmp, []byte(`{"text":"no audio here"}`), 0644); err != nil {
		t.Fatal(err)
	}
	if result, errMsg = finalizeTTS(hist, inst, nil, "empty", emptyTmp); errMsg != "响应中未找到音频数据" || result != nil {
		t.Fatalf("空音频应返回固定文案: result=%v errMsg=%q", result, errMsg)
	}

	// 非字符串 audio：同样按未找到处理，不得 panic。
	numTmp := filepath.Join(dir, "num.resp.tmp")
	if err := os.WriteFile(numTmp, []byte(`{"audio":123}`), 0644); err != nil {
		t.Fatal(err)
	}
	if result, errMsg = finalizeTTS(hist, inst, nil, "num", numTmp); errMsg != "响应中未找到音频数据" || result != nil {
		t.Fatalf("非字符串 audio 应按未找到处理: result=%v errMsg=%q", result, errMsg)
	}
}
