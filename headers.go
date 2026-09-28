package main

import (
	"net/http"
	"strings"
)

// 响应头策略（issue #97）：在 handler 运行之前把安全响应头与缓存策略统一写好。
// 改这一层之前只有 staticHandler 单独设 Cache-Control，/api/* 与 /v1/* 完全裸奔——
// 那类响应里有本机绝对路径（/api/fs）、错误信息里的下载 token、模型与实例状态，
// 浏览器磁盘缓存或中间代理都可能把它们留下来。

// cspPolicy 静态页面（web/ 下文档与资源）的 CSP。
// 意图与 web/index.html、web/offline.html 里的 meta CSP 一致，但改由真实响应头下发：
// meta 只约束「带这个 meta 的那一个文档」，样式表、脚本、Service Worker 都不受它管；
// 且 frame-ancestors 等指令在 meta 里会被浏览器直接忽略。meta 保留作兜底（两层取交集，更严的那层生效）。
// 逐条：
//   - default-src 'self'：前端零构建、零 CDN——web/ 内没有任何 @import / url() /
//     外部字体或脚本引用，字体走本地系统字体栈，所以 'self' 足以覆盖（核对方式见 PR 说明）。
//   - script-src 'self'：无内联脚本、无 on* 事件属性（前端硬约束）。
//   - style-src 'self'：无内联 <style> 与 style=""（组件样式都在 web/style.css，动态宽度走 CSSOM）。
//   - img-src 'self' data:：PWA 图标 + data: 图片。
//   - media-src 'self' blob: data:：结果音频既有 blob:（URL.createObjectURL）也有 data:（base64 内联）。
//   - connect-src 'self'：只同源 fetch /api/* 与 /v1/*。
//   - object-src 'none'、base-uri 'none'、form-action 'self'、frame-ancestors 'none'。
//
// 不用 HSTS：hub 是局域网内明文 HTTP 服务（无 TLS），HSTS 只对 https 源有意义，
// 加上去既无效又会让用户以为链路已被加密。
const cspPolicy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
	"media-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
	"form-action 'self'; frame-ancestors 'none'"

// cspStyleguide 是唯一的 CSP 例外：web/styleguide.html 是 DEV-ONLY 的设计系统演示页，
// 页面自带说明「允许内联 <style>/<script>，因为本页不受应用 CSP 约束」。
// 该页由 staticHandler 一起对外提供，若按应用策略收口会直接白屏；本次只改 Go，
// 所以对它放宽 inline，其余强指令照旧。
const cspStyleguide = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data:; media-src 'self' blob: data:; connect-src 'self'; object-src 'none'; " +
	"base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

// styleguidePath 例外页路径（见 cspStyleguide）。
const styleguidePath = "/styleguide.html"

// securityHeaders 给整条处理链套上安全响应头与缓存策略。
// 必须装在 mux 外层：handler 里的 http.Error / http.NotFound 等早退路径不写头，
// 由中间件兜底才能保证任何响应（包括 404/405）都带上完整头集合。
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		// 安全头对所有响应生效（含 /api/*、/v1/*、静态资源与错误响应）。
		h.Set("X-Content-Type-Options", "nosniff")
		// Referrer-Policy 取 no-referrer 而不是 strict-origin-when-cross-origin：
		// 本工具的请求全部同源，Referer 没有可用价值，留着只会把内网地址
		// （http://192.168.x.x:8080/…）连同路径带给任何第三方资源。
		h.Set("Referrer-Policy", "no-referrer")
		// X-Frame-Options 与 frame-ancestors 重复是有意的：前者覆盖老浏览器，
		// 后者才是现代语义；两者都在才能防点击劫持。
		h.Set("X-Frame-Options", "DENY")
		// 默认拒绝缓存。/api/*、/v1/* 必须 no-store（本地路径、token、模型状态）；
		// 静态资源由 staticHandler 在确认文件存在后显式放宽成有界缓存，
		// 于是 404/405 这类「没有 handler 声明策略」的响应保持 no-store，不会被缓存住。
		h.Set("Cache-Control", "no-store")
		if !isAPIPath(r.URL.Path) {
			policy := cspPolicy
			if r.URL.Path == styleguidePath {
				policy = cspStyleguide
			}
			h.Set("Content-Security-Policy", policy)
		}
		next.ServeHTTP(w, r)
	})
}

// isAPIPath 判定路径是否属于「动态响应」类：/api/* 与 /v1/*。
// 裸路径（/api、/v1）也算——ServeMux 会给它们 301 到带斜杠的形态，
// 那一跳同样不该带缓存策略。
func isAPIPath(p string) bool {
	return p == "/api" || p == "/v1" || strings.HasPrefix(p, "/api/") || strings.HasPrefix(p, "/v1/")
}
