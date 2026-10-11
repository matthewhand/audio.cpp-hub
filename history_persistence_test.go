package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type failingHistoryWriter struct {
	writeErr error
	closeErr error
	short    bool
}

func (w *failingHistoryWriter) Write(p []byte) (int, error) {
	if w.writeErr != nil {
		return 0, w.writeErr
	}
	if w.short {
		return len(p) - 1, nil
	}
	return len(p), nil
}
func (w *failingHistoryWriter) Close() error { return w.closeErr }

func TestRecordTTSPersistenceFailuresDoNotIndex(t *testing.T) {
	cases := []struct {
		name   string
		writer *failingHistoryWriter
		want   string
	}{
		{"write", &failingHistoryWriter{writeErr: errors.New("injected write error")}, "write history index"},
		{"short-write", &failingHistoryWriter{short: true}, "write history index"},
		{"close", &failingHistoryWriter{closeErr: errors.New("injected close error")}, "close history index"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Chdir(t.TempDir())
			m := NewHistoryManager()
			m.openIndexFile = func(string) (io.WriteCloser, error) { return tc.writer, nil }
			inst := &Instance{ID: "instance", Name: "tts", ModelID: "index_tts2"}
			err := m.RecordTTS(inst, map[string]any{"text": "hello"}, "task-1", nil, "")
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("RecordTTS error = %v, expected %s", err, tc.want)
			}
			if got := len(m.index[inst.ModelID]); got != 0 {
				t.Fatalf("phantom in-memory history records: %d", got)
			}
		})
	}
}

func TestRecordTTSIndexOpenFailureDoesNotIndex(t *testing.T) {
	t.Chdir(t.TempDir())
	m := NewHistoryManager()
	dir := historyDir("index_tts2")
	if err := os.MkdirAll(filepath.Join(dir, historyIndexFile), 0755); err != nil {
		t.Fatal(err)
	}
	err := m.RecordTTS(&Instance{ModelID: "index_tts2", Name: "tts"}, nil, "task-1", nil, "")
	if err == nil || !strings.Contains(err.Error(), "open history index") {
		t.Fatalf("expected index open failure, got %v", err)
	}
	if len(m.index["index_tts2"]) != 0 {
		t.Fatal("history index changed despite open error")
	}
}

func TestRecordTTSPersistsBeforeIndexing(t *testing.T) {
	t.Chdir(t.TempDir())
	m := NewHistoryManager()
	inst := &Instance{ID: "instance", Name: "tts", ModelID: "index_tts2"}
	if err := m.RecordTTS(inst, map[string]any{"text": "hello"}, "task-1", nil, ""); err != nil {
		t.Fatal(err)
	}
	if len(m.index[inst.ModelID]) != 1 {
		t.Fatal("missing in-memory history entry")
	}
	raw, err := os.ReadFile(filepath.Join(historyDir(inst.ModelID), historyIndexFile))
	if err != nil {
		t.Fatal(err)
	}
	var rec map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(raw))), &rec); err != nil {
		t.Fatal(err)
	}
	if rec["taskId"] != "task-1" {
		t.Fatalf("wrong on-disk history: %v", rec)
	}
}

func TestFinalizeTTSPropagatesHistoryWriteFailure(t *testing.T) {
	t.Chdir(t.TempDir())
	hist := NewHistoryManager()
	inst := &Instance{ID: "instance", Name: "tts", ModelID: "index_tts2"}
	dir := historyDir(inst.ModelID)
	if err := os.MkdirAll(filepath.Join(dir, historyIndexFile), 0755); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(map[string]any{"audio": base64.StdEncoding.EncodeToString(minimalWAV())})
	if err != nil {
		t.Fatal(err)
	}
	tmp := filepath.Join(dir, "task-1.resp.tmp")
	if err := os.WriteFile(tmp, payload, 0644); err != nil {
		t.Fatal(err)
	}
	result, errMsg := finalizeTTS(hist, inst, map[string]any{"text": "test"}, "task-1", tmp)
	if result == nil {
		t.Fatal("successful WAV extraction must not be discarded")
	}
	if !strings.Contains(errMsg, "历史记录落盘失败") {
		t.Fatalf("history error not propagated: %q", errMsg)
	}
	if len(hist.index[inst.ModelID]) != 0 {
		t.Fatal("phantom history record after failed finalization")
	}
	if _, err := os.Stat(filepath.Join(dir, "task-1.wav")); err != nil {
		t.Fatalf("audio asset must be preserved: %v", err)
	}
}
