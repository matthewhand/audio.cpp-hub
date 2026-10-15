package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestHistoryGroupAndDeletePreserveDamagedJSONL(t *testing.T) {
	t.Chdir(t.TempDir())
	dir := historyDir("synthetic")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, historyIndexFile)
	damaged := []byte("INCOMPLETE-\xff-JSON\n")
	original := append([]byte("{\"taskId\":\"a\",\"text\":\"one\"}\n"), damaged...)
	original = append(original, []byte("{\"taskId\":\"b\",\"text\":\"two\"}\n")...)
	original = append(original, []byte("PARTIAL-TAIL-\x00")...)
	if err := os.WriteFile(path, original, 0644); err != nil {
		t.Fatal(err)
	}

	h := NewHistoryManager()
	if got := len(h.index["synthetic"]); got != 2 {
		t.Fatalf("replay: %d valid records", got)
	}
	group, err := h.CreateGroup("synthetic", "Fictional group")
	if err != nil {
		t.Fatal(err)
	}
	gid := group["id"].(string)
	if ok, err := h.SetRecordGroup("synthetic", "a", gid); !ok || err != nil {
		t.Fatalf("assign: %v, %v", ok, err)
	}
	check := func(stage string, expected []string) {
		t.Helper()
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%s: %v", stage, err)
		}
		if !bytes.Contains(data, damaged) || !bytes.HasSuffix(data, []byte("PARTIAL-TAIL-\x00")) {
			t.Fatalf("%s: damaged bytes lost: %q", stage, data)
		}
		for _, id := range expected {
			if !bytes.Contains(data, []byte("\"taskId\":\""+id+"\"")) {
				t.Fatalf("%s: lost record %s", stage, id)
			}
		}
		var count int
		for _, line := range bytes.Split(data, []byte{'\n'}) {
			var rec map[string]any
			if err := json.Unmarshal(line, &rec); err == nil && rec != nil {
				count++
			}
		}
		if count != len(expected) {
			t.Fatalf("%s: valid rows=%d, want=%d", stage, count, len(expected))
		}
	}
	check("assign", []string{"a", "b"})
	if got := NewHistoryManager().Get("synthetic", "a"); got == nil || got["groupId"] != gid {
		t.Fatalf("group assignment not durable: %#v", got)
	}
	if !h.DeleteGroup("synthetic", gid) {
		t.Fatal("delete group failed")
	}
	check("delete-group", []string{"a", "b"})
	if !h.Delete("synthetic", "b") {
		t.Fatal("delete record failed")
	}
	check("delete-record", []string{"a"})
	if got := NewHistoryManager().Get("synthetic", "a"); got == nil || got["groupId"] != nil {
		t.Fatalf("group deletion not replayed: %#v", got)
	}
}

func TestHistoryLastValidDeletionRetainsCorruptFragment(t *testing.T) {
	t.Chdir(t.TempDir())
	dir := historyDir("synthetic")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, historyIndexFile)
	fragment := []byte("NONJSON-\x00-no-newline")
	initial := append([]byte("{\"taskId\":\"only\"}\n"), fragment...)
	if err := os.WriteFile(path, initial, 0644); err != nil {
		t.Fatal(err)
	}
	h := NewHistoryManager()
	if !h.Delete("synthetic", "only") {
		t.Fatal("delete valid record failed")
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("corrupt-only file removed: %v", err)
	}
	if !bytes.Equal(got, fragment) {
		t.Fatalf("fragment modified: %q", got)
	}
	if err := h.RecordTTS(&Instance{ModelID: "synthetic", Name: "fixture"}, map[string]any{"text": "new"}, "healthy", nil, ""); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(after, append(append([]byte{}, fragment...), '\n')) {
		t.Fatalf("append overwrote fragment: %q", after)
	}
	if got := NewHistoryManager().Get("synthetic", "healthy"); got == nil {
		t.Fatal("healthy append unreadable")
	}
}

func TestHistoryRewriteFailureDoesNotReportSuccessOrDeleteAssets(t *testing.T) {
	t.Chdir(t.TempDir())
	dir := historyDir("synthetic")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, historyIndexFile)
	if err := os.WriteFile(path, []byte("{\"taskId\":\"a\",\"groupId\":\"fictional-group\"}\n"), 0644); err != nil {
		t.Fatal(err)
	}
	h := NewHistoryManager()
	if err := os.WriteFile(filepath.Join(dir, historyGroupsFile), []byte("[{\"id\":\"fictional-group\",\"name\":\"Test\"}]"), 0644); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"a.wav", "a.ref.wav"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("fictional-audio"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	// Simulate an unreadable/invalid index path after replay, without touching production files.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0755); err != nil {
		t.Fatal(err)
	}
	if ok, err := h.SetRecordGroup("synthetic", "a", ""); ok || err == nil {
		t.Fatalf("assignment falsely succeeded: ok=%v err=%v", ok, err)
	}
	if got := h.Get("synthetic", "a"); got == nil || got["groupId"] != "fictional-group" {
		t.Fatalf("failed assignment changed in-memory group: %v", got)
	}
	if h.DeleteGroup("synthetic", "fictional-group") {
		t.Fatal("group removal falsely succeeded")
	}
	if len(h.ListGroups("synthetic")) != 1 {
		t.Fatal("group removed despite failure")
	}
	if h.Delete("synthetic", "a") {
		t.Fatal("record deletion falsely succeeded")
	}
	if h.Get("synthetic", "a") == nil {
		t.Fatal("failed deletion lost in-memory record")
	}
	for _, name := range []string{"a.wav", "a.ref.wav"} {
		got, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil || string(got) != "fictional-audio" {
			t.Fatalf("asset removed: %s, %q, %v", name, got, err)
		}
	}
}
