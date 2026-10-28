package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Synthetic content and a loopback fixture only: never fetch real weights.
func fictionalDigest(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func newIntegrityManager(t *testing.T) *DownloadManager {
	t.Helper()
	dir := t.TempDir()
	return &DownloadManager{modelsDir: filepath.Join(dir, "models"), stateDir: filepath.Join(dir, "state"), sem: make(chan struct{}, 4), segmentsPerFile: 4}
}
func newIntegrityTask(f *dlFileEntry) *DownloadTask {
	return &DownloadTask{ID: "fictional", TargetDir: "sample", Files: []*dlFileEntry{f}, Status: dlStatusRunning}
}
func getUserErrCode(err error) string {
	var u *UserError
	if errors.As(err, &u) {
		return u.Code
	}
	return ""
}
func TestIntegritySHA256GrammarAndLegacyManifest(t *testing.T) {
	content := []byte("fictional reproducible fixture")
	digest := fictionalDigest(content)
	cases := []struct {
		input, want string
		ok          bool
	}{
		{"", "", true}, {digest, digest, true}, {strings.ToUpper(digest), digest, true},
		{digest[:63], "", false}, {digest + "0", "", false}, {strings.Repeat("z", 64), "", false},
		{"sha256:" + digest, "", false}, {strings.Repeat("0", 64) + " ", "", false},
	}
	for _, tc := range cases {
		got, err := validateExpectedSHA256(tc.input)
		if (err == nil) != tc.ok || (tc.ok && got != tc.want) {
			t.Errorf("digest grammar for %q: got=%q err=%v", tc.input, got, err)
		}
	}
	raw := json.RawMessage(`{"packages":[{"id":"legacy","repo":"fictional/example","revision":"main","targetDir":"fictional","files":[{"remote":"source.gguf","local":"sample.gguf"}]},{"id":"hashed","repo":"fictional/example","revision":"0123456789abcdef0123456789abcdef01234567","targetDir":"fictional","files":[{"remote":"source.gguf","local":"sample.gguf","sha256":"` + digest + `"}]}]}`)
	old := resolvePackage(raw, "legacy")
	hashed := resolvePackage(raw, "hashed")
	if old == nil || old.Files[0].SHA256 != "" || hashed == nil || hashed.Files[0].SHA256 != digest {
		t.Fatalf("optional manifest digest not backwards compatible")
	}
}

func TestIntegrityPartCompletionAndMismatch(t *testing.T) {
	content := []byte("fictional small weight bytes exactly once")
	for _, tc := range []struct {
		name string
		hash string
		ok   bool
	}{
		{"matching-hash", fictionalDigest(content), true},
		{"mismatched-hash", strings.Repeat("0", 64), false},
		{"legacy-unverified", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := newIntegrityManager(t)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Range") != "bytes=0-"+fmt.Sprint(len(content)-1) {
					t.Errorf("bad test range: %q", r.Header.Get("Range"))
				}
				w.Header().Set("Content-Range", fmt.Sprintf("bytes 0-%d/%d", len(content)-1, len(content)))
				w.WriteHeader(http.StatusPartialContent)
				_, _ = w.Write(content)
			}))
			defer server.Close()
			m.httpClient = server.Client()
			f := &dlFileEntry{URL: server.URL, Path: "fixture.gguf", SHA256: tc.hash, Size: int64(len(content)), SupportsRange: true, Segments: []dlSegment{{Start: 0, End: int64(len(content)) - 1}}}
			task := newIntegrityTask(f)
			err := m.downloadFile(task, f, 0, context.Background())
			final := m.finalPath(task.TargetDir, f.Path)
			if tc.ok {
				if err != nil || !f.Completed {
					t.Fatalf("valid download failed: %v", err)
				}
				got, readErr := os.ReadFile(final)
				if readErr != nil || string(got) != string(content) {
					t.Fatalf("final bytes unexpected: %v", readErr)
				}
			} else {
				if getUserErrCode(err) != "DOWNLOAD_HASH_MISMATCH" || f.Completed {
					t.Fatalf("digest mismatch incorrectly completed: %v", err)
				}
				if _, err := os.Stat(final); !os.IsNotExist(err) {
					t.Fatalf("digest mismatch published a final file: %v", err)
				}
				if _, err := os.Stat(final + ".part"); err != nil {
					t.Fatalf("partial should stay for inspection/explicit retry: %v", err)
				}
			}
		})
	}
}

func TestIntegrityStreamUnknownSizeAndMismatch(t *testing.T) {
	content := []byte("fictional stream without Content-Length")
	for _, tc := range []struct {
		name, expected string
		ok             bool
	}{
		{"match", fictionalDigest(content), true}, {"wrong", strings.Repeat("f", 64), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := newIntegrityManager(t)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/octet-stream")
				_, _ = w.Write(content)
			}))
			defer server.Close()
			m.httpClient = server.Client()
			f := &dlFileEntry{URL: server.URL, Path: "fixture.gguf", Size: -1, SHA256: tc.expected, Segments: []dlSegment{{Start: 0, End: -1}}}
			task := newIntegrityTask(f)
			err := m.downloadFile(task, f, 0, context.Background())
			final := m.finalPath(task.TargetDir, f.Path)
			if tc.ok && (err != nil || !f.Completed) {
				t.Fatalf("correct stream failed: %v", err)
			}
			if !tc.ok && (getUserErrCode(err) != "DOWNLOAD_HASH_MISMATCH" || f.Completed) {
				t.Fatalf("bad stream succeeded: %v", err)
			}
			if !tc.ok {
				if _, err := os.Stat(final); !os.IsNotExist(err) {
					t.Fatalf("bad stream published: %v", err)
				}
			}
		})
	}
}

func TestIntegrityResumedRangeAndRecoveredFiles(t *testing.T) {
	content := []byte("fictional resumed bytes covering full content")
	hash := fictionalDigest(content)
	m := newIntegrityManager(t)
	prefix := int64(12)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != fmt.Sprintf("bytes=%d-%d", prefix, len(content)-1) {
			t.Errorf("incorrect resume range: %q", r.Header.Get("Range"))
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", prefix, len(content)-1, len(content)))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(content[prefix:])
	}))
	defer server.Close()
	m.httpClient = server.Client()
	f := &dlFileEntry{URL: server.URL, Path: "fixture.gguf", Size: int64(len(content)), SHA256: hash, SupportsRange: true, Segments: []dlSegment{{Start: 0, End: int64(len(content)) - 1, Done: prefix}}}
	task := newIntegrityTask(f)
	final := m.finalPath(task.TargetDir, f.Path)
	if err := os.MkdirAll(filepath.Dir(final), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(final+".part", content[:prefix], 0600); err != nil {
		t.Fatal(err)
	}
	if err := m.runTaskInner(task, 0, context.Background()); err != nil || !f.Completed {
		t.Fatalf("resume failed: %v", err)
	}
	if err := verifyDownloadedSHA256(final, hash); err != nil {
		t.Fatalf("resumed integrity lost: %v", err)
	}

	// A crash between rename and durable task update must recheck the final bytes.
	f.Completed = false
	if err := m.downloadFile(task, f, 0, context.Background()); err != nil || !f.Completed {
		t.Fatalf("recovery must accept verified final: %v", err)
	}
	f.Completed = false
	if err := os.WriteFile(final, []byte(strings.Repeat("x", len(content))), 0600); err != nil {
		t.Fatal(err)
	}
	if err := m.downloadFile(task, f, 0, context.Background()); getUserErrCode(err) != "DOWNLOAD_HASH_MISMATCH" || f.Completed {
		t.Fatalf("recovery accepted altered bytes: %v", err)
	}
	f.Completed = true
	if err := m.runTaskInner(task, 0, context.Background()); getUserErrCode(err) != "DOWNLOAD_HASH_MISMATCH" || f.Completed {
		t.Fatalf("persisted completion bypassed hash check: %v", err)
	}
	if _, err := os.Stat(final); err != nil {
		t.Fatalf("must not delete existing unrelated file in recovery: %v", err)
	}
}

func TestIntegrityNoBypassWithWrongSizeOrTaskInput(t *testing.T) {
	m := newIntegrityManager(t)
	m.trustedHosts = map[string]struct{}{"127.0.0.1": {}} // synthetic loopback, no DNS or external requests
	// Invalid digest fails before any probe/download. Path validation stays intact.
	cases := []struct{ path, sha, want string }{
		{"file.gguf", "bad", "INVALID_SHA256"},
		{"../escape.gguf", fictionalDigest([]byte("fixture")), "INVALID_FILE_PATH"},
	}
	for _, tc := range cases {
		_, err := m.Create("safe", []dlFileRequest{{URL: "http://127.0.0.1:1/fixture", Path: tc.path, SHA256: tc.sha}}, "", false, "", "", "")
		if err == nil {
			t.Fatalf("unsafe request succeeded for path %s", tc.path)
		}
		if tc.want == "INVALID_SHA256" && getUserErrCode(err) != "INVALID_SHA256" {
			t.Fatalf("bad sha validation: %v", err)
		}
	}
	content := []byte("fictional-short")
	p := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(p, content, 0600); err != nil {
		t.Fatal(err)
	}
	if err := verifyDownloadedSHA256(p, fictionalDigest(append(append([]byte{}, content...), 0))); getUserErrCode(err) != "DOWNLOAD_HASH_MISMATCH" {
		t.Fatalf("wrong size/content bypassed hash: %v", err)
	}
	// Check persistent expected SHA field survives a JSON task roundtrip.
	file := &dlFileEntry{Path: "file", Size: int64(len(content)), SHA256: fictionalDigest(content), Segments: []dlSegment{{Start: 0, End: int64(len(content)) - 1}}}
	task := newIntegrityTask(file)
	b, err := json.Marshal(task)
	if err != nil {
		t.Fatal(err)
	}
	var restored DownloadTask
	if err := json.Unmarshal(b, &restored); err != nil || restored.Files[0].SHA256 != file.SHA256 {
		t.Fatalf("persisted digest lost: %v", err)
	}
}

func TestIntegrityExplicitDownloadRejectsNonstringsOffline(t *testing.T) {
	h := &Hub{}
	for _, raw := range []string{
		`{"targetDir":"fixture","files":[{"url":"http://127.0.0.1:1/fictional.gguf","path":"fictional.gguf","sha256":42}]}`,
		`{"targetDir":"fixture","files":[{"url":"http://127.0.0.1:1/fictional.gguf","path":"fictional.gguf","sha256":null}]}`,
		`{"targetDir":"fixture","files":[{"url":"http://127.0.0.1:1/fictional.gguf","path":"fictional.gguf","sha256":{}}]}`,
	} {
		req := httptest.NewRequest("POST", "/api/downloads", strings.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		h.handleDownloadCreate(response, req)
		if response.Code != 400 || !strings.Contains(response.Body.String(), "INVALID_SHA256") {
			t.Fatalf("nonstrings should fail without probing URLs, got HTTP %d", response.Code)
		}
	}
}

func TestIntegrityTwoSegmentsRequireWholeFileDigest(t *testing.T) {
	// An equal-length corruption in either concurrent HTTP Range segment must
	// fail the digest for the joined file, not just per-response byte counts.
	original := []byte(strings.Repeat("fictional-segment-bytes-", 60))
	for _, corrupt := range []bool{false, true} {
		name := "exact"
		if corrupt {
			name = "corrupted-equal-size"
		}
		t.Run(name, func(t *testing.T) {
			manager := newIntegrityManager(t)
			half := len(original) / 2
			source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var start, end int
				if n, err := fmt.Sscanf(r.Header.Get("Range"), "bytes=%d-%d", &start, &end); err != nil || n != 2 || end < start || start < 0 || end >= len(original) {
					w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
					return
				}
				chunk := append([]byte(nil), original[start:end+1]...)
				if corrupt && start == half {
					chunk[0] ^= 0x01
				}
				w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(original)))
				w.WriteHeader(http.StatusPartialContent)
				_, _ = w.Write(chunk)
			}))
			defer source.Close()
			manager.httpClient = source.Client()
			file := &dlFileEntry{Path: "joined.gguf", URL: source.URL, Size: int64(len(original)), SupportsRange: true, SHA256: fictionalDigest(original), Segments: []dlSegment{{Start: 0, End: int64(half - 1)}, {Start: int64(half), End: int64(len(original) - 1)}}}
			task := newIntegrityTask(file)
			err := manager.downloadFile(task, file, 0, context.Background())
			final := manager.finalPath(task.TargetDir, file.Path)
			if corrupt {
				if getUserErrCode(err) != "DOWNLOAD_HASH_MISMATCH" || file.Completed {
					t.Fatalf("corrupt segment accepted: %v", err)
				}
				if _, statErr := os.Stat(final); !os.IsNotExist(statErr) {
					t.Fatalf("corrupt assembled file became final: %v", statErr)
				}
			} else {
				if err != nil || !file.Completed {
					t.Fatalf("joined range download failed: %v", err)
				}
				got, readErr := os.ReadFile(final)
				if readErr != nil || string(got) != string(original) {
					t.Fatalf("joined file changed: %v", readErr)
				}
			}
		})
	}
}
