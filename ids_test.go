package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSafeID(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{name: "hex id", in: "a1b2c3d4", want: true},
		{name: "uppercase and dash", in: "ABC-123", want: true},
		{name: "exactly 32 chars", in: strings.Repeat("a", 32), want: true},

		{name: "empty", in: ""},
		{name: "dot", in: "."},
		{name: "dotdot", in: ".."},
		{name: "slash", in: "a/b"},
		{name: "backslash", in: `a\b`},
		{name: "path traversal", in: "../etc/passwd"},
		{name: "underscore rejected (key-only)", in: "a_b"},
		{name: "space", in: "a b"},
		{name: "nul byte", in: "a\x00"},
		{name: "33 chars", in: strings.Repeat("a", 33)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := safeID(tc.in); got != tc.want {
				t.Fatalf("safeID(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestSafeKey(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{name: "model id with underscore", in: "index_tts2", want: true},
		{name: "task id", in: "a1b2c3d4", want: true},
		{name: "dash", in: "ABC-123_x", want: true},
		{name: "exactly 64 chars", in: strings.Repeat("a", 64), want: true},

		{name: "empty", in: ""},
		{name: "dotdot", in: ".."},
		{name: "slash", in: "a/b"},
		{name: "backslash", in: `a\b`},
		{name: "path traversal", in: "../../data"},
		{name: "space", in: "a b"},
		{name: "nul byte", in: "a\x00"},
		{name: "65 chars", in: strings.Repeat("a", 65)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := safeKey(tc.in); got != tc.want {
				t.Fatalf("safeKey(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

// TestTaskHandlersRejectInvalidID 确认三条任务路由在 handler 边界拒绝危险路径片段
// （handleTaskDelete 此前完全跳过校验，与 GET/result 不一致）。
func TestTaskHandlersRejectInvalidID(t *testing.T) {
	chdirTemp(t)
	hub := &Hub{tasks: NewTaskManager(NewHistoryManager())}

	handlers := map[string]http.HandlerFunc{
		"get":    hub.handleTaskGet,
		"result": hub.handleTaskResult,
		"delete": hub.handleTaskDelete,
	}
	badIDs := []string{"..", "../x", "a/b", `a\b`, "a b", strings.Repeat("a", 33), ""}

	for name, fn := range handlers {
		for _, id := range badIDs {
			t.Run(name+"/"+id, func(t *testing.T) {
				r := httptest.NewRequest(http.MethodGet, "/api/tasks/x", nil)
				r.SetPathValue("id", id)
				rec := httptest.NewRecorder()
				fn(rec, r)
				if rec.Code != http.StatusNotFound {
					t.Fatalf("status = %d, want 404 for id %q", rec.Code, id)
				}
			})
		}
	}
}
