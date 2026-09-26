package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

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
