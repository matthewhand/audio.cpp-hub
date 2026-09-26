package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/matthewhand/audio.cpp-hub/internal/idvalidate"
)

// 下载管理器：多线程分段下载 + 断点续传 + 进度统计（移植自 Java 版 DownloadManager）。
// 任务状态落盘 data/downloads/<id>/task.json（原子写，约 1s 节流 + 状态迁移时）；
// 权重落盘 <modelsDir>/<targetDir>/，下载中的文件带 .part 后缀，完成校验后改名。
// 分段用 HTTP Range 请求 + os.File.WriteAt 写指定偏移（天然替代 Java 的 FileChannel）；
// 崩溃恢复时按 .part 实际大小收敛各分段进度（persisted done 一定对应已写入的字节，
// clamp 只损失少量进度，不会写坏文件）。远端不支持 Range 或大小未知的文件退化为
// 整流下载，中断后该文件从头重下。
// 与 Java 版的差异：暂停/取消不用异常，用每轮运行的 context cancel + runGeneration 代次。

const (
	dlChunkSize        = 64 * 1024
	dlMaxRetry         = 6 // 分段失败重试次数，退避 1s 翻倍封顶 15s
	dlPersistInterval  = time.Second
	dlShutdownWaitSecs = 6
	dlMaxFilesPerTask  = 512 // 单任务文件数上限，防止探测/分段资源被撑爆
	dlProbeWorkers     = 8   // 探测阶段的并发 worker 上限
	dlMaxRedirects     = 10  // 单次请求跟随重定向上限
)

// 任务状态（字符串与 Java 版枚举一致，task.json 可直接互读）。
const (
	dlStatusPending = "PENDING"
	dlStatusRunning = "RUNNING"
	dlStatusPaused  = "PAUSED"
	dlStatusDone    = "DONE"
	dlStatusFailed  = "FAILED"
)

// 控制信号：暂停（进度已落盘可续传）与取消（删除/被新 runner 接替，安静退出）。
var (
	errDlPaused    = errors.New("下载已暂停")
	errDlCancelled = errors.New("下载已取消")
)

// dlSegment 下载分段：[Start, End] 闭区间；End=-1 表示远端未给大小的整流下载。
type dlSegment struct {
	Start int64 `json:"start"`
	End   int64 `json:"end"`
	Done  int64 `json:"done"` // 原子访问
}

// dlFileEntry 单个待下载文件。
type dlFileEntry struct {
	Path          string      `json:"path"` // 相对目标目录的路径（统一用 / 分隔）
	URL           string      `json:"url"`
	Size          int64       `json:"size"` // 字节数，-1 表示未知
	SupportsRange bool        `json:"supportsRange"`
	Completed     bool        `json:"completed"` // 改名落盘完成后置 true，续传时跳过
	Segments      []dlSegment `json:"segments"`
}

// dlFileRequest 创建任务的文件请求项。
type dlFileRequest struct {
	URL  string
	Path string
}

// DownloadTask 下载任务数据模型，JSON 直接落盘 task.json。
// token 选择持久化（而非仅内存）以支持重启后 gated 仓库自动续传，但落盘文件权限
// 收敛为 0600、目录 0700，避免 world-readable 泄漏；API 输出始终剔除 token。
type DownloadTask struct {
	ID        string         `json:"id"`
	TargetDir string         `json:"targetDir"`
	ModelID   string         `json:"modelId,omitempty"`
	PackageID string         `json:"packageId,omitempty"`
	Source    string         `json:"source,omitempty"` // 下载源：hf / modelscope（显式 files 任务为空）
	Status    string         `json:"status"`
	Error     string         `json:"error,omitempty"`
	Token     string         `json:"token,omitempty"`
	CreatedAt int64          `json:"createdAt"`
	UpdatedAt int64          `json:"updatedAt"`
	Files     []*dlFileEntry `json:"files"`

	// ---- 以下为运行态字段，不落盘（原子访问）----
	pauseRequested   int32 `json:"-"` // 请求暂停（含进程退出），worker 在块边界响应
	cancelRequested  int32 `json:"-"` // 请求取消（delete）
	runGeneration    int32 `json:"-"` // 运行代次：resume/删除时递增，旧 worker 据此自杀
	lastPersistAt    int64 `json:"-"`
	speedBps         int64 `json:"-"`
	speedSampleAt    int64 `json:"-"`
	speedSampleBytes int64 `json:"-"`
	// 本轮运行的 context：暂停/取消/失败时 cancel，进行中的 HTTP 读立即中断
	runCtx context.Context    `json:"-"`
	cancel context.CancelFunc `json:"-"`
}

// totalBytes 已知大小文件的总字节数（未知大小的文件不计）。
func (t *DownloadTask) totalBytes() int64 {
	var total int64
	for _, f := range t.Files {
		if f.Size > 0 {
			total += f.Size
		}
	}
	return total
}

// downloadedBytes 已下载字节数（各分段 done 求和）。
func (t *DownloadTask) downloadedBytes() int64 {
	var total int64
	for _, f := range t.Files {
		for i := range f.Segments {
			total += atomic.LoadInt64(&f.Segments[i].Done)
		}
	}
	return total
}

func (t *DownloadTask) completedFiles() int {
	n := 0
	for _, f := range t.Files {
		if f.Completed {
			n++
		}
	}
	return n
}

// fileCompleted 读取文件完成标志：与写入方共用 m.mu 同步，避免数据竞争。
func (m *DownloadManager) fileCompleted(f *dlFileEntry) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return f.Completed
}

// markFileCompleted 在锁内标记文件完成并落盘。
func (m *DownloadManager) markFileCompleted(t *DownloadTask, f *dlFileEntry) {
	m.mu.Lock()
	f.Completed = true
	m.persistLocked(t)
	m.mu.Unlock()
}

// ------------------------------------------------------------------ 校验
// 下载路径校验统一走 internal/idvalidate 的 TargetDir / FilePath（见该包允许表说明）。

// validateDlURL 校验下载地址（仅 http/https）。
func validateDlURL(raw string) (string, error) {
	if !strings.HasPrefix(raw, "http://") && !strings.HasPrefix(raw, "https://") {
		return "", &UserError{Code: "INVALID_URL",
			Params: map[string]any{"url": raw}, Msg: "非法下载地址: " + raw}
	}
	return raw, nil
}

// dlAllowedDownloadHosts 内置允许的下载源主机：UI 固定选项（HF 官方/国内镜像）与 modelscope。
// 管理员配置的 hfEndpoint 会额外并入（可为本地/私有镜像）。
var dlAllowedDownloadHosts = map[string]struct{}{
	"huggingface.co":    {},
	"hf-mirror.com":     {},
	"modelscope.cn":     {},
	"www.modelscope.cn": {},
}

// dlURLHost 提取 URL 主机名（小写、不含端口与用户信息）；无法解析返回空串。
func dlURLHost(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Hostname())
}

// dlDisallowedIP 判定 IP 是否属于禁止访问的保留网段：回环、私有、链路本地、
// 组播、未指定、云元数据 / CGNAT / 基准测试网段。SSRF 防护核心，纯函数便于单测。
func dlDisallowedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsInterfaceLocalMulticast() ||
		ip.IsMulticast() || ip.IsUnspecified() {
		return true
	}
	if ip4 := ip.To4(); ip4 != nil {
		// 169.254.0.0/16（含 169.254.169.254 云元数据）已被 IsLinkLocalUnicast 覆盖，这里兜底
		if ip4[0] == 169 && ip4[1] == 254 {
			return true
		}
		if ip4[0] == 100 && ip4[1]&0xc0 == 64 { // 100.64.0.0/10 CGNAT
			return true
		}
		if ip4[0] == 198 && (ip4[1] == 18 || ip4[1] == 19) { // 198.18.0.0/15 基准测试
			return true
		}
		if ip4[0] == 192 && ip4[1] == 0 && ip4[2] == 0 { // 192.0.0.0/24 IETF 协议分配
			return true
		}
	}
	return false
}

// dlSSRFError 构造统一的 SSRF 拒绝错误。
func dlSSRFError(raw string) *UserError {
	return &UserError{Code: "DOWNLOAD_SSRF_BLOCKED",
		Params: map[string]any{"url": raw}, Msg: "下载地址指向内网/保留地址，已拒绝: " + raw}
}

// dlHTTPError HTTP 状态码到用户错误的映射：401/403→授权，404→远端不存在，其它→访问失败。
func dlHTTPError(code int, path string) *UserError {
	switch {
	case code == 401 || code == 403:
		return &UserError{Code: "DOWNLOAD_AUTH", Params: map[string]any{"path": path, "status": code},
			Msg: "下载需要授权（gated 仓库请提供 HF token）: " + path}
	case code == 404:
		return &UserError{Code: "REMOTE_NOT_FOUND", Params: map[string]any{"path": path},
			Msg: "远端文件不存在: " + path}
	default:
		return &UserError{Code: "HEAD_FAILED", Params: map[string]any{"path": path, "status": code},
			Msg: fmt.Sprintf("下载地址返回 HTTP %d: %s", code, path)}
	}
}

// ------------------------------------------------------------------ 管理器

// DownloadManager 单例，由 main 创建并注入 Hub。
type DownloadManager struct {
	modelsDir       string
	stateDir        string
	segmentsPerFile int
	httpClient      *http.Client
	sem             chan struct{}       // 全局分段并发限制（downloadThreads）
	shutdownFlag    int32               // 原子
	trustedHosts    map[string]struct{} // 管理员配置的下载源主机（信任，跳过 SSRF IP 限制）
	allowHosts      map[string]struct{} // hub 派生 URL 允许的下载源主机

	mu    sync.Mutex
	tasks map[string]*DownloadTask
	order []*DownloadTask // 创建顺序，列表输出反转（新→旧）
	wg    sync.WaitGroup  // runner goroutine 计数，退出时等待
}

// NewDownloadManager 创建下载管理器并回放 data/downloads/ 下未完成任务（自动续传）。
func NewDownloadManager(cfg HubConfig) *DownloadManager {
	modelsDir, err := filepath.Abs(cfg.ModelsDir)
	if err != nil {
		modelsDir = cfg.ModelsDir
	}
	threads := cfg.DownloadThreads
	if threads < 1 {
		threads = 1
	}
	segments := cfg.DownloadSegmentsPerFile
	if segments < 1 {
		segments = 1
	}
	// 只信任管理员显式配置的 hfEndpoint（可能是本地/私有镜像，需跳过 IP 限制）；
	// 内置公共下载源只加入允许列表，仍走 SSRF IP 校验。
	trusted := map[string]struct{}{}
	if h := dlURLHost(cfg.HfEndpoint); h != "" {
		trusted[h] = struct{}{}
	}
	allowed := map[string]struct{}{}
	for h := range dlAllowedDownloadHosts {
		allowed[h] = struct{}{}
	}
	if h := dlURLHost(modelscopeEndpoint); h != "" {
		allowed[h] = struct{}{}
	}
	for h := range trusted {
		allowed[h] = struct{}{}
	}
	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	// 连接时按解析出的真实 IP 做 SSRF 校验：覆盖重定向与 DNS rebinding（TOCTOU）。
	// 已配置的下载源主机视为管理员信任，直接按主机名拨号（支持本地镜像）。
	dialContext := func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		if _, ok := trusted[strings.ToLower(host)]; ok {
			return dialer.DialContext(ctx, network, addr)
		}
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		var lastErr error
		for _, ia := range ips {
			if dlDisallowedIP(ia.IP) {
				continue
			}
			conn, derr := dialer.DialContext(ctx, network, net.JoinHostPort(ia.IP.String(), port))
			if derr == nil {
				return conn, nil
			}
			lastErr = derr
		}
		if lastErr != nil {
			return nil, lastErr
		}
		return nil, fmt.Errorf("禁止连接内网地址: %s", host)
	}
	m := &DownloadManager{
		modelsDir:       modelsDir,
		stateDir:        filepath.Join("data", "downloads"),
		segmentsPerFile: segments,
		sem:             make(chan struct{}, threads),
		trustedHosts:    trusted,
		allowHosts:      allowed,
		tasks:           map[string]*DownloadTask{},
	}
	m.httpClient = &http.Client{
		// 跟随重定向（modelscope 会 302 到 CDN）；不设整体超时（大文件下载数小时正常），
		// 中断靠 request context
		Transport: &http.Transport{
			DialContext:           dialContext,
			MaxIdleConns:          64,
			MaxIdleConnsPerHost:   32,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   30 * time.Second,
			ResponseHeaderTimeout: 0,
		},
		// 重定向安全：限制跳转次数、跨主机丢弃 Authorization、逐跳 SSRF 复检
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= dlMaxRedirects {
				return fmt.Errorf("重定向次数过多（上限 %d）", dlMaxRedirects)
			}
			if prev := via[len(via)-1]; !strings.EqualFold(req.URL.Hostname(), prev.URL.Hostname()) {
				req.Header.Del("Authorization")
			}
			if _, err := m.guardDlURL(req.URL.String()); err != nil {
				return err
			}
			return nil
		},
	}
	if err := os.MkdirAll(m.modelsDir, 0755); err != nil {
		log.Printf("模型目录创建失败: %v", err)
	}
	if err := os.MkdirAll(m.stateDir, 0700); err != nil {
		log.Printf("下载状态目录创建失败: %v", err)
	}
	m.loadAll()
	return m
}

// isTrustedHost 判断主机是否属于管理员配置的下载源（hfEndpoint）。
func (m *DownloadManager) isTrustedHost(host string) bool {
	if host == "" {
		return false
	}
	_, ok := m.trustedHosts[strings.ToLower(host)]
	return ok
}

// isAllowedHost 判断主机是否属于 hub 派生 URL 允许的下载源（内置 + hfEndpoint + modelscope）。
func (m *DownloadManager) isAllowedHost(host string) bool {
	if host == "" {
		return false
	}
	_, ok := m.allowHosts[strings.ToLower(host)]
	return ok
}

// guardDlURL 校验下载地址：仅 http/https，且目标主机不得指向内网/回环/链路本地/
// 云元数据等保留地址。管理员配置的下载源主机属显式信任，跳过 IP 限制（支持本地镜像）。
func (m *DownloadManager) guardDlURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return "", &UserError{Code: "INVALID_URL",
			Params: map[string]any{"url": raw}, Msg: "非法下载地址: " + raw}
	}
	host := u.Hostname()
	if m.isTrustedHost(host) {
		return raw, nil
	}
	if ip := net.ParseIP(host); ip != nil {
		if dlDisallowedIP(ip) {
			return "", dlSSRFError(raw)
		}
		return raw, nil
	}
	ips, err := net.LookupIP(host)
	if err != nil || len(ips) == 0 {
		return "", &UserError{Code: "DOWNLOAD_HOST_UNRESOLVED",
			Params: map[string]any{"url": raw}, Msg: "无法解析下载地址主机: " + raw}
	}
	for _, ip := range ips {
		if dlDisallowedIP(ip) {
			return "", dlSSRFError(raw)
		}
	}
	return raw, nil
}

// ------------------------------------------------------------------ 任务生命周期

// Create 创建下载任务并立即开始：校验 → 并行探测大小/Range → 分段 → 磁盘空间检查 →
// 落盘 → 启动。用户可预期错误返回 *UserError。modelID/packageID/source 仅作来源记录（可空）。
func (m *DownloadManager) Create(targetDir string, files []dlFileRequest, token string,
	overwrite bool, modelID, packageID, source string) (map[string]any, error) {
	if _, err := idvalidate.TargetDir(targetDir); err != nil {
		return nil, toUserError(err)
	}
	if len(files) == 0 {
		return nil, &UserError{Code: "FILES_REQUIRED", Params: map[string]any{}, Msg: "files 不能为空"}
	}
	if len(files) > dlMaxFilesPerTask {
		return nil, &UserError{Code: "TOO_MANY_FILES",
			Params: map[string]any{"count": len(files), "max": dlMaxFilesPerTask},
			Msg:    fmt.Sprintf("文件数量超出上限（最多 %d 个）", dlMaxFilesPerTask)}
	}
	m.mu.Lock()
	for _, t := range m.order {
		if t.TargetDir == targetDir && dlActive(t.Status) {
			m.mu.Unlock()
			return nil, &UserError{Code: "DOWNLOAD_EXISTS",
				Params: map[string]any{"targetDir": targetDir, "id": t.ID},
				Msg:    "该目录已有进行中的下载任务: " + targetDir}
		}
	}
	m.mu.Unlock()

	seen := map[string]bool{}
	// hub 派生 = 来自清单/配置（modelID 或 source 非空）；其 URL 主机必须落在允许列表内。
	// 显式 files 任务只受 SSRF 限制，可下载任意公网地址。
	hubDerived := modelID != "" || source != ""
	entries := make([]*dlFileEntry, 0, len(files))
	for _, fr := range files {
		u, err := m.guardDlURL(fr.URL)
		if err != nil {
			return nil, err
		}
		if hubDerived && !m.isAllowedHost(dlURLHost(u)) {
			return nil, &UserError{Code: "DOWNLOAD_HOST_NOT_ALLOWED",
				Params: map[string]any{"url": u},
				Msg:    "下载源不在允许列表内（仅限 hfEndpoint / modelscope / 内置镜像）: " + u}
		}
		p, err := idvalidate.FilePath(fr.Path)
		if err != nil {
			return nil, toUserError(err)
		}
		if seen[p] {
			return nil, &UserError{Code: "DUPLICATE_FILE",
				Params: map[string]any{"path": p}, Msg: "重复文件: " + p}
		}
		seen[p] = true
		entries = append(entries, &dlFileEntry{Path: p, URL: u, Size: -1})
	}
	if err := m.probe(entries, token); err != nil {
		return nil, err
	}
	var need int64
	for _, e := range entries {
		e.Segments = m.buildSegments(e.Size, e.SupportsRange)
		if e.Size > 0 {
			need += e.Size
		}
	}
	if usable, ok := diskUsableSpace(m.modelsDir); ok {
		if need > 0 && float64(need)*1.05 > float64(usable) {
			return nil, &UserError{Code: "DISK_SPACE",
				Params: map[string]any{"need": need, "usable": usable},
				Msg:    fmt.Sprintf("磁盘空间不足：需要约 %d 字节，可用 %d 字节", need, usable)}
		}
	}
	for _, e := range entries {
		final := m.finalPath(targetDir, e.Path)
		if pathExists(final) {
			if !overwrite {
				return nil, &UserError{Code: "FILE_EXISTS",
					Params: map[string]any{"path": e.Path},
					Msg:    "目标文件已存在（如需重下请设置 overwrite）: " + e.Path}
			}
			os.Remove(final)
		}
		os.Remove(final + ".part")
	}

	t := &DownloadTask{
		ID:        newID(),
		TargetDir: targetDir,
		ModelID:   modelID,
		PackageID: packageID,
		Source:    source,
		Status:    dlStatusRunning,
		Token:     token,
		CreatedAt: time.Now().UnixMilli(),
		Files:     entries,
	}
	t.UpdatedAt = t.CreatedAt
	t.speedSampleBytes = -1

	m.mu.Lock()
	defer m.mu.Unlock()
	// 探测耗时较长，重新检查同目录任务（防并发创建）
	for _, o := range m.order {
		if o.TargetDir == targetDir && dlActive(o.Status) {
			return nil, &UserError{Code: "DOWNLOAD_EXISTS",
				Params: map[string]any{"targetDir": targetDir, "id": o.ID},
				Msg:    "该目录已有进行中的下载任务: " + targetDir}
		}
	}
	m.tasks[t.ID] = t
	m.order = append(m.order, t)
	m.persistLocked(t)
	m.startRunnerLocked(t)
	log.Printf("创建下载任务: %s -> %s (%d 个文件)", t.ID, targetDir, len(entries))
	return m.detailLocked(t), nil
}

// Pause 暂停任务（进行中的分段在块边界退出，进度落盘）。
func (m *DownloadManager) Pause(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, err := m.requireTaskLocked(id)
	if err != nil {
		return err
	}
	if t.Status != dlStatusRunning && t.Status != dlStatusPending {
		return &UserError{Code: "DOWNLOAD_STATE", Params: map[string]any{"status": t.Status},
			Msg: "任务不在进行中，无法暂停: " + t.Status}
	}
	atomic.StoreInt32(&t.pauseRequested, 1)
	t.Status = dlStatusPaused
	m.persistLocked(t)
	if t.cancel != nil {
		t.cancel() // 进行中的 HTTP 读立即中断
	}
	return nil
}

// Resume 继续任务（PAUSED/FAILED 均可重新排队，从各分段断点继续）。
func (m *DownloadManager) Resume(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, err := m.requireTaskLocked(id)
	if err != nil {
		return err
	}
	if t.Status != dlStatusPaused && t.Status != dlStatusFailed {
		return &UserError{Code: "DOWNLOAD_STATE", Params: map[string]any{"status": t.Status},
			Msg: "任务当前状态无法继续: " + t.Status}
	}
	atomic.StoreInt32(&t.pauseRequested, 0)
	t.Error = ""
	t.Status = dlStatusRunning
	m.persistLocked(t)
	m.startRunnerLocked(t)
	return nil
}

// Delete 取消并移除任务；purge=true 时删除残留的 .part（不动已完成改名的权重文件）。
func (m *DownloadManager) Delete(id string, purge bool) error {
	m.mu.Lock()
	t, err := m.requireTaskLocked(id)
	if err != nil {
		m.mu.Unlock()
		return err
	}
	atomic.StoreInt32(&t.cancelRequested, 1)
	atomic.AddInt32(&t.runGeneration, 1)
	if t.cancel != nil {
		t.cancel()
	}
	delete(m.tasks, id)
	for i, o := range m.order {
		if o == t {
			m.order = append(m.order[:i], m.order[i+1:]...)
			break
		}
	}
	// 在锁内只收集待删路径；带重试与 sleep 的实际磁盘删除移到锁外，
	// 避免 deleteWithRetry 的退避等待阻塞 List/Get。
	var parts []string
	if purge && t.Status != dlStatusDone {
		for _, f := range t.Files {
			parts = append(parts, m.finalPath(t.TargetDir, f.Path)+".part")
		}
	}
	dir := filepath.Join(m.stateDir, id)
	m.mu.Unlock()

	for _, p := range parts {
		m.deleteWithRetry(p)
	}
	m.deleteWithRetry(filepath.Join(dir, "task.json"))
	m.deleteWithRetry(filepath.Join(dir, "task.json.tmp"))
	m.deleteWithRetry(dir)
	log.Printf("删除下载任务: %s (purge=%v)", id, purge)
	return nil
}

// List 全部任务简要列表（新→旧），附带进度与速率。
func (m *DownloadManager) List() []map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]map[string]any, 0, len(m.order))
	for i := len(m.order) - 1; i >= 0; i-- {
		t := m.order[i]
		m.sampleSpeed(t)
		o := map[string]any{
			"id":              t.ID,
			"targetDir":       t.TargetDir,
			"status":          t.Status,
			"createdAt":       t.CreatedAt,
			"updatedAt":       t.UpdatedAt,
			"fileCount":       len(t.Files),
			"completedFiles":  t.completedFiles(),
			"totalBytes":      t.totalBytes(),
			"downloadedBytes": t.downloadedBytes(),
			"percent":         dlPercent(t),
			"speedBps":        atomic.LoadInt64(&t.speedBps),
		}
		if t.ModelID != "" {
			o["modelId"] = t.ModelID
		}
		if t.Source != "" {
			o["source"] = t.Source
		}
		if t.Error != "" {
			o["error"] = t.Error
		}
		out = append(out, o)
	}
	return out
}

// Get 单任务详情（含 files/segments；剔除 token）。
func (m *DownloadManager) Get(id string) (map[string]any, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, err := m.requireTaskLocked(id)
	if err != nil {
		return nil, err
	}
	return m.detailLocked(t), nil
}

// Shutdown 进程退出：进行中的任务转暂停（进度落盘，下次启动自动续传），
// 等分段 goroutine 退出，超时强制返回。
func (m *DownloadManager) Shutdown() {
	atomic.StoreInt32(&m.shutdownFlag, 1)
	m.mu.Lock()
	for _, t := range m.order {
		if t.Status == dlStatusRunning || t.Status == dlStatusPending {
			atomic.StoreInt32(&t.pauseRequested, 1)
			if t.cancel != nil {
				t.cancel()
			}
		}
	}
	m.mu.Unlock()
	done := make(chan struct{})
	go func() {
		m.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(dlShutdownWaitSecs * time.Second):
		log.Printf("等待下载任务退出超时，强制退出")
	}
}

// ------------------------------------------------------------------ 运行循环

// startRunnerLocked 启动该任务的运行 goroutine（调用方需持有 m.mu）。
func (m *DownloadManager) startRunnerLocked(t *DownloadTask) {
	gen := atomic.AddInt32(&t.runGeneration, 1)
	t.runCtx, t.cancel = context.WithCancel(context.Background())
	m.wg.Add(1)
	go m.runTask(t, gen, t.runCtx)
}

func (m *DownloadManager) runTask(t *DownloadTask, gen int32, ctx context.Context) {
	defer m.wg.Done()
	defer func() {
		atomic.StoreInt64(&t.speedBps, 0)
		atomic.StoreInt64(&t.speedSampleBytes, -1)
	}()
	err := m.runTaskInner(t, gen, ctx)
	// context 中断导致的杂散错误统一归一到暂停/取消语义
	if err != nil && !errors.Is(err, errDlPaused) && !errors.Is(err, errDlCancelled) {
		if ferr := m.checkFlags(t, gen); ferr != nil {
			err = ferr
		}
	}
	switch {
	case err == nil:
		m.mu.Lock()
		if atomic.LoadInt32(&t.runGeneration) != gen {
			m.mu.Unlock()
			return
		}
		t.Status = dlStatusDone
		t.Error = ""
		m.persistLocked(t)
		m.mu.Unlock()
		log.Printf("下载完成: %s -> %s", t.ID, t.TargetDir)
	case errors.Is(err, errDlPaused):
		m.mu.Lock()
		if t.Status == dlStatusRunning || t.Status == dlStatusPending {
			t.Status = dlStatusPaused
			m.persistLocked(t)
		}
		m.mu.Unlock()
	case errors.Is(err, errDlCancelled):
		// 任务已被删除或被新一轮 runner 接替，安静退出
	default:
		m.mu.Lock()
		// 递增代次并 cancel，让残余分段 goroutine 尽快退出
		atomic.AddInt32(&t.runGeneration, 1)
		if t.cancel != nil {
			t.cancel()
		}
		t.Status = dlStatusFailed
		t.Error = summarize(err.Error())
		m.persistLocked(t)
		m.mu.Unlock()
		log.Printf("下载任务失败 %s: %v", t.ID, err)
	}
}

func (m *DownloadManager) runTaskInner(t *DownloadTask, gen int32, ctx context.Context) error {
	m.reconcile(t)
	for _, f := range t.Files {
		if err := m.checkFlags(t, gen); err != nil {
			return err
		}
		if m.fileCompleted(f) {
			continue
		}
		if err := m.downloadFile(t, f, gen, ctx); err != nil {
			return err
		}
	}
	return nil
}

// reconcile 崩溃恢复：按 .part 实际大小收敛各分段 done。
// persisted done 一定对应已写入字节；clamp 只损失未落盘的少量进度。
func (m *DownloadManager) reconcile(t *DownloadTask) {
	for _, f := range t.Files {
		if m.fileCompleted(f) || len(f.Segments) == 0 {
			continue
		}
		var partSize int64
		if st, err := os.Stat(m.finalPath(t.TargetDir, f.Path) + ".part"); err == nil {
			partSize = st.Size()
		}
		for i := range f.Segments {
			seg := &f.Segments[i]
			if seg.End < 0 {
				atomic.StoreInt64(&seg.Done, 0)
				continue
			}
			done := atomic.LoadInt64(&seg.Done)
			if max := partSize - seg.Start; done > max {
				done = max
			}
			if done < 0 {
				done = 0
			}
			atomic.StoreInt64(&seg.Done, done)
		}
	}
}

func (m *DownloadManager) downloadFile(t *DownloadTask, f *dlFileEntry, gen int32, ctx context.Context) error {
	final := m.finalPath(t.TargetDir, f.Path)
	if parent := filepath.Dir(final); parent != "" {
		if err := os.MkdirAll(parent, 0755); err != nil {
			return err
		}
	}
	part := final + ".part"
	if f.Size > 0 && !m.fileCompleted(f) {
		if st, err := os.Stat(final); err == nil && st.Mode().IsRegular() && st.Size() == f.Size {
			// 上次在改名后、落盘前崩溃：直接判定完成
			os.Remove(part)
			m.markFileCompleted(t, f)
			return nil
		}
	}
	if len(f.Segments) == 1 && f.Segments[0].End < 0 {
		return m.streamFile(t, f, part, final, gen, ctx)
	}
	ch, err := os.OpenFile(part, os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	// 同文件分段并发下载；任一分段失败即取消本文件其余分段
	fctx, fcancel := context.WithCancel(ctx)
	defer fcancel()
	var wg sync.WaitGroup
	results := make(chan error, len(f.Segments))
	n := 0
	for i := range f.Segments {
		seg := &f.Segments[i]
		if atomic.LoadInt64(&seg.Done) >= seg.End-seg.Start+1 {
			continue
		}
		n++
		wg.Add(1)
		go func() {
			defer wg.Done()
			m.sem <- struct{}{}
			defer func() { <-m.sem }()
			results <- m.downloadSegment(t, f, seg, ch, gen, fctx)
		}()
	}
	wg.Wait()
	ch.Close()
	close(results)
	var firstErr error
	for err := range results {
		if err == nil {
			continue
		}
		if firstErr == nil || (errors.Is(firstErr, context.Canceled) && !errors.Is(err, context.Canceled)) {
			firstErr = err
		}
		fcancel()
	}
	if firstErr != nil {
		return firstErr
	}
	var total int64
	for i := range f.Segments {
		total += atomic.LoadInt64(&f.Segments[i].Done)
	}
	if f.Size > 0 && total != f.Size {
		return fmt.Errorf("分段字节总量与预期不符: %d != %d", total, f.Size)
	}
	if err := movePartFile(part, final); err != nil {
		return err
	}
	m.markFileCompleted(t, f)
	return nil
}

// downloadSegment 分段 worker：Range 请求 + 64KB 块 WriteAt 指定偏移，失败退避重试。
func (m *DownloadManager) downloadSegment(t *DownloadTask, f *dlFileEntry, seg *dlSegment,
	ch *os.File, gen int32, ctx context.Context) error {
	for attempt := 1; ; attempt++ {
		if err := m.checkFlags(t, gen); err != nil {
			return err
		}
		pos := seg.Start + atomic.LoadInt64(&seg.Done)
		if pos > seg.End {
			return nil
		}
		err := m.fetchSegment(t, f, seg, ch, pos, gen, ctx)
		if err == nil {
			return nil
		}
		if ferr := m.checkFlags(t, gen); ferr != nil {
			return ferr
		}
		if errors.Is(err, context.Canceled) {
			return err // 同文件其它分段失败触发的取消
		}
		if attempt >= dlMaxRetry {
			return fmt.Errorf("分段下载失败（重试 %d 次）: %s: %w", dlMaxRetry, f.Path, err)
		}
		if berr := dlSleepBackoff(ctx, attempt); berr != nil {
			if ferr := m.checkFlags(t, gen); ferr != nil {
				return ferr
			}
			return berr
		}
	}
}

// fetchSegment 执行一次分段请求：从 pos 续传到 seg.End。
func (m *DownloadManager) fetchSegment(t *DownloadTask, f *dlFileEntry, seg *dlSegment,
	ch *os.File, pos int64, gen int32, ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.URL, nil)
	if err != nil {
		return err
	}
	if t.Token != "" {
		req.Header.Set("Authorization", "Bearer "+t.Token)
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", pos, seg.End))
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return dlHTTPError(resp.StatusCode, f.Path)
	}
	// 服务器忽略 Range 返回 200：仅全文件起点可接受，否则写入位置会错。
	// 注意 modelscope 的怪癖：分段请求回 200 但带 Content-Range，校验起始偏移后视为正常分段响应
	if resp.StatusCode == http.StatusOK && pos != 0 {
		if start, ok := parseContentRangeStart(resp.Header.Get("Content-Range")); !ok || start != pos {
			return fmt.Errorf("服务器忽略了 Range 请求: %s", f.Path)
		}
	}
	buf := make([]byte, dlChunkSize)
	for {
		if ferr := m.checkFlags(t, gen); ferr != nil {
			return ferr
		}
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := ch.WriteAt(buf[:n], pos); werr != nil {
				return werr
			}
			pos += int64(n)
			atomic.StoreInt64(&seg.Done, pos-seg.Start)
			m.maybePersist(t)
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	if pos <= seg.End {
		return fmt.Errorf("响应体提前结束: %s", f.Path)
	}
	return nil
}

// streamFile 整流下载（远端无大小/不支持 Range）：TRUNCATE 重写，中断后该文件从头重下。
func (m *DownloadManager) streamFile(t *DownloadTask, f *dlFileEntry, part, final string,
	gen int32, ctx context.Context) error {
	seg := &f.Segments[0]
	for attempt := 1; ; attempt++ {
		if err := m.checkFlags(t, gen); err != nil {
			return err
		}
		atomic.StoreInt64(&seg.Done, 0)
		err := m.fetchStream(t, f, seg, part, gen, ctx)
		if err == nil {
			break
		}
		if ferr := m.checkFlags(t, gen); ferr != nil {
			return ferr
		}
		if attempt >= dlMaxRetry {
			return fmt.Errorf("整流下载失败（重试 %d 次）: %s: %w", dlMaxRetry, f.Path, err)
		}
		if berr := dlSleepBackoff(ctx, attempt); berr != nil {
			if ferr := m.checkFlags(t, gen); ferr != nil {
				return ferr
			}
			return berr
		}
	}
	if f.Size > 0 && atomic.LoadInt64(&seg.Done) != f.Size {
		return fmt.Errorf("文件大小不符: %d != %d", atomic.LoadInt64(&seg.Done), f.Size)
	}
	if err := movePartFile(part, final); err != nil {
		return err
	}
	m.markFileCompleted(t, f)
	return nil
}

// fetchStream 执行一次整流请求（不带 Range）。
func (m *DownloadManager) fetchStream(t *DownloadTask, f *dlFileEntry, seg *dlSegment,
	part string, gen int32, ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.URL, nil)
	if err != nil {
		return err
	}
	if t.Token != "" {
		req.Header.Set("Authorization", "Bearer "+t.Token)
	}
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return dlHTTPError(resp.StatusCode, f.Path)
	}
	out, err := os.OpenFile(part, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer out.Close()
	var pos int64
	buf := make([]byte, dlChunkSize)
	for {
		if ferr := m.checkFlags(t, gen); ferr != nil {
			return ferr
		}
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := out.Write(buf[:n]); werr != nil {
				return werr
			}
			pos += int64(n)
			atomic.StoreInt64(&seg.Done, pos)
			m.maybePersist(t)
		}
		if readErr == io.EOF {
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}

// ------------------------------------------------------------------ 探测与分段

// probe 并行探测每个文件的大小与 Range 支持：先 HEAD；HEAD 成功但拿不到
// Content-Length 时（modelscope 的坑）回退 GET + Range: bytes=0-0，从 206 响应的
// Content-Range 解析总大小。失败返回 *UserError。
func (m *DownloadManager) probe(entries []*dlFileEntry, token string) error {
	var wg sync.WaitGroup
	errs := make([]error, len(entries))
	sem := make(chan struct{}, dlProbeWorkers) // 限制并发探测，避免每文件一 goroutine 无界膨胀
	for i := range entries {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			errs[i] = m.probeOne(entries[i], token)
		}(i)
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

func (m *DownloadManager) probeOne(e *dlFileEntry, token string) error {
	size, supportsRange, err := m.probeHead(e, token)
	if err != nil {
		return err
	}
	if size >= 0 {
		e.Size = size
		e.SupportsRange = supportsRange
		return nil
	}
	// HEAD 未给大小：回退 GET Range bytes=0-0（GET 跟随重定向，modelscope 302 到 CDN 后正常支持 Range）
	return m.probeRangeGet(e, token)
}

// probeHead HEAD 探测：返回 (大小, 是否支持 Range, 错误)；大小未知返回 -1。
func (m *DownloadManager) probeHead(e *dlFileEntry, token string) (int64, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, e.URL, nil)
	if err != nil {
		return -1, false, &UserError{Code: "HEAD_FAILED",
			Params: map[string]any{"path": e.Path, "msg": summarize(err.Error())},
			Msg:    "无法访问下载地址: " + e.Path}
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return -1, false, &UserError{Code: "HEAD_FAILED",
			Params: map[string]any{"path": e.Path, "msg": summarize(err.Error())},
			Msg:    "无法访问下载地址: " + e.Path}
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return -1, false, dlHTTPError(resp.StatusCode, e.Path)
	}
	supportsRange := strings.Contains(strings.ToLower(resp.Header.Get("Accept-Ranges")), "bytes")
	return resp.ContentLength, supportsRange, nil
}

// probeRangeGet 回退探测：GET Range bytes=0-0，从 Content-Range 解析总大小
// （modelscope 回 200 但也带 Content-Range，不能只看 206）；服务器真忽略 Range
// 回 200 且无 Content-Range 时取 Content-Length、标记不支持分段。
func (m *DownloadManager) probeRangeGet(e *dlFileEntry, token string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, e.URL, nil)
	if err != nil {
		return &UserError{Code: "HEAD_FAILED",
			Params: map[string]any{"path": e.Path, "msg": summarize(err.Error())},
			Msg:    "无法访问下载地址: " + e.Path}
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Range", "bytes=0-0")
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return &UserError{Code: "HEAD_FAILED",
			Params: map[string]any{"path": e.Path, "msg": summarize(err.Error())},
			Msg:    "无法访问下载地址: " + e.Path}
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, dlChunkSize))
	if resp.StatusCode >= 400 {
		return dlHTTPError(resp.StatusCode, e.Path)
	}
	// Content-Range: bytes 0-0/<total>（200 或 206 都可能带）
	if total := parseContentRangeTotal(resp.Header.Get("Content-Range")); total >= 0 {
		e.Size = total
		e.SupportsRange = true
		return nil
	}
	if resp.StatusCode == http.StatusPartialContent {
		// 206 但无法解析大小：退化为整流
		e.Size = -1
		e.SupportsRange = false
		return nil
	}
	e.Size = resp.ContentLength
	e.SupportsRange = false
	return nil
}

// parseContentRangeTotal 解析 Content-Range 头的总大小（/ 之后部分）；失败或 * 返回 -1。
func parseContentRangeTotal(cr string) int64 {
	i := strings.LastIndex(cr, "/")
	if i < 0 {
		return -1
	}
	total, err := strconv.ParseInt(strings.TrimSpace(cr[i+1:]), 10, 64)
	if err != nil {
		return -1
	}
	return total
}

// parseContentRangeStart 解析 Content-Range 头的起始偏移（"bytes <start>-<end>/<total>"）。
func parseContentRangeStart(cr string) (int64, bool) {
	s := strings.TrimSpace(cr)
	i := strings.IndexByte(s, ' ')
	if i < 0 {
		return 0, false
	}
	rng := s[i+1:]
	j := strings.IndexByte(rng, '-')
	if j < 0 {
		return 0, false
	}
	start, err := strconv.ParseInt(strings.TrimSpace(rng[:j]), 10, 64)
	if err != nil {
		return 0, false
	}
	return start, true
}

// buildSegments 分段：n = clamp(ceil(size / 32MB), 1, segmentsPerFile)；
// 未知大小/不支持 Range 退化为单段整流（end=-1）。
func (m *DownloadManager) buildSegments(size int64, supportsRange bool) []dlSegment {
	if size <= 0 || !supportsRange {
		return []dlSegment{{Start: 0, End: -1}}
	}
	n := (size + dlSegmentMin - 1) / dlSegmentMin
	if n < 1 {
		n = 1
	}
	if n > int64(m.segmentsPerFile) {
		n = int64(m.segmentsPerFile)
	}
	step := (size + n - 1) / n
	list := make([]dlSegment, 0, n)
	for i := int64(0); i < n; i++ {
		end := (i+1)*step - 1
		if end > size-1 {
			end = size - 1
		}
		list = append(list, dlSegment{Start: i * step, End: end})
	}
	return list
}

// ------------------------------------------------------------------ 内部工具

// checkFlags 块边界检查控制标志：代次不符/取消 → errDlCancelled；暂停/关停 → errDlPaused。
func (m *DownloadManager) checkFlags(t *DownloadTask, gen int32) error {
	if atomic.LoadInt32(&t.runGeneration) != gen || atomic.LoadInt32(&t.cancelRequested) == 1 {
		return errDlCancelled
	}
	if atomic.LoadInt32(&t.pauseRequested) == 1 || atomic.LoadInt32(&m.shutdownFlag) == 1 {
		return errDlPaused
	}
	return nil
}

func (m *DownloadManager) maybePersist(t *DownloadTask) {
	now := time.Now().UnixMilli()
	if now-atomic.LoadInt64(&t.lastPersistAt) < dlPersistInterval.Milliseconds() {
		return
	}
	m.mu.Lock()
	if now-t.lastPersistAt >= dlPersistInterval.Milliseconds() {
		m.persistLocked(t)
	}
	m.mu.Unlock()
}

// persistLocked 原子写 task.json（tmp + rename，0600：含 token，不可 world-readable）；
// 调用方需持有 m.mu。
func (m *DownloadManager) persistLocked(t *DownloadTask) {
	t.UpdatedAt = time.Now().UnixMilli()
	atomic.StoreInt64(&t.lastPersistAt, t.UpdatedAt)
	dir := filepath.Join(m.stateDir, t.ID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		log.Printf("下载进度落盘失败 %s: %v", t.ID, err)
		return
	}
	// 序列化锁定快照（Done 原子读 + Completed 锁内读），不对并发写的活结构体直接反射
	data, err := json.Marshal(m.snapshotLocked(t))
	if err != nil {
		log.Printf("下载进度序列化失败 %s: %v", t.ID, err)
		return
	}
	if err := writeFileAtomicMode(filepath.Join(dir, "task.json"), data, 0600); err != nil {
		log.Printf("下载进度落盘失败 %s: %v", t.ID, err)
	}
}

// dlTaskDisk 落盘/展示用的任务快照：只含可持久化字段，不含运行态原子字段，
// 因此可安全 json.Marshal，不会与被 worker 并发写的活结构体产生数据竞争。
type dlTaskDisk struct {
	ID        string         `json:"id"`
	TargetDir string         `json:"targetDir"`
	ModelID   string         `json:"modelId,omitempty"`
	PackageID string         `json:"packageId,omitempty"`
	Source    string         `json:"source,omitempty"`
	Status    string         `json:"status"`
	Error     string         `json:"error,omitempty"`
	Token     string         `json:"token,omitempty"`
	CreatedAt int64          `json:"createdAt"`
	UpdatedAt int64          `json:"updatedAt"`
	Files     []*dlFileEntry `json:"files"`
}

// snapshotLocked 复制任务用于序列化：分段 Done 用 atomic.LoadInt64 取值，Completed
// 在锁内读取，且不复制运行态原子字段（避免 atomic-vs-plain 数据竞争）。
// 调用方需持有 m.mu。
func (m *DownloadManager) snapshotLocked(t *DownloadTask) *dlTaskDisk {
	files := make([]*dlFileEntry, len(t.Files))
	for i, f := range t.Files {
		fc := *f
		fc.Segments = make([]dlSegment, len(f.Segments))
		for j := range f.Segments {
			src := &f.Segments[j]
			// 只按原子读 Done；Start/End 在 buildSegments 后不再变更，可安全直读
			fc.Segments[j] = dlSegment{Start: src.Start, End: src.End, Done: atomic.LoadInt64(&src.Done)}
		}
		files[i] = &fc
	}
	return &dlTaskDisk{
		ID:        t.ID,
		TargetDir: t.TargetDir,
		ModelID:   t.ModelID,
		PackageID: t.PackageID,
		Source:    t.Source,
		Status:    t.Status,
		Error:     t.Error,
		Token:     t.Token,
		CreatedAt: t.CreatedAt,
		UpdatedAt: t.UpdatedAt,
		Files:     files,
	}
}

// writeFileAtomicMode 同 writeFileAtomic，但显式指定权限（task.json 含 token，用 0600）。
func writeFileAtomicMode(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	// 历史 tmp 可能是更宽松的权限，显式收敛
	if err := os.Chmod(tmp, perm); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// sampleSpeed 速率采样：每次查询时按时间窗增量估算 bytes/s；非 RUNNING 归零。
// 调用方需持有 m.mu。
func (m *DownloadManager) sampleSpeed(t *DownloadTask) {
	if t.Status != dlStatusRunning {
		atomic.StoreInt64(&t.speedBps, 0)
		atomic.StoreInt64(&t.speedSampleBytes, -1)
		return
	}
	now := time.Now().UnixMilli()
	bytes := t.downloadedBytes()
	prevBytes := atomic.LoadInt64(&t.speedSampleBytes)
	prevAt := atomic.LoadInt64(&t.speedSampleAt)
	if prevBytes >= 0 && now > prevAt {
		bps := (bytes - prevBytes) * 1000 / (now - prevAt)
		if bps < 0 {
			bps = 0
		}
		atomic.StoreInt64(&t.speedBps, bps)
	}
	atomic.StoreInt64(&t.speedSampleBytes, bytes)
	atomic.StoreInt64(&t.speedSampleAt, now)
}

func dlPercent(t *DownloadTask) int64 {
	total := t.totalBytes()
	if total <= 0 {
		return -1
	}
	return t.downloadedBytes() * 100 / total
}

// detailLocked 详情 JSON：任务全字段（剔除 token）+ 进度/速率派生字段。调用方需持有 m.mu。
func (m *DownloadManager) detailLocked(t *DownloadTask) map[string]any {
	m.sampleSpeed(t)
	o := map[string]any{
		"id":              t.ID,
		"targetDir":       t.TargetDir,
		"status":          t.Status,
		"createdAt":       t.CreatedAt,
		"updatedAt":       t.UpdatedAt,
		"files":           m.snapshotLocked(t).Files,
		"fileCount":       len(t.Files),
		"completedFiles":  t.completedFiles(),
		"totalBytes":      t.totalBytes(),
		"downloadedBytes": t.downloadedBytes(),
		"percent":         dlPercent(t),
		"speedBps":        atomic.LoadInt64(&t.speedBps),
	}
	if t.ModelID != "" {
		o["modelId"] = t.ModelID
	}
	if t.PackageID != "" {
		o["packageId"] = t.PackageID
	}
	if t.Source != "" {
		o["source"] = t.Source
	}
	if t.Error != "" {
		o["error"] = t.Error
	}
	return o
}

func (m *DownloadManager) requireTaskLocked(id string) (*DownloadTask, error) {
	t := m.tasks[id]
	if t == nil {
		return nil, &UserError{Code: "DOWNLOAD_NOT_FOUND",
			Params: map[string]any{"id": id}, Msg: "下载任务不存在: " + id}
	}
	return t, nil
}

func (m *DownloadManager) finalPath(targetDir, rel string) string {
	return filepath.Join(m.modelsDir, targetDir, filepath.FromSlash(rel))
}

// loadAll 启动时回放 data/downloads/<id>/task.json；RUNNING/PENDING 任务自动续传。
func (m *DownloadManager) loadAll() {
	dirs, err := os.ReadDir(m.stateDir)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("下载状态目录不可读: %v", err)
		}
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		taskFile := filepath.Join(m.stateDir, d.Name(), "task.json")
		data, err := os.ReadFile(taskFile)
		if err != nil {
			continue
		}
		// 收敛历史文件的宽松权限（旧版本以 0644 落盘，含 token）
		_ = os.Chmod(taskFile, 0600)
		var t DownloadTask
		if err := json.Unmarshal(data, &t); err != nil || t.ID == "" || t.TargetDir == "" {
			log.Printf("下载任务状态损坏，忽略 %s", taskFile)
			continue
		}
		// 回放持久化状态前重新校验（data/ 可能被本地篡改）：ID 必须与目录名一致且可安全
		// 用作路径片段，targetDir/每个文件相对路径必须通过下载路径校验，否则拒绝恢复，
		// 避免越权写删 models/ 之外的文件。
		if t.ID != d.Name() || !idvalidate.SafeID(t.ID) {
			log.Printf("下载任务 ID 非法，忽略 %s", taskFile)
			continue
		}
		if clean, err := idvalidate.TargetDir(t.TargetDir); err != nil || clean != t.TargetDir {
			log.Printf("下载任务目标目录非法，忽略 %s", taskFile)
			continue
		}
		badPath := false
		for _, f := range t.Files {
			if f == nil {
				badPath = true
				break
			}
			if clean, err := idvalidate.FilePath(f.Path); err != nil || clean != f.Path {
				badPath = true
				break
			}
		}
		if badPath {
			log.Printf("下载任务文件路径非法，忽略 %s", taskFile)
			continue
		}
		t.speedSampleBytes = -1
		m.tasks[t.ID] = &t
		m.order = append(m.order, &t)
	}
	for _, t := range m.order {
		if t.Status == dlStatusRunning || t.Status == dlStatusPending {
			t.Status = dlStatusRunning
			t.Error = ""
			log.Printf("恢复下载任务: %s -> %s", t.ID, t.TargetDir)
			m.startRunnerLocked(t)
		}
	}
}

// deleteWithRetry 删除带重试：分段 goroutine 退出与文件句柄释放有延迟（尤其 Windows）。
func (m *DownloadManager) deleteWithRetry(path string) {
	for i := 0; i < 3; i++ {
		if err := os.Remove(path); err == nil || os.IsNotExist(err) {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	if pathExists(path) {
		log.Printf("删除失败（已重试）: %s", path)
	}
}

// movePartFile .part 改名落盘（Windows 下目标存在会导致改名失败，先删）。
func movePartFile(src, dst string) error {
	os.Remove(dst)
	return os.Rename(src, dst)
}

// dlSleepBackoff 重试退避：1s 翻倍封顶 15s；context 中断立即返回。
func dlSleepBackoff(ctx context.Context, attempt int) error {
	d := time.Second << (attempt - 1)
	if d > 15*time.Second {
		d = 15 * time.Second
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func dlActive(status string) bool {
	return status == dlStatusRunning || status == dlStatusPaused || status == dlStatusPending
}
