package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestDownloadManagerLifecycle(t *testing.T) {
	payload := []byte(strings.Repeat("abcdefghij0123456789", 50)) // 1000 bytes

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("Content-Length", strconv.Itoa(len(payload)))

		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusOK)
			return
		}

		rangeHeader := r.Header.Get("Range")
		if rangeHeader != "" && strings.HasPrefix(rangeHeader, "bytes=") {
			// Parse e.g. "bytes=0-999" or "bytes=0-"
			rng := strings.TrimPrefix(rangeHeader, "bytes=")
			parts := strings.Split(rng, "-")
			start, _ := strconv.Atoi(parts[0])
			end := len(payload) - 1
			if len(parts) > 1 && parts[1] != "" {
				if e, err := strconv.Atoi(parts[1]); err == nil && e < len(payload) {
					end = e
				}
			}
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(payload)))
			w.Header().Set("Content-Length", strconv.Itoa(end-start+1))
			w.WriteHeader(http.StatusPartialContent)
			w.Write(payload[start : end+1])
			return
		}

		w.WriteHeader(http.StatusOK)
		w.Write(payload)
	}))
	defer srv.Close()

	tmp := t.TempDir()
	origCwd, _ := os.Getwd()
	t.Chdir(tmp)
	t.Cleanup(func() {
		os.Chdir(origCwd)
	})

	cfg := HubConfig{
		HfEndpoint:               srv.URL,
		ModelsDir:                filepath.Join(tmp, "models"),
		DownloadThreads:          2,
		DownloadSegmentsPerFile: 2,
	}

	mgr := NewDownloadManager(cfg)
	defer mgr.Shutdown()

	files := []dlFileRequest{
		{
			Path: "model.bin",
			URL:  srv.URL + "/model.bin",
		},
	}

	// 1. Create task
	taskMap, err := mgr.Create("test-target", files, "", true, "", "", "")
	if err != nil {
		t.Fatalf("Create download failed: %v", err)
	}
	taskID, ok := taskMap["id"].(string)
	if !ok || taskID == "" {
		t.Fatalf("expected non-empty task id, got %v", taskMap["id"])
	}

	// 2. Poll until DONE or timeout
	deadline := time.Now().Add(5 * time.Second)
	var finalTask map[string]any
	for time.Now().Before(deadline) {
		tDetail, err := mgr.Get(taskID)
		if err == nil {
			status, _ := tDetail["status"].(string)
			if status == string(dlStatusDone) {
				finalTask = tDetail
				break
			}
			if status == string(dlStatusFailed) {
				t.Fatalf("download failed: %v", tDetail["error"])
			}
		}
		time.Sleep(50 * time.Millisecond)
	}

	if finalTask == nil {
		t.Fatalf("timed out waiting for download to complete")
	}

	// Verify downloaded file on disk
	downloadedFile := filepath.Join(tmp, "models", "test-target", "model.bin")
	content, err := os.ReadFile(downloadedFile)
	if err != nil {
		t.Fatalf("read downloaded file failed: %v", err)
	}
	if len(content) != len(payload) {
		t.Errorf("downloaded content length = %d, want %d", len(content), len(payload))
	}

	// 3. List
	list := mgr.List()
	if len(list) != 1 {
		t.Errorf("List() returned %d tasks, want 1", len(list))
	}

	// 4. Pause on a DONE task returns error
	if err := mgr.Pause(taskID); err == nil {
		t.Errorf("expected error pausing DONE task, got nil")
	}

	// 5. Resume on a DONE task returns error
	if err := mgr.Resume(taskID); err == nil {
		t.Errorf("expected error resuming DONE task, got nil")
	}

	// 6. Delete task with purge=true
	if err := mgr.Delete(taskID, true); err != nil {
		t.Fatalf("Delete task failed: %v", err)
	}

	// Task should no longer exist in List()
	if len(mgr.List()) != 0 {
		t.Errorf("expected 0 tasks after delete, got %d", len(mgr.List()))
	}
}
