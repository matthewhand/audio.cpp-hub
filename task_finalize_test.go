package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
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

func TestFinalizeKokoroTimestamps(t *testing.T) {
	chdirTemp(t)
	history := NewHistoryManager()
	const words = `[{"word":"həlˈO","start_sample":0,"end_sample":300,"confidence":0},{"word":"wˈɜɹld","start_sample":300,"end_sample":600,"confidence":0}]`
	audio := `"audio":"` + base64.StdEncoding.EncodeToString(minimalWAV()) + `"`
	for _, tc := range []struct {
		name, model, response string
		wantWords             bool
	}{
		{"after-audio", "kokoro_tts", "{" + audio + `,"words":` + words + "}", true},
		{"before-audio", "kokoro_tts", `{"words":` + words + "," + audio + "}", true},
		{"absent", "kokoro_tts", "{" + audio + "}", false},
		{"empty", "kokoro_tts", "{" + audio + `,"words":[]}`, false},
		{"malformed", "kokoro_tts", "{" + audio + `,"words":[{"word":"test","end_sample":20}]}`, false},
		{"wrong-shape-first", "kokoro_tts", `{"words":{} ,` + audio + "}", false},
		{"truncated", "kokoro_tts", "{" + audio + `,"words":[`, false},
		{"unrelated-model", "index_tts2", "{" + audio + `,"words":` + words + "}", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := historyDir(tc.model)
			if err := os.MkdirAll(dir, 0755); err != nil {
				t.Fatal(err)
			}
			tmp := filepath.Join(dir, tc.name+".json")
			if err := os.WriteFile(tmp, []byte(tc.response), 0644); err != nil {
				t.Fatal(err)
			}
			inst := &Instance{Name: "tts", ModelID: tc.model}
			taskResult, errMsg := finalizeTTS(history, inst, nil, tc.name, tmp)
			if errMsg != "" || taskResult["words"] != nil || history.AudioPath(tc.model, tc.name) == "" {
				t.Fatalf("task result = %v, error = %q", taskResult, errMsg)
			}
			for _, manager := range []*HistoryManager{history, NewHistoryManager()} {
				rec := manager.Get(tc.model, tc.name)
				result, ok := rec["result"].(map[string]any)
				if !ok || result["sampleRate"] != float64(8000) {
					t.Fatalf("history result = %v", result)
				}
				got, exists := result["words"]
				if exists != tc.wantWords {
					t.Fatalf("words = %v, want presence %v", got, tc.wantWords)
				}
				if exists {
					var expected any
					if err := json.Unmarshal([]byte(words), &expected); err != nil {
						t.Fatal(err)
					}
					if !reflect.DeepEqual(got, expected) {
						t.Fatalf("words = %v, want %v", got, expected)
					}
				}
				list := manager.List(tc.model)
				if list[0]["result"].(map[string]any)["words"] != nil {
					t.Fatalf("history summary contains words: %v", list[0])
				}
			}
		})
	}
}
