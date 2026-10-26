package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/matthewhand/audio.cpp-hub/internal/idvalidate"
	"github.com/matthewhand/audio.cpp-hub/internal/wav"
)

// /v1/* OpenAI 兼容代理（移植自 Java 版 V1ProxyHandler + RequestModelExtractor）。
// Go 的 net/http 本身就流式给 r.Body，无需 Netty 的 aggregator 拆装：
// 请求体流式落盘 run/proxy-cache/<id>.req（大 base64 不进内存）→ 逐字节扫描提取顶层
// "model" → 按服务名路由到 READY 实例 → 落盘文件作为 body 转发到实例同名路径 →
// 响应状态码/Content-Type 透传，每读一块 Flush 一次（SSE/chunked 与整包都支持）。
// 错误体为 OpenAI 风格 {"error":{"message","type"}}。
// multipart/form-data（如 /v1/audio/transcriptions）从表单字段 model 取路由键，
// body 不改写直接转发（extractV1MultipartModel）。

const (
	v1CacheDir          = "run/proxy-cache"
	v1ModelCaptureLimit = 4096 // model 值捕获上限（服务名最长 64，给足余量）
	v1ResponseChunk     = 8192
)

// v1ProxyError 带 HTTP 状态码的代理错误，转成 OpenAI 风格错误体。
type v1ProxyError struct {
	status int
	msg    string
}

func (e *v1ProxyError) Error() string { return e.msg }

var errV1InvalidJSON = &v1ProxyError{http.StatusBadRequest, "Request body is not a valid JSON object"}

// v1UpstreamClient 上游实例通信：不设整体超时（TTS 可能跑很久），
// 中断靠请求 context（客户端断开时 r.Context() 取消）；仅限制等待响应头的时间。
const defaultProxyResponseHeaderTimeout = 60 * time.Second

// proxyResponseHeaderTimeout 由 hub.config.json 的 proxyResponseHeaderTimeoutMs 决定；
// <= 0 回落到 60 s。慢模型（如 fish_drama3 的 disk_experts 懒加载 + 离线生成）需要更长。
func proxyResponseHeaderTimeout(cfg HubConfig) time.Duration {
	if cfg.ProxyResponseHeaderTimeoutMs <= 0 {
		return defaultProxyResponseHeaderTimeout
	}
	return time.Duration(cfg.ProxyResponseHeaderTimeoutMs) * time.Millisecond
}

var (
	v1ClientsMu sync.Mutex
	v1Clients   = map[time.Duration]*http.Client{}
)

// v1UpstreamClientFor 按响应头超时缓存客户端（连接池随之复用）。
func v1UpstreamClientFor(timeout time.Duration) *http.Client {
	v1ClientsMu.Lock()
	defer v1ClientsMu.Unlock()
	if c, ok := v1Clients[timeout]; ok {
		return c
	}
	c := &http.Client{
		Transport: &http.Transport{
			DialContext:           (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
			MaxIdleConns:          32,
			MaxIdleConnsPerHost:   8,
			IdleConnTimeout:       90 * time.Second,
			ResponseHeaderTimeout: timeout,
		},
	}
	v1Clients[timeout] = c
	return c
}

// hopByHopHeaders 逐跳头，按 RFC 7230 不跨代理转发。
var hopByHopHeaders = map[string]bool{
	"Connection":          true,
	"Proxy-Connection":    true,
	"Keep-Alive":          true,
	"Proxy-Authenticate":  true,
	"Proxy-Authorization": true,
	"Te":                  true,
	"Trailer":             true,
	"Transfer-Encoding":   true,
	"Upgrade":             true,
}

// copyNonHopHeaders 复制非逐跳头；Content-Length 由转发层按实际 body 重算，不复制。
func copyNonHopHeaders(dst, src http.Header) {
	for k, vs := range src {
		if hopByHopHeaders[http.CanonicalHeaderKey(k)] {
			continue
		}
		for _, v := range vs {
			dst.Add(k, v)
		}
	}
}

// cleanupV1ProxyCache 启动时清扫 run/proxy-cache/*.req 残留（main 启动时调一次）。
func cleanupV1ProxyCache() {
	if err := os.MkdirAll(v1CacheDir, 0755); err != nil {
		log.Printf("初始化代理缓存目录失败: %v", err)
		return
	}
	entries, err := os.ReadDir(v1CacheDir)
	if err != nil {
		log.Printf("初始化代理缓存目录失败: %v", err)
		return
	}
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".req") {
			os.Remove(filepath.Join(v1CacheDir, e.Name()))
		}
	}
}

// handleV1Proxy /v1/* 统一入口：GET /v1/models 本地聚合，POST/PUT 转发到实例。
func (h *Hub) handleV1Proxy(w http.ResponseWriter, r *http.Request) {
	// 宽松 CORS：浏览器 OpenAI 客户端需要预检与读取响应（本服务本地无凭据）
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, OpenAI-*")
		w.Header().Set("Access-Control-Max-Age", "86400")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.URL.Path == "/v1/models" && r.Method == http.MethodGet {
		h.handleV1Models(w, r)
		return
	}
	if r.Method != http.MethodPost && r.Method != http.MethodPut {
		v1Error(w, http.StatusMethodNotAllowed, "Method not allowed: "+r.Method)
		return
	}
	maxBody := h.cfg.ProxyMaxBodyBytes
	if maxBody <= 0 {
		maxBody = 1 << 30
	}
	// 1) 请求体流式落盘（超上限 413）
	if err := os.MkdirAll(v1CacheDir, 0755); err != nil {
		v1Error(w, http.StatusInternalServerError, "Proxy cache unavailable")
		return
	}
	f, err := os.CreateTemp(v1CacheDir, "req-*.req")
	if err != nil {
		log.Printf("创建代理缓存文件失败: %v", err)
		v1Error(w, http.StatusInternalServerError, "Proxy cache unavailable")
		return
	}
	tmp := f.Name()
	n, copyErr := io.Copy(f, io.LimitReader(r.Body, maxBody+1))
	if cerr := f.Close(); cerr != nil && copyErr == nil {
		copyErr = cerr
	}
	if copyErr != nil {
		os.Remove(tmp)
		log.Printf("代理缓存写入失败: %v", copyErr)
		v1Error(w, http.StatusInternalServerError, "Proxy cache unavailable")
		return
	}
	if n > maxBody {
		os.Remove(tmp)
		v1Error(w, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("Request body exceeds proxy limit of %d bytes", maxBody))
		return
	}
	defer os.Remove(tmp) // 转发用的文件句柄在此之前已关闭（Windows 需先 close 再删）

	// 2) 提取 "model"：JSON 逐字节扫描顶层字段；multipart/form-data（/v1/audio/transcriptions
	//    及 /details）读取表单字段 model，原始 body 与 Content-Type（含 boundary）原样转发
	var model string
	if ct := r.Header.Get("Content-Type"); isMultipartForm(ct) {
		model, err = extractV1MultipartModel(tmp, ct)
	} else {
		model, err = extractV1Model(tmp, maxBody)
	}
	if err != nil {
		if pe, ok := err.(*v1ProxyError); ok {
			v1Error(w, pe.status, pe.msg)
		} else {
			v1Error(w, http.StatusInternalServerError, "Failed to read cached request body")
		}
		return
	}
	if model == "" {
		v1Error(w, http.StatusBadRequest, "Missing required parameter: model")
		return
	}

	// 3) 按服务名路由（READY 才转发；非 READY 409；不存在 404）
	inst := h.instances.FindByName(model)
	if inst == nil {
		if h.instances.FindAnyByName(model) != nil {
			v1Error(w, http.StatusConflict, "Model is still starting: "+model)
		} else {
			v1Error(w, http.StatusNotFound, "Model not found: "+model)
		}
		return
	}

	// 4) 落盘文件作为 body 转发到实例同名路径，5) 响应流式回写
	h.forwardV1(w, r, inst, tmp, n)
}

// handleV1Models GET /v1/models：聚合 READY 实例，OpenAI 格式。
func (h *Hub) handleV1Models(w http.ResponseWriter, r *http.Request) {
	io.Copy(io.Discard, r.Body) // drain body 保 keep-alive
	data := []map[string]any{}
	for _, inst := range h.instances.List() {
		if inst.Status != "READY" {
			continue
		}
		data = append(data, map[string]any{
			"id":       inst.Name,
			"object":   "model",
			"created":  v1CreatedEpoch(inst.CreatedAt),
			"owned_by": "audiocpp",
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"object": "list", "data": data})
}

// v1CreatedEpoch 解析实例 CreatedAt（ISO）为 epoch 秒，失败归 0。
func v1CreatedEpoch(iso string) int64 {
	if t, err := time.Parse("2006-01-02T15:04:05.000Z", iso); err == nil {
		return t.Unix()
	}
	return 0
}

// forwardV1 把落盘的请求体转发到实例同名 URI，响应分块流式回写（每块 Flush）。
func (h *Hub) forwardV1(w http.ResponseWriter, r *http.Request, inst *Instance, bodyPath string, bodyLen int64) {
	body, err := os.Open(bodyPath)
	if err != nil {
		v1Error(w, http.StatusInternalServerError, "Failed to read cached request body")
		return
	}
	upstreamURL := fmt.Sprintf("http://127.0.0.1:%d%s", inst.Port, r.URL.RequestURI())
	req, err := http.NewRequestWithContext(r.Context(), r.Method, upstreamURL, body)
	if err != nil {
		body.Close()
		v1Error(w, http.StatusInternalServerError, "Proxy internal error")
		return
	}
	req.ContentLength = bodyLen
	// 转发非逐跳请求头（Authorization/Accept/OpenAI-* 等）；Content-Length 由 body 重算
	copyNonHopHeaders(req.Header, r.Header)
	req.Header.Del(noArchiveHeader) // hub-only control header
	req.Header.Del("Content-Length")
	if req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := v1UpstreamClientFor(proxyResponseHeaderTimeout(h.cfg)).Do(req)
	body.Close() // 请求体已完整发出（或失败），缓存文件使命结束
	if err != nil {
		log.Printf("转发到实例 #%s 失败: %v", inst.ID, err)
		if r.Context().Err() == nil {
			v1Error(w, http.StatusBadGateway, "Failed to reach model instance: "+summarize(err.Error()))
		}
		return
	}
	defer resp.Body.Close()
	// ming3_audio ASR: strip the leading "<Language>\t" and return it as "language" (#190).
	rewriteV1ASRResponse(r.URL.Path, inst, resp)

	// 回写非逐跳响应头（X-Request-Id/Retry-After/限流头等），Content-Length 按实际值设置
	copyNonHopHeaders(w.Header(), resp.Header)
	w.Header().Del("Content-Length")
	// 缓存策略由 hub 统一决定（headers.go：/v1/* 一律 no-store，响应里有实例内的
	// 推理结果与错误细节），丢掉上游可能自带的 Cache-Control，避免与策略叠加成多值。
	w.Header().Del("Cache-Control")
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "application/json")
	}
	if resp.ContentLength >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(resp.ContentLength, 10))
	}
	w.WriteHeader(resp.StatusCode)
	flusher, _ := w.(http.Flusher)
	// /v1/audio/speech 透明归档：仅当请求路径与响应形态符合 TTS 时，把回写的音频字节
	// 同时落盘（tee），成功后按 taskId 记入操作历史（复用 RecordTTS；失败不归档）。
	var teeFile *os.File
	teePath := ""
	archiveTaskID := ""
	archiveReq := map[string]any{}
	if h.history != nil && r.URL.Path == "/v1/audio/speech" && resp.StatusCode == http.StatusOK &&
		strings.HasPrefix(resp.Header.Get("Content-Type"), "audio/") {
		// 请求体仍在缓存文件里（defer os.Remove 还没执行），读取归档所需的最小要素。
		var parsed map[string]any
		if data, rerr := os.ReadFile(bodyPath); rerr == nil {
			if jerr := json.Unmarshal(data, &parsed); jerr != nil {
				parsed = nil
			}
		}
		archive := v1SpeechShouldArchive(h.cfg.v1SpeechArchiveDefault(), r.Header.Get(noArchiveHeader), parsed)
		if archive {
			if parsed != nil {
				if s := optString(parsed, "input"); s != "" {
					archiveReq["text"] = s
				}
				if s := optString(parsed, "voice_ref"); s != "" {
					archiveReq["voice_ref"] = s
				}
				if s := optString(parsed, "reference_text"); s != "" {
					archiveReq["reference_text"] = s
				}
				if s := optString(parsed, "seed"); s != "" {
					archiveReq["seed"] = parsed["seed"]
				}
				if o, ok := parsed["options"].(map[string]any); ok {
					archiveReq["options"] = o
				}
			}
			archiveTaskID = newID() + newID()
			if idvalidate.SafeKey(archiveTaskID) && idvalidate.SafeKey(inst.ModelID) {
				dir := historyDir(inst.ModelID)
				if err := os.MkdirAll(dir, 0755); err == nil {
					tf, terr := os.CreateTemp(dir, ".v1-*.wav.tmp")
					if terr == nil {
						teeFile = tf
						teePath = tf.Name()
					}
				}
			}
		}
	}
	if teeFile != nil {
		defer func() {
			teeFile.Close()
			os.Remove(teePath) // 归档失败/客户端中断时清理临时文件（成功路径已提前改名）
		}()
	}
	buf := make([]byte, v1ResponseChunk)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return // 客户端断开，context 取消会让上游读中断
			}
			if teeFile != nil {
				if _, terr := teeFile.Write(buf[:n]); terr != nil {
					log.Printf("/v1/audio/speech 归档写盘失败，放弃本次归档: %v", terr)
					teeFile.Close()
					teeFile = nil
				}
			}
			if flusher != nil {
				flusher.Flush() // SSE 必须逐块下发
			}
		}
		if readErr != nil {
			if readErr == io.EOF && teeFile != nil && inst.ServerTask == "tts" {
				h.archiveV1Speech(inst, teePath, archiveTaskID, archiveReq)
			}
			return
		}
	}
}

// archiveV1Speech 把 tee 落盘的成功音频从临时文件改名为历史 wav 并写入操作历史。
// taskID 与 /api/tasks 生成的格式一致，前端可正常播放/删除。
func (h *Hub) archiveV1Speech(inst *Instance, teePath, taskID string, request map[string]any) {
	info, err := wav.ParseFile(teePath)
	if err != nil || info.DurationSec <= 0 {
		return // 非 WAV（上游将来改格式）不归档，defer 已清理临时文件
	}
	var size int64
	if st, serr := os.Stat(teePath); serr == nil {
		size = st.Size()
	}
	finalPath := filepath.Join(historyDir(inst.ModelID), taskID+".wav")
	if err := os.Rename(teePath, finalPath); err != nil {
		log.Printf("/v1/audio/speech 归档改名失败: %v", err)
		return
	}
	if err := h.history.RecordTTS(inst, request, taskID, map[string]any{
		"file":        taskID + ".wav",
		"size":        size,
		"durationSec": round3(info.DurationSec),
		"sampleRate":  info.SampleRate,
		"channels":    info.Channels,
		"via":         "v1/audio/speech",
	}, ""); err != nil {
		// Response may have already streamed; keep audio valid and log history failure.
		log.Printf("failed to archive v1 speech history: %v", err)
	}
}

// v1Error OpenAI 风格错误体：{"error":{"message","type"}}。
func v1Error(w http.ResponseWriter, status int, message string) {
	typ := "invalid_request_error"
	if status >= 500 {
		typ = "server_error"
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{"message": message, "type": typ},
	})
}

// ------------------------------------------------------------------ model 提取
// 移植 Java RequestModelExtractor：逐字节扫描顶层 JSON 对象，大字段原样跳过不落内存。

// extractV1Model 扫描请求体文件，返回顶层 "model" 字符串值；缺失/非字符串/为空返回 ""。
// 文件超过 maxBytes 报 413，顶层结构非法报 400。
func extractV1Model(path string, maxBytes int64) (string, error) {
	st, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if st.Size() > maxBytes {
		return "", &v1ProxyError{http.StatusRequestEntityTooLarge,
			fmt.Sprintf("Request body exceeds proxy limit of %d bytes", maxBytes)}
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	in := bufio.NewReaderSize(f, 64*1024)

	b, err := v1NextNonWS(in)
	if err != nil || b != '{' {
		return "", errV1InvalidJSON
	}
	model := ""
	firstField := true
	for {
		token, err := v1NextNonWS(in)
		if token == '}' {
			break
		}
		if err != nil {
			return "", errV1InvalidJSON
		}
		if !firstField {
			if token != ',' {
				return "", errV1InvalidJSON
			}
			if token, err = v1NextNonWS(in); err != nil {
				return "", errV1InvalidJSON
			}
		}
		firstField = false
		if token != '"' {
			return "", errV1InvalidJSON
		}
		fieldName, err := v1ReadJSONString(in)
		if err != nil {
			return "", err
		}
		colon, err := v1NextNonWS(in)
		if err != nil || colon != ':' {
			return "", errV1InvalidJSON
		}
		valueStart, err := v1NextNonWS(in)
		if err != nil {
			return "", errV1InvalidJSON
		}
		if fieldName == "model" {
			var capture bytes.Buffer
			lim := &v1LimitedWriter{w: &capture, limit: v1ModelCaptureLimit}
			if err := v1CopyValue(in, valueStart, lim); err != nil {
				if errors.Is(err, errV1CaptureLimit) {
					return "", &v1ProxyError{http.StatusBadRequest, "model value too large"}
				}
				return "", err
			}
			model = v1ParseModelValue(capture.Bytes())
		} else {
			// 大字段热点：原样跳过，不落内存
			if err := v1CopyValue(in, valueStart, io.Discard); err != nil {
				return "", err
			}
		}
	}
	return model, nil
}

// v1ParseModelValue 解析捕获到的 model 原始值，非 JSON 字符串/空白返回 ""。
func v1ParseModelValue(raw []byte) string {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return ""
	}
	if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
		return s
	}
	return ""
}

// v1CopyValue 按 JSON 值类型逐字节拷贝（跳过）到 out。
func v1CopyValue(in *bufio.Reader, firstByte byte, out io.Writer) error {
	switch {
	case firstByte == '"':
		return v1CopyString(in, out)
	case firstByte == '{' || firstByte == '[':
		return v1CopyComposite(in, firstByte, out)
	case v1IsPrimitiveStart(firstByte):
		return v1CopyPrimitive(in, firstByte, out)
	}
	return errV1InvalidJSON
}

func v1CopyString(in *bufio.Reader, out io.Writer) error {
	out.Write([]byte{'"'})
	escaped := false
	for {
		b, err := in.ReadByte()
		if err != nil {
			return errV1InvalidJSON
		}
		out.Write([]byte{b})
		if escaped {
			escaped = false
			continue
		}
		if b == '\\' {
			escaped = true
			continue
		}
		if b == '"' {
			return nil
		}
	}
}

func v1CopyComposite(in *bufio.Reader, firstByte byte, out io.Writer) error {
	objectDepth, arrayDepth := 0, 0
	if firstByte == '{' {
		objectDepth = 1
	} else {
		arrayDepth = 1
	}
	inString, escaped := false, false
	out.Write([]byte{firstByte})
	for objectDepth > 0 || arrayDepth > 0 {
		b, err := in.ReadByte()
		if err != nil {
			return errV1InvalidJSON
		}
		out.Write([]byte{b})
		if inString {
			if escaped {
				escaped = false
			} else if b == '\\' {
				escaped = true
			} else if b == '"' {
				inString = false
			}
			continue
		}
		switch b {
		case '"':
			inString = true
		case '{':
			objectDepth++
		case '}':
			objectDepth--
		case '[':
			arrayDepth++
		case ']':
			arrayDepth--
		}
	}
	return nil
}

func v1CopyPrimitive(in *bufio.Reader, firstByte byte, out io.Writer) error {
	out.Write([]byte{firstByte})
	for {
		b, err := in.ReadByte()
		if err != nil {
			return nil // EOF：原始值在文件尾结束
		}
		if v1IsValueTerminator(b) {
			in.UnreadByte()
			return nil
		}
		out.Write([]byte{b})
	}
}

func v1IsPrimitiveStart(b byte) bool {
	return b == 't' || b == 'f' || b == 'n' || b == '-' || (b >= '0' && b <= '9')
}

func v1IsValueTerminator(b byte) bool {
	return b == ',' || b == '}' || b == ']' || b == ' ' || b == '\t' || b == '\r' || b == '\n'
}

// v1NextNonWS 读下一个非空白字节；EOF 返回 (0, io.EOF)。
func v1NextNonWS(in *bufio.Reader) (byte, error) {
	for {
		b, err := in.ReadByte()
		if err != nil {
			return 0, err
		}
		// JSON 空白均为 ASCII，逐字节判断即可
		if b != ' ' && b != '\t' && b != '\r' && b != '\n' {
			return b, nil
		}
	}
}

// v1ReadJSONString 读取一个 JSON 字符串（开头引号已消费）并解码。
func v1ReadJSONString(in *bufio.Reader) (string, error) {
	var raw bytes.Buffer
	raw.WriteByte('"')
	escaped := false
	for {
		b, err := in.ReadByte()
		if err != nil {
			return "", errV1InvalidJSON
		}
		raw.WriteByte(b)
		if escaped {
			escaped = false
			continue
		}
		if b == '\\' {
			escaped = true
			continue
		}
		if b == '"' {
			break
		}
	}
	var s string
	if err := json.Unmarshal(raw.Bytes(), &s); err != nil {
		return "", errV1InvalidJSON
	}
	return s, nil
}

var errV1CaptureLimit = errors.New("capture limit exceeded")

// v1LimitedWriter 带容量上限的包装 Writer，超限报错。
type v1LimitedWriter struct {
	w     io.Writer
	limit int
	count int
}

func (l *v1LimitedWriter) Write(p []byte) (int, error) {
	l.count += len(p)
	if l.count > l.limit {
		return 0, errV1CaptureLimit
	}
	return l.w.Write(p)
}

// isMultipartForm 判断请求是否为 multipart/form-data（大小写不敏感，允许参数）。
func isMultipartForm(contentType string) bool {
	mt, _, err := mime.ParseMediaType(contentType)
	return err == nil && mt == "multipart/form-data"
}

// extractV1MultipartModel 从落盘的 multipart/form-data 请求体中读取表单字段 "model"。
// 逐 part 流式扫描，文件 part（音频）只跳过不入内存；缺字段返回 ""（由调用方回 400）。
func extractV1MultipartModel(path, contentType string) (string, error) {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil || params["boundary"] == "" {
		return "", &v1ProxyError{http.StatusBadRequest, "multipart/form-data request is missing its boundary"}
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	mr := multipart.NewReader(bufio.NewReader(f), params["boundary"])
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			return "", nil
		}
		if err != nil {
			return "", &v1ProxyError{http.StatusBadRequest, "Malformed multipart/form-data body"}
		}
		if part.FormName() != "model" || part.FileName() != "" {
			part.Close()
			continue
		}
		val, err := io.ReadAll(io.LimitReader(part, v1ModelCaptureLimit+1))
		part.Close()
		if err != nil {
			return "", &v1ProxyError{http.StatusBadRequest, "Malformed multipart/form-data body"}
		}
		if len(val) > v1ModelCaptureLimit {
			return "", &v1ProxyError{http.StatusBadRequest, "model field is too long"}
		}
		return strings.TrimSpace(string(val)), nil
	}
}

// noArchiveHeader lets a /v1/audio/speech caller skip history archiving; it is not forwarded.
const noArchiveHeader = "X-Hub-No-Archive"

// v1SpeechShouldArchive decides whether a successful /v1/audio/speech reply is archived.
// Precedence: JSON body "archive" (bool) > X-Hub-No-Archive header (truthy) > config default.
func v1SpeechShouldArchive(def bool, noArchiveHdr string, body map[string]any) bool {
	if v, ok := body["archive"].(bool); ok {
		return v
	}
	switch strings.ToLower(strings.TrimSpace(noArchiveHdr)) {
	case "1", "true", "yes", "on":
		return false
	}
	return def
}
