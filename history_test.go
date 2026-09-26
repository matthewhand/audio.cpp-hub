package main

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// minimalWAV 返回一个可通过 wav.ParseReader 校验的最小 PCM WAV（8kHz/16bit 单声道）。
func minimalWAV() []byte {
	data := []byte{1, 2, 3, 4}
	buf := make([]byte, 0, 44+len(data))
	buf = append(buf, "RIFF"...)
	buf = binary.LittleEndian.AppendUint32(buf, uint32(36+len(data)))
	buf = append(buf, "WAVE"...)
	buf = append(buf, "fmt "...)
	buf = binary.LittleEndian.AppendUint32(buf, 16)
	buf = binary.LittleEndian.AppendUint16(buf, 1)    // audioFormat PCM
	buf = binary.LittleEndian.AppendUint16(buf, 1)    // channels
	buf = binary.LittleEndian.AppendUint32(buf, 8000) // sampleRate
	buf = binary.LittleEndian.AppendUint32(buf, 8000) // byteRate
	buf = binary.LittleEndian.AppendUint16(buf, 1)    // blockAlign
	buf = binary.LittleEndian.AppendUint16(buf, 8)    // bitsPerSample
	buf = append(buf, "data"...)
	buf = binary.LittleEndian.AppendUint32(buf, uint32(len(data)))
	buf = append(buf, data...)
	return buf
}

// TestSnapshotRefAudiosRejectsUntrustedSources 覆盖 #5：非受管目录、受管目录内的非 WAV
// 均不得复制进历史，受管目录内的合法 WAV 才允许快照。
func TestSnapshotRefAudiosRejectsUntrustedSources(t *testing.T) {
	tmp := t.TempDir()
	t.Chdir(tmp)

	histDir := filepath.Join(tmp, "data", "history", "m")
	if err := os.MkdirAll(histDir, 0755); err != nil {
		t.Fatal(err)
	}
	uploads := filepath.Join(tmp, "data", "uploads")
	if err := os.MkdirAll(uploads, 0755); err != nil {
		t.Fatal(err)
	}

	secret := filepath.Join(tmp, "secret.txt")
	if err := os.WriteFile(secret, []byte("top secret"), 0644); err != nil {
		t.Fatal(err)
	}
	goodWAV := filepath.Join(uploads, "good.wav")
	if err := os.WriteFile(goodWAV, minimalWAV(), 0644); err != nil {
		t.Fatal(err)
	}
	fakeWAV := filepath.Join(uploads, "fake.wav")
	if err := os.WriteFile(fakeWAV, []byte("not a wav at all"), 0644); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name    string
		path    string
		wantRef bool
	}{
		{"非受管目录被拒绝", secret, false},
		{"受管目录内非 WAV 被拒绝", fakeWAV, false},
		{"受管目录内 WAV 允许", goodWAV, true},
		{"不存在的路径被拒绝", filepath.Join(tmp, "nope.wav"), false},
	}
	for i, tc := range cases {
		rec := map[string]any{}
		snapshotRefAudios(histDir, "t"+itoa(i), map[string]any{"voice_ref": tc.path}, rec)
		_, got := rec["refs"]
		if got != tc.wantRef {
			t.Errorf("%s: refs=%v，期望 %v", tc.name, rec["refs"], tc.wantRef)
		}
	}

	// 回归：/etc/hostname 作为 voice_ref 不产生任何可读快照。
	if _, err := os.Stat("/etc/hostname"); err == nil {
		rec := map[string]any{}
		snapshotRefAudios(histDir, "ty", map[string]any{"voice_ref": "/etc/hostname"}, rec)
		if _, ok := rec["refs"]; ok {
			t.Errorf("/etc/hostname 不应产生 refs: %v", rec["refs"])
		}
		if isRegularFile(filepath.Join(histDir, "ty.ref.wav")) {
			t.Errorf("/etc/hostname 不应产生快照文件")
		}
	}
}

// TestRefAudioPathRequiresRecord 覆盖 #5：文件存在但索引无记录时不得返回路径。
func TestRefAudioPathRequiresRecord(t *testing.T) {
	tmp := t.TempDir()
	t.Chdir(tmp)

	m := NewHistoryManager()
	dir := filepath.Join(tmp, "data", "history", "m")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "t.ref.wav"), minimalWAV(), 0644); err != nil {
		t.Fatal(err)
	}
	if p := m.RefAudioPath("m", "t", "ref"); p != "" {
		t.Errorf("无记录时不应返回路径: %s", p)
	}
}

// TestHistoryGetListDoNotEscapeLock 覆盖 #13：并发读 Get/List 与分组写不得触发
// map 读写竞态（配合 -race 运行）。
func TestHistoryGetListDoNotEscapeLock(t *testing.T) {
	tmp := t.TempDir()
	t.Chdir(tmp)

	m := NewHistoryManager()
	if err := os.MkdirAll(filepath.Join(tmp, "data", "history", "m"), 0755); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	m.index["m"] = []map[string]any{{
		"taskId": "t",
		"text":   "hello",
		"result": map[string]any{"durationSec": 1.0, "size": 2.0},
	}}
	m.mu.Unlock()

	var wg sync.WaitGroup
	for i := 0; i < 200; i++ {
		wg.Add(3)
		go func() {
			defer wg.Done()
			if rec := m.Get("m", "t"); rec != nil {
				_ = rec["text"]
			}
		}()
		go func() { defer wg.Done(); _ = m.List("m") }()
		go func() { defer wg.Done(); m.SetRecordGroup("m", "t", "") }()
	}
	wg.Wait()
}
