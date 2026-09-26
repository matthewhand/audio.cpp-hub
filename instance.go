package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// Instance 一个 audiocpp_server 进程实例。只有 STARTING/READY 的实例存在于管理器中。
type Instance struct {
	ID             string
	Name           string // 服务名（instanceName）：/v1/* 路由键，写进 server.json 的 model id
	ModelID        string
	WeightsPath    string
	Port           int
	Backend        string
	Device         *int
	ExecName       string
	Threads        *int
	SessionOptions map[string]string
	Status         string // STARTING / READY
	CreatedAt      string

	cmd    *exec.Cmd
	exited chan int // 进程退出后收到 exit code
}

// Event 事件日志条目（GET /api/events）。
type Event struct {
	Time    string `json:"time"`
	Level   string `json:"level"`
	Message string `json:"message"`
}

var instanceNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

const healthTimeoutSeconds = 120

// logTailBytes readLogTail 从日志末尾读取的最大字节数。
const logTailBytes = 64 << 10

// InstanceManager 子进程生命周期、端口分配、健康轮询、run/<id> 清理。
type InstanceManager struct {
	mu       sync.Mutex
	portBase int
	hubPort  int // hub 自身监听端口，实例不得占用
	items    map[string]*Instance
	events   []Event // 新到旧，保留 20 条

	// startMu 串行化 Start，使“校验服务名 + 预占端口 + 登记占位实例”成为原子操作。
	startMu sync.Mutex

	healthClient *http.Client
}

func NewInstanceManager(portBase, hubPort int) *InstanceManager {
	return &InstanceManager{
		portBase:     portBase,
		hubPort:      hubPort,
		items:        map[string]*Instance{},
		healthClient: &http.Client{Timeout: 2 * time.Second},
	}
}

// StartParams 启动一个实例所需的全部参数。
type StartParams struct {
	ModelID        string
	EngineFamily   string
	WeightsPath    string
	Backend        string
	Device         *int
	Port           *int
	Threads        *int
	ExecPath       string
	ExecName       string
	ServerTask     string
	Env            map[string]string
	Name           string
	SessionOptions map[string]string
}

func (m *InstanceManager) List() []*Instance {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*Instance, 0, len(m.items))
	for _, inst := range m.items {
		out = append(out, inst)
	}
	return out
}

func (m *InstanceManager) Get(id string) *Instance {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.items[id]
}

// FindByName 按服务名查找 READY 实例（/v1/* 路由键）。
func (m *InstanceManager) FindByName(name string) *Instance {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, inst := range m.items {
		if inst.Name == name && inst.Status == "READY" {
			return inst
		}
	}
	return nil
}

// FindAnyByName 按服务名查找任意状态实例（区分 404 不存在与 409 启动中）。
func (m *InstanceManager) FindAnyByName(name string) *Instance {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, inst := range m.items {
		if inst.Name == name {
			return inst
		}
	}
	return nil
}

func (m *InstanceManager) Events() []Event {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Event, len(m.events))
	copy(out, m.events)
	return out
}

func (m *InstanceManager) addEvent(level, message string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.events = append([]Event{{
		Time:    time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Level:   level,
		Message: message,
	}}, m.events...)
	if len(m.events) > 20 {
		m.events = m.events[:20]
	}
}

// Start 拉起一个实例，立即返回（STARTING），后台 goroutine 轮询健康状态。
func (m *InstanceManager) Start(p StartParams) (*Instance, error) {
	name := strings.TrimSpace(p.Name)
	if name == "" {
		name = p.ModelID
	}
	if !instanceNamePattern.MatchString(name) {
		return nil, newUserError("INSTANCE_NAME_INVALID", "服务名不合法（字母数字开头，可含 . _ -，最长 64）: "+name)
	}

	// 串行化启动：配合 reserve 让“校验服务名 + 预占端口 + 登记占位实例”成为原子操作，
	// 避免并发启动产生重复服务名或两个子进程争抢同一端口。
	m.startMu.Lock()
	defer m.startMu.Unlock()

	// 快速失败（权威判重仍在 reserve 内完成）。
	if existing := m.FindAnyByName(name); existing != nil {
		return nil, newUserError("INSTANCE_NAME_DUPLICATE", "服务名已被实例 #"+existing.ID+" 占用: "+name)
	}
	port, err := m.reservePort(p.Port)
	if err != nil {
		return nil, err
	}

	id := newID()
	inst := &Instance{
		ID:             id,
		Name:           name,
		ModelID:        p.ModelID,
		WeightsPath:    p.WeightsPath,
		Port:           port,
		Backend:        p.Backend,
		Device:         p.Device,
		ExecName:       p.ExecName,
		Threads:        p.Threads,
		SessionOptions: p.SessionOptions,
		Status:         "STARTING",
		CreatedAt:      time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		exited:         make(chan int, 1),
	}
	// 原子预占：单临界区内校验服务名唯一并登记占位实例。
	if err := m.reserve(inst); err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			m.mu.Lock()
			delete(m.items, id)
			m.mu.Unlock()
			cleanupRunDir(id)
		}
	}()

	dir := filepath.Join("run", id)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, err
	}
	serverJSON := filepath.Join(dir, "server.json")
	if err := writeServerJSON(serverJSON, port, p, name); err != nil {
		return nil, err
	}
	absServerJSON, _ := filepath.Abs(serverJSON)

	logFile, err := os.OpenFile(filepath.Join(dir, "server.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(p.ExecPath, "--config", absServerJSON)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	hideChildWindow(cmd)
	if len(p.Env) > 0 {
		cmd.Env = buildChildEnv(p.Env)
		log.Printf("[%s] 注入环境变量: %s", id, strings.Join(sortedEnvKeys(p.Env), ", "))
	}
	if err := cmd.Start(); err != nil {
		logFile.Close()
		m.addEvent("error", "实例启动失败（"+p.ExecName+"）: "+summarize(err.Error()))
		return nil, err
	}

	// cmd 在锁内写入，Stop 也在锁内读取，避免与占位实例的并发访问竞争。
	m.mu.Lock()
	if m.items[id] == inst {
		inst.cmd = cmd
	}
	stillReserved := m.items[id] == inst
	m.mu.Unlock()

	// 启动期间实例可能已被 Stop 移除：发现即终止子进程，避免留下孤儿。
	if !stillReserved {
		cmd.Process.Kill()
		code := waitExitCode(cmd)
		logFile.Close()
		inst.exited <- code
		return nil, newUserError("INSTANCE_STOPPED", "实例在启动完成前已被停止")
	}
	committed = true

	go func() {
		code := waitExitCode(cmd)
		logFile.Close()
		inst.exited <- code
	}()

	log.Printf("[%s] 实例已启动: executable=%s, name=%s, modelId=%s, backend=%s, port=%d, pid=%d",
		id, p.ExecName, name, p.ModelID, p.Backend, port, cmd.Process.Pid)
	m.addEvent("info", fmt.Sprintf("实例 #%s 启动中（%s，端口 %d）", id, p.ExecName, port))
	go m.awaitReady(inst)
	return inst, nil
}

// reserve 在单个临界区内校验服务名唯一并登记占位实例（原子预占 name+port）。
func (m *InstanceManager) reserve(inst *Instance) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, existing := range m.items {
		if existing.Name == inst.Name {
			return newUserError("INSTANCE_NAME_DUPLICATE", "服务名已被实例 #"+existing.ID+" 占用: "+inst.Name)
		}
	}
	m.items[inst.ID] = inst
	return nil
}

// waitExitCode 等待进程结束并返回 exit code（拿不到时退化为 1）。
func waitExitCode(cmd *exec.Cmd) int {
	err := cmd.Wait()
	if err == nil {
		return 0
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		return exitErr.ExitCode()
	}
	return 1
}

// Stop 停止实例：进程终止后从 map 移除并记事件。
func (m *InstanceManager) Stop(id string) bool {
	m.mu.Lock()
	inst, ok := m.items[id]
	var cmd *exec.Cmd
	if ok {
		delete(m.items, id)
		cmd = inst.cmd // 与 Start 在锁内写入 cmd 同步，避免数据竞争
	}
	m.mu.Unlock()
	if !ok {
		return false
	}
	if cmd != nil && cmd.Process != nil {
		cmd.Process.Kill()
		select {
		case <-inst.exited:
		case <-time.After(5 * time.Second):
		}
	}
	log.Printf("[%s] 实例已停止: port=%d", id, inst.Port)
	m.addEvent("info", "实例 #"+id+" 已停止")
	cleanupRunDir(id)
	return true
}

func (m *InstanceManager) stopAll() {
	for _, inst := range m.List() {
		m.Stop(inst.ID)
	}
}

// reservePort 选定并预占一个端口：显式端口做范围/保留/可用性校验；
// 自动端口从 portBase 起找第一个空闲端口。net.Listen 探测在锁外进行，不阻塞其它实例操作。
func (m *InstanceManager) reservePort(requested *int) (int, error) {
	if requested != nil {
		port := *requested
		if port < 1 || port > 65535 {
			return 0, newUserError("INSTANCE_PORT_INVALID", fmt.Sprintf("端口必须在 1..65535 之间: %d", port))
		}
		if port == m.hubPort {
			return 0, newUserError("INSTANCE_PORT_RESERVED", fmt.Sprintf("端口 %d 已被 hub 占用", port))
		}
		if m.portRegistered(port) {
			return 0, newUserError("INSTANCE_PORT_IN_USE", fmt.Sprintf("端口 %d 已被其它实例占用", port))
		}
		if err := probePort(port); err != nil {
			return 0, newUserError("INSTANCE_PORT_IN_USE", fmt.Sprintf("端口 %d 不可用: %v", port, err))
		}
		return port, nil
	}
	start := m.portBase
	if start < 1 {
		start = 1
	}
	for port := start; port <= 65535; port++ {
		if port == m.hubPort || m.portRegistered(port) {
			continue
		}
		if probePort(port) == nil {
			return port, nil
		}
	}
	return 0, newUserError("INSTANCE_PORT_EXHAUSTED", fmt.Sprintf("从 %d 起没有可用端口", start))
}

// portRegistered 端口是否已被登记实例（含 STARTING 占位）占用。
func (m *InstanceManager) portRegistered(port int) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, inst := range m.items {
		if inst.Port == port {
			return true
		}
	}
	return false
}

// probePort 尝试在 127.0.0.1 上监听端口以确认可用（与实例绑定地址一致）。
func probePort(port int) error {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return err
	}
	return ln.Close()
}

// awaitReady 每 1s 轮询 /health，最多 120s；失败路径移除实例并记事件。
func (m *InstanceManager) awaitReady(inst *Instance) {
	deadline := time.Now().Add(healthTimeoutSeconds * time.Second)
	healthURL := fmt.Sprintf("http://127.0.0.1:%d/health", inst.Port)
	for time.Now().Before(deadline) {
		select {
		case code := <-inst.exited:
			reason := fmt.Sprintf("实例 #%s 进程提前退出 (exit=%d)，日志尾部: %s", inst.ID, code, readLogTail(inst.ID))
			log.Printf("[%s] 实例进程提前退出: exit=%d", inst.ID, code)
			m.addEvent("error", reason)
			m.mu.Lock()
			delete(m.items, inst.ID)
			m.mu.Unlock()
			cleanupRunDir(inst.ID)
			return
		case <-time.After(1 * time.Second):
		}
		resp, err := m.healthClient.Get(healthURL)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				m.mu.Lock()
				inst.Status = "READY"
				m.mu.Unlock()
				log.Printf("[%s] 实例就绪: port=%d", inst.ID, inst.Port)
				m.addEvent("info", fmt.Sprintf("实例 #%s 已就绪（端口 %d）", inst.ID, inst.Port))
				return
			}
		}
	}
	log.Printf("[%s] 实例等待就绪超时", inst.ID)
	m.addEvent("error", fmt.Sprintf("实例 #%s 等待就绪超时 (%ds)，日志尾部: %s",
		inst.ID, healthTimeoutSeconds, readLogTail(inst.ID)))
	m.mu.Lock()
	delete(m.items, inst.ID)
	m.mu.Unlock()
	if inst.cmd != nil && inst.cmd.Process != nil {
		inst.cmd.Process.Kill()
	}
	cleanupRunDir(inst.ID)
}

// readLogTail 读实例日志末尾 10 行，用于错误诊断。
// 只从文件末尾读取至多 logTailBytes 字节，避免日志无界增长时把整个文件读进内存。
func readLogTail(id string) string {
	f, err := os.Open(filepath.Join("run", id, "server.log"))
	if err != nil {
		return "(无日志)"
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "(无日志)"
	}
	start := st.Size() - logTailBytes
	if start < 0 {
		start = 0
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return "(无日志)"
	}
	data, err := io.ReadAll(io.LimitReader(f, logTailBytes))
	if err != nil {
		return "(无日志)"
	}
	// 从文件中途截断时，首个换行前是不完整行，丢弃之。
	if start > 0 {
		if i := bytes.IndexByte(data, '\n'); i >= 0 {
			data = data[i+1:]
		} else {
			data = nil
		}
	}
	lines := strings.Split(strings.TrimRight(string(data), "\r\n"), "\n")
	if len(lines) > 10 {
		lines = lines[len(lines)-10:]
	}
	return summarize(strings.Join(lines, " | "))
}

// cleanupRunDir 删除 run/<id>（Windows 文件句柄释放有延迟，带有限重试）。
func cleanupRunDir(id string) {
	dir := filepath.Join("run", id)
	for attempt := 1; attempt <= 5; attempt++ {
		err1 := os.Remove(filepath.Join(dir, "server.json"))
		err2 := os.Remove(filepath.Join(dir, "server.log"))
		err3 := os.Remove(dir)
		if (err1 == nil || os.IsNotExist(err1)) && (err2 == nil || os.IsNotExist(err2)) &&
			(err3 == nil || os.IsNotExist(err3)) {
			return
		}
		if attempt == 5 {
			log.Printf("清理实例运行目录失败: %s", dir)
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// writeServerJSON 生成 audiocpp_server 的 server.json（对应 Java 版 ServerConfigWriter）。
func writeServerJSON(path string, port int, p StartParams, instanceName string) error {
	model := map[string]any{
		"id":     instanceName,
		"family": p.EngineFamily,
		"path":   p.WeightsPath,
		"task":   p.ServerTask,
		"mode":   "offline",
	}
	if len(p.SessionOptions) > 0 {
		model["session_options"] = p.SessionOptions
	}
	threads := 1
	if p.Threads != nil {
		threads = *p.Threads
	} else if p.Backend == "cpu" {
		threads = runtime.NumCPU()
	}
	root := map[string]any{
		"host":      "127.0.0.1",
		"port":      port,
		"backend":   p.Backend,
		"threads":   threads,
		"lazy_load": true,
		"models":    []map[string]any{model},
	}
	if p.Device != nil {
		root["device"] = *p.Device
	}
	data, err := json.Marshal(root)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

// ToJSON 实例的 API 输出形状（对应 Java 版 ApiHandler.toJson）。
func (m *InstanceManager) ToJSON(inst *Instance, taskCount int) map[string]any {
	m.mu.Lock()
	status := inst.Status
	m.mu.Unlock()
	out := map[string]any{
		"id":             inst.ID,
		"instanceName":   inst.Name,
		"modelId":        inst.ModelID,
		"weightsPath":    inst.WeightsPath,
		"port":           inst.Port,
		"backend":        inst.Backend,
		"executableName": inst.ExecName,
		"status":         status,
		"createdAt":      inst.CreatedAt,
		"taskCount":      taskCount,
		"sessionOptions": inst.SessionOptions,
	}
	if inst.Device != nil {
		out["device"] = *inst.Device
	}
	if inst.Threads != nil {
		out["threads"] = *inst.Threads
	}
	return out
}

var deviceLinePattern = regexp.MustCompile(`^([A-Za-z0-9_]+):(\d+)(?:\s+"([^"]*)")?\s+\[([^\]]+)\]\s*$`)

// ListDevices 运行 <可执行文件> --list-devices 并解析输出（对应 Java 版 DeviceLister）。
func ListDevices(execPath string, env map[string]string) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, execPath, "--list-devices")
	hideChildWindow(cmd)
	if len(env) > 0 {
		cmd.Env = buildChildEnv(env)
	}
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("--list-devices 执行失败: %w", err)
	}
	devices := []map[string]any{}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimRight(line, "\r")
		m := deviceLinePattern.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		var index int
		fmt.Sscanf(m[2], "%d", &index)
		devices = append(devices, map[string]any{
			"backend": m[1],
			"index":   index,
			"name":    m[3],
			"type":    m[4],
		})
	}
	return map[string]any{"devices": devices, "raw": string(out)}, nil
}

// sortedEnvKeys 返回排序后的 env key，保证日志/遍历顺序确定。
func sortedEnvKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// resolveInjectedEnv 迭代展开注入项中的 ${VAR}：每轮按 key 排序处理，允许项间互相引用，
// 直到结果稳定（最多 len+1 轮，兜底自引用）。查找优先取已解析的注入值，其次取父环境快照。
func resolveInjectedEnv(base, injected map[string]string) map[string]string {
	resolved := make(map[string]string, len(injected))
	keys := sortedEnvKeys(injected)
	for pass := 0; pass <= len(keys); pass++ {
		changed := false
		for _, k := range keys {
			val := expandEnv(injected[k], func(name string) string {
				if v, ok := resolved[name]; ok {
					return v
				}
				return base[name]
			})
			if cur, ok := resolved[k]; !ok || cur != val {
				resolved[k] = val
				changed = true
			}
		}
		if !changed {
			break
		}
	}
	return resolved
}

// buildChildEnv 基于父环境快照构造子进程环境：key 排序、去重，注入值覆盖父环境同名键，
// 结果与 map 迭代顺序无关（同一输入恒得同一输出）。
func buildChildEnv(injected map[string]string) []string {
	base := make(map[string]string)
	for _, kv := range os.Environ() {
		if k, v, ok := strings.Cut(kv, "="); ok {
			base[k] = v
		}
	}
	merged := make(map[string]string, len(base)+len(injected))
	for k, v := range base {
		merged[k] = v
	}
	for k, v := range resolveInjectedEnv(base, injected) {
		merged[k] = v
	}
	out := make([]string, 0, len(merged))
	for k, v := range merged {
		out = append(out, k+"="+v)
	}
	sort.Strings(out)
	return out
}
