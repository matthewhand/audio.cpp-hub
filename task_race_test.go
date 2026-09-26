package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// chdirTemp 把工作目录切到临时目录，避免测试写入仓库 data/。
func chdirTemp(t *testing.T) {
	t.Helper()
	old, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chdir(old) })
}

func portOf(t *testing.T, rawURL string) int {
	t.Helper()
	u, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	p, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func waitTerminal(t *testing.T, tm *TaskManager, id string, timeout time.Duration) map[string]any {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if v := tm.Get(id); v != nil {
			switch v["status"] {
			case "DONE", "FAILED", "CANCELLED":
				return v
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	return tm.Get(id)
}

// TestTaskSnapshotRace 并发 Submit 与 List/Get，验证不再直接序列化执行中的 live *Task。
func TestTaskSnapshotRace(t *testing.T) {
	chdirTemp(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	tm := NewTaskManager(NewHistoryManager())
	inst := &Instance{ID: "race-inst", Name: "race", ModelID: "nonexistent_model", Port: portOf(t, srv.URL)}

	stop := make(chan struct{})
	var wg sync.WaitGroup
	for g := 0; g < 4; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 30; i++ {
				select {
				case <-stop:
					return
				default:
				}
				tm.Submit(inst, map[string]any{"text": "hello"}, []byte(`{"text":"hello"}`))
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			list := tm.List(false, "")
			if len(list) > 0 {
				if id, _ := list[0]["id"].(string); id != "" {
					_ = tm.Get(id)
				}
			}
		}
	}()
	time.Sleep(400 * time.Millisecond)
	close(stop)
	wg.Wait()
}

// TestFailedTTSRecordsOnce 失败 TTS 只在历史中记录一次。
func TestFailedTTSRecordsOnce(t *testing.T) {
	chdirTemp(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()

	history := NewHistoryManager()
	tm := NewTaskManager(history)
	inst := &Instance{ID: "tts-inst", Name: "tts", ModelID: "index_tts2", Port: portOf(t, srv.URL)}

	task := tm.Submit(inst, map[string]any{"text": "你好"}, []byte(`{"text":"你好"}`))
	v := waitTerminal(t, tm, task.ID, 5*time.Second)
	if v["status"] != "FAILED" {
		t.Fatalf("期望 FAILED，实际 %v", v["status"])
	}

	data, err := os.ReadFile(filepath.Join("data", "history", "index_tts2", "index.jsonl"))
	if err != nil {
		t.Fatalf("读取历史索引失败: %v", err)
	}
	lines := 0
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if strings.TrimSpace(line) != "" {
			lines++
		}
	}
	if lines != 1 {
		t.Fatalf("失败 TTS 应恰好 1 条历史记录，实际 %d", lines)
	}
}

// TestSubmitQueueFullNonBlocking 队列满时 Submit 不阻塞且返回 TASK_QUEUE_FULL；StopQueue 取消待执行任务。
func TestSubmitQueueFullNonBlocking(t *testing.T) {
	chdirTemp(t)
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	defer unblock()

	tm := NewTaskManager(NewHistoryManager())
	inst := &Instance{ID: "full-inst", Name: "full", ModelID: "nonexistent_model", Port: portOf(t, srv.URL)}

	full := 0
	deadline := time.Now().Add(10 * time.Second)
	for i := 0; i < taskQueueSize+50; i++ {
		start := time.Now()
		task := tm.Submit(inst, map[string]any{"text": "x"}, []byte(`{"text":"x"}`))
		if time.Since(start) > 3*time.Second {
			t.Fatalf("Submit 阻塞了 %v", time.Since(start))
		}
		if strings.HasPrefix(task.Error, "TASK_QUEUE_FULL") {
			full++
		}
		if time.Now().After(deadline) {
			t.Fatal("提交循环超时")
		}
	}
	if full == 0 {
		t.Fatalf("队列饱和后应出现 TASK_QUEUE_FULL")
	}

	tm.StopQueue("full-inst")
	unblock()
	time.Sleep(100 * time.Millisecond)
}
