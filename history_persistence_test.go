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

// Persist only the first half of an index record, simulating a short disk append.
type partialDiskHistoryWriter struct{ file *os.File }

func (w *partialDiskHistoryWriter) Write(p []byte) (int, error) { return w.file.Write(p[:len(p)/2]) }
func (w *partialDiskHistoryWriter) Close() error                { return w.file.Close() }

func TestRecordTTSShortAppendDoesNotCorruptLaterReplay(t *testing.T) {
	t.Chdir(t.TempDir())
	m := NewHistoryManager()
	inst := &Instance{ID: "instance", Name: "tts", ModelID: "index_tts2"}
	add := func(id string) error { return m.RecordTTS(inst, map[string]any{"text": id}, id, nil, "") }
	if err := add("task-1"); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(historyDir(inst.ModelID), historyIndexFile)
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	m.openIndexFile = func(path string) (io.WriteCloser, error) {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
		if err != nil {
			return nil, err
		}
		return &partialDiskHistoryWriter{f}, nil
	}
	if err := add("task-2"); !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("short append must return ErrShortWrite: %v", err)
	}
	m.openIndexFile = nil
	if err := add("task-3"); err != nil {
		t.Fatalf("healthy append following short write: %v", err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(after), string(original)) {
		t.Fatal("preexisting valid history bytes were modified")
	}
	// The damaged fragment remains untouched, while the next line is valid JSON.
	lines := strings.Split(strings.TrimSuffix(string(after), "\n"), "\n")
	if len(lines) != 3 || !strings.HasPrefix(lines[2], "{") {
		t.Fatalf("expected original, damaged fragment, then clean record: %q", after)
	}
	var third map[string]any
	if err := json.Unmarshal([]byte(lines[2]), &third); err != nil || third["taskId"] != "task-3" {
		t.Fatalf("healthy record following damaged fragment is unreadable: %v, %#v", err, third)
	}
	replayed := NewHistoryManager()
	rows := replayed.index[inst.ModelID]
	if len(rows) != 2 || rows[0]["taskId"] != "task-1" || rows[1]["taskId"] != "task-3" {
		t.Fatalf("replay must keep first and later good records, got: %#v", rows)
	}
	if got := len(m.index[inst.ModelID]); got != 2 {
		t.Fatalf("short write exposed a phantom record: %d", got)
	}
}
