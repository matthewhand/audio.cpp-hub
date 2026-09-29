package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// headersTestHandler 在临时工作目录里造一个最小 web/，返回与线上一致的整条处理链。
func headersTestHandler(t *testing.T) http.Handler {
	t.Helper()
	dir := t.TempDir()
	web := filepath.Join(dir, "web")
	if err := os.MkdirAll(filepath.Join(web, "icons"), 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"index.html":           "<!DOCTYPE html><title>hub</title>",
		"offline.html":         "offline",
		"styleguide.html":      "<!DOCTYPE html><title>sg</title><style>b{}</style>",
		"style.css":            "body{}",
		"app.js":               "export const x = 1;",
		"sw.js":                "self.addEventListener('fetch', () => {});",
		"manifest.webmanifest": "{}",
		"icons/icon-192.png":   "\x89PNG\r\n",
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(web, filepath.FromSlash(name)), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	t.Chdir(dir) // staticHandler 用相对路径 http.Dir("web")
	return (&Hub{}).newHandler()
}

// assertSecurityHeaders 校验所有响应都必须带的安全头。
func assertSecurityHeaders(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	want := map[string]string{
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy":        "no-referrer",
		"X-Frame-Options":        "DENY",
	}
	for k, v := range want {
		if got := rec.Header().Get(k); got != v {
			t.Errorf("%s = %q, 期望 %q", k, got, v)
		}
	}
	// HSTS 只对 https 源有意义，本工具是局域网明文 HTTP，明确不加
	if got := rec.Header().Get("Strict-Transport-Security"); got != "" {
		t.Errorf("Strict-Transport-Security = %q, 明文 HTTP 服务不应下发 HSTS", got)
	}
}

func TestHeadersStaticAsset(t *testing.T) {
	h := headersTestHandler(t)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/style.css", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d, 期望 200", rec.Code)
	}
	assertSecurityHeaders(t, rec)
	if got, want := rec.Header().Get("Content-Security-Policy"), cspPolicy; got != want {
		t.Errorf("CSP = %q, 期望 %q", got, want)
	}
	for _, d := range []string{"default-src 'self'", "script-src 'self'", "object-src 'none'",
		"base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'", "media-src 'self' blob: data:"} {
		if !strings.Contains(rec.Header().Get("Content-Security-Policy"), d) {
			t.Errorf("CSP 缺少指令 %q", d)
		}
	}
	if got, want := rec.Header().Get("Cache-Control"), "public, max-age=3600"; got != want {
		t.Errorf("Cache-Control = %q, 期望 %q", got, want)
	}
	if got := rec.Body.String(); got != "body{}" {
		t.Errorf("响应体 = %q, 期望 %q", got, "body{}")
	}
}

// 静态资源的缓存时长来自 constants.go 的具名常量，测试锁住具体取值。
func TestStaticAssetMaxAgeConstant(t *testing.T) {
	if staticAssetMaxAge != 3600 {
		t.Errorf("staticAssetMaxAge = %d, 期望 3600（1 小时，有界缓存）", staticAssetMaxAge)
	}
}

// HTML 入口（不止 index.html）必须每次回源校验，否则新部署要等一小时才可见。
func TestHeadersHTMLNoCache(t *testing.T) {
	h := headersTestHandler(t)
	for _, p := range []string{"/", "/index.html", "/offline.html"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s 状态码 = %d, 期望 200", p, rec.Code)
		}
		if got, want := rec.Header().Get("Cache-Control"), "no-cache"; got != want {
			t.Errorf("GET %s Cache-Control = %q, 期望 %q", p, got, want)
		}
		assertSecurityHeaders(t, rec)
	}
}

// /api/* 响应必须 no-store（可能含本机绝对路径、token、模型状态），
// 且不带 CSP（CSP 只约束文档/worker，对 JSON 没有意义）。
func TestHeadersAPINoStore(t *testing.T) {
	h := headersTestHandler(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/models", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d, 期望 200", rec.Code)
	}
	assertSecurityHeaders(t, rec)
	if got, want := rec.Header().Get("Cache-Control"), "no-store"; got != want {
		t.Errorf("Cache-Control = %q, 期望 %q", got, want)
	}
	if got := rec.Header().Get("Content-Security-Policy"); got != "" {
		t.Errorf("API 响应不应带 CSP，实际 %q", got)
	}

	// 回归：JSON 端点的状态码与响应体不能被响应头改动影响
	var models []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &models); err != nil {
		t.Fatalf("响应体不是合法 JSON 数组: %v (%s)", err, rec.Body.String()[:min(120, rec.Body.Len())])
	}
	if len(models) == 0 {
		t.Error("模型清单为空，models.json 嵌入可能出了问题")
	}
	if got, want := rec.Header().Get("Content-Type"), "application/json; charset=utf-8"; got != want {
		t.Errorf("Content-Type = %q, 期望 %q", got, want)
	}
}

// 404（无论静态还是 API）都要带完整安全头；没有 handler 声明缓存策略时保持 no-store。
func TestHeadersNotFound(t *testing.T) {
	h := headersTestHandler(t)

	t.Run("api", func(t *testing.T) {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/nope", nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("状态码 = %d, 期望 404", rec.Code)
		}
		assertSecurityHeaders(t, rec)
		if got, want := rec.Header().Get("Cache-Control"), "no-store"; got != want {
			t.Errorf("Cache-Control = %q, 期望 %q", got, want)
		}
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("404 响应体不是合法 JSON: %v", err)
		}
		if body["code"] != "UNKNOWN_API" {
			t.Errorf("code = %v, 期望 UNKNOWN_API", body["code"])
		}
	})

	t.Run("static", func(t *testing.T) {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/missing.js", nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("状态码 = %d, 期望 404", rec.Code)
		}
		assertSecurityHeaders(t, rec)
		// 静态 404 走不到 staticHandler 的显式缓存声明，保留中间件的默认拒绝缓存
		if got, want := rec.Header().Get("Cache-Control"), "no-store"; got != want {
			t.Errorf("Cache-Control = %q, 期望 %q", got, want)
		}
		if got := rec.Header().Get("Content-Security-Policy"); got != cspPolicy {
			t.Errorf("CSP = %q, 期望 %q", got, cspPolicy)
		}
	})
}

// 已知路径上方法不对 → 405 + Allow，且同样带完整头与 no-store。
func TestHeadersMethodNotAllowed(t *testing.T) {
	h := headersTestHandler(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/models", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("状态码 = %d, 期望 405", rec.Code)
	}
	assertSecurityHeaders(t, rec)
	if got := rec.Header().Get("Allow"); got != "GET" {
		t.Errorf("Allow = %q, 期望 GET", got)
	}
	if got, want := rec.Header().Get("Cache-Control"), "no-store"; got != want {
		t.Errorf("Cache-Control = %q, 期望 %q", got, want)
	}
}

// DEV-ONLY 演示页允许内联 style/script，其余强指令照旧。
func TestHeadersStyleguideCSPRelaxed(t *testing.T) {
	h := headersTestHandler(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, styleguidePath, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d, 期望 200", rec.Code)
	}
	got := rec.Header().Get("Content-Security-Policy")
	if !strings.Contains(got, "style-src 'self' 'unsafe-inline'") {
		t.Errorf("styleguide CSP 未放行内联样式: %q", got)
	}
	if !strings.Contains(got, "frame-ancestors 'none'") {
		t.Errorf("styleguide CSP 丢了 frame-ancestors: %q", got)
	}
}

// The service worker script itself must be revalidated, not served with the
// one-hour max-age used for ordinary static assets. Otherwise discovery of a
// new worker is deferred to each browser's own update heuristics and a stale
// worker can keep controlling the page (#97).
func TestHeadersServiceWorkerNoCache(t *testing.T) {
	h := headersTestHandler(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/sw.js", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d, 期望 200", rec.Code)
	}
	if got, want := rec.Header().Get("Cache-Control"), "no-cache"; got != want {
		t.Errorf("GET /sw.js Cache-Control = %q, 期望 %q", got, want)
	}
	assertSecurityHeaders(t, rec)
}

// The manifest needs an explicit content type: Go's MIME table is not
// guaranteed to know .webmanifest, and a wrong type makes the browser refuse
// to install the PWA (#97).
func TestHeadersManifestContentType(t *testing.T) {
	h := headersTestHandler(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/manifest.webmanifest", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d, 期望 200", rec.Code)
	}
	if got, want := rec.Header().Get("Content-Type"), "application/manifest+json"; !strings.HasPrefix(got, want) {
		t.Errorf("Content-Type = %q, 期望以 %q 开头", got, want)
	}
	assertSecurityHeaders(t, rec)
}

func TestIsAPIPath(t *testing.T) {
	cases := []struct {
		path string
		want bool
	}{
		{"/api/models", true},
		{"/api/history/qwen/x/audio", true},
		{"/v1/audio/speech", true},
		{"/api", true}, // 301 到 /api/ 的那一跳同样 no-store
		{"/v1", true},
		{"/", false},
		{"/index.html", false},
		{"/style.css", false},
		{"/apixyz", false}, // 前缀必须带斜杠，别误伤同前缀的静态文件
		{"/v1beta", false},
	}
	for _, tc := range cases {
		if got := isAPIPath(tc.path); got != tc.want {
			t.Errorf("isAPIPath(%q) = %v, 期望 %v", tc.path, got, tc.want)
		}
	}
}
