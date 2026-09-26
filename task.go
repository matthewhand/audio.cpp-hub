package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/matthewhand/audio.cpp-hub/internal/wav"
)

// Task 一个异步推理任务（POST /api/tasks 创建）。
// 状态落盘 data/tasks/<id>.task.json，重启回放（进行中标记 CANCELLED）；
// 非 TTS 结果落盘 data/tasks/<id>.result.json；TTS 复用历史链路。
type Task struct {
	ID           string         `json:"id"`
	InstanceID   string         `json:"instanceId"`
	InstanceName string         `json:"instanceName"`
	ModelID      string         `json:"modelId"`
	Category     string         `json:"category"`
	Status       string         `json:"status"` // QUEUED/RUNNING/DONE/FAILED/CANCELLED
	CreatedAt    int64          `json:"createdAt"`
	StartedAt    *int64         `json:"startedAt,omitempty"`
	FinishedAt   *int64         `json:"finishedAt,omitempty"`
	Error        string         `json:"error,omitempty"`
	Text         *string        `json:"text,omitempty"`
	Result       map[string]any `json:"result,omitempty"`

	// 以下不参与持久化
	inst       *Instance
	request    map[string]any // body["request"]，历史记录与文本预览用
	requestRaw json.RawMessage
	resultPath string
}

func (t *Task) active() bool { return t.Status == "QUEUED" || t.Status == "RUNNING" }

const (
	taskStateDir     = "data/tasks"
	taskSuffix       = ".task.json"
	resultSuffix     = ".result.json"
	finishedKeep     = 100
	previewMaxSize   = 8 << 20
	taskQueueSize    = 100
	queueIdleTimeout = 30 * time.Second
)

// TaskManager 提交 → 同实例串行排队执行 → 前端轮询结果。与 ApiHandler 共享同一个 HistoryManager。
type TaskManager struct {
	mu        sync.Mutex
	tasks     map[string]*Task
	queues    map[string]*taskQueue
	cancels   map[string]context.CancelFunc // RUNNING 任务的中断函数
	history   *HistoryManager
	forwarder *http.Client
}

// taskQueue 每实例一个串行队列：任务由单个 worker goroutine 顺序执行。
// 队列空闲超过 queueIdleTimeout 后 worker 自行退出并移除，实例反复启停不会泄漏 goroutine。
type taskQueue struct {
	ch      chan *Task
	running bool
}

func NewTaskManager(history *HistoryManager) *TaskManager {
	m := &TaskManager{
		tasks:     map[string]*Task{},
		queues:    map[string]*taskQueue{},
		cancels:   map[string]context.CancelFunc{},
		history:   history,
		forwarder: &http.Client{}, // 无超时：生成任务时长不可预估
	}
	m.replay()
	return m
}

// replay 启动时回放 data/tasks/*.task.json；进行中任务标记 CANCELLED，孤儿文件清理。
func (m *TaskManager) replay() {
	os.MkdirAll(taskStateDir, 0755)
	entries, err := os.ReadDir(taskStateDir)
	if err != nil {
		return
	}
	loaded := map[string]bool{}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, taskSuffix) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(taskStateDir, name))
		if err != nil {
			continue
		}
		var t Task
		if err := json.Unmarshal(data, &t); err != nil || t.ID == "" || t.ModelID == "" {
			log.Printf("跳过损坏的任务状态文件: %s", name)
			continue
		}
		// 回放前重新校验（data/ 可能被本地篡改）：ID 必须与文件名一致且可作路径片段，
		// modelId 必须可作目录片段，防止篡改的 task.json 用 ID 做路径穿越。
		if name != t.ID+taskSuffix || !safeID(t.ID) || !safeKey(t.ModelID) {
			log.Printf("跳过非法任务状态文件: %s", name)
			continue
		}
		if t.Status == "" || t.active() {
			t.Status = "CANCELLED"
		}
		if t.FinishedAt == nil {
			now := time.Now().UnixMilli()
			t.FinishedAt = &now
		}
		result := filepath.Join(taskStateDir, t.ID+resultSuffix)
		if isRegularFile(result) {
			t.resultPath = result
		}
		m.tasks[t.ID] = &t
		loaded[t.ID] = true
	}
	for _, e := range entries {
		name := e.Name()
		if strings.HasSuffix(name, ".tmp") {
			os.Remove(filepath.Join(taskStateDir, name))
		} else if strings.HasSuffix(name, resultSuffix) {
			id := strings.TrimSuffix(name, resultSuffix)
			if !loaded[id] {
				os.Remove(filepath.Join(taskStateDir, name))
			}
		}
	}
}

// Submit 创建任务并入队。调用方负责实例存在/READY 校验。
// 入队为非阻塞：队列已满时任务直接标记 FAILED（错误码 TASK_QUEUE_FULL），不阻塞 HTTP handler。
func (m *TaskManager) Submit(inst *Instance, request map[string]any, requestRaw json.RawMessage) *Task {
	t := &Task{
		ID:           newID(),
		InstanceID:   inst.ID,
		InstanceName: inst.Name,
		ModelID:      inst.ModelID,
		Category:     modelCategory(inst.ModelID),
		Status:       "QUEUED",
		CreatedAt:    time.Now().UnixMilli(),
		inst:         inst,
		request:      request,
		requestRaw:   requestRaw,
	}
	if s, ok := request["text"].(string); ok {
		preview := truncateRunes(s, 100)
		t.Text = &preview
	}
	m.mu.Lock()
	m.tasks[t.ID] = t
	m.mu.Unlock()
	// 先落盘 QUEUED，避免 worker 抢先执行后又被旧状态覆盖。
	m.persist(t)
	m.mu.Lock()
	queued := m.enqueueLocked(inst.ID, t)
	m.mu.Unlock()
	if !queued {
		m.mu.Lock()
		if t.Status == "QUEUED" {
			t.Status = "FAILED"
			t.Error = "TASK_QUEUE_FULL: 实例任务队列已满（上限 100）"
			now := time.Now().UnixMilli()
			t.FinishedAt = &now
		}
		m.mu.Unlock()
		m.persist(t)
		m.evictFinished()
		log.Printf("任务入队失败（队列已满）: %s (实例 %s)", t.ID, inst.Name)
		return t
	}
	log.Printf("任务已入队: %s (实例 %s, category %s)", t.ID, inst.Name, t.Category)
	return t
}

// enqueueLocked 在锁内取得/新建每实例串行队列并入队；队列满返回 false（不阻塞）。
func (m *TaskManager) enqueueLocked(instanceID string, t *Task) bool {
	q, ok := m.queues[instanceID]
	if !ok {
		q = &taskQueue{ch: make(chan *Task, taskQueueSize)}
		m.queues[instanceID] = q
	}
	if !q.running {
		q.running = true
		go m.runQueue(instanceID, q)
	}
	select {
	case q.ch <- t:
		return true
	default:
		return false
	}
}

// runQueue 串行执行实例队列；空闲超时后自行退出并移除队列（自回收，无需外部显式停止）。
func (m *TaskManager) runQueue(instanceID string, q *taskQueue) {
	idle := time.NewTimer(queueIdleTimeout)
	defer idle.Stop()
	for {
		select {
		case t, ok := <-q.ch:
			if !ok { // StopQueue 关闭了队列
				m.forgetQueue(instanceID, q)
				return
			}
			if !idle.Stop() {
				select {
				case <-idle.C:
				default:
				}
			}
			m.execute(t)
			idle.Reset(queueIdleTimeout)
		case <-idle.C:
			m.mu.Lock()
			cur, ok := m.queues[instanceID]
			if ok && cur == q && len(q.ch) == 0 {
				q.running = false
				delete(m.queues, instanceID)
				m.mu.Unlock()
				return
			}
			m.mu.Unlock()
			idle.Reset(queueIdleTimeout)
		}
	}
}

// forgetQueue 锁内解绑 worker 退出的队列。
func (m *TaskManager) forgetQueue(instanceID string, q *taskQueue) {
	m.mu.Lock()
	if cur, ok := m.queues[instanceID]; ok && cur == q {
		q.running = false
		delete(m.queues, instanceID)
	}
	m.mu.Unlock()
}

// StopQueue 关闭并移除实例队列（供实例停止时调用；未被调用也会由空闲回收兜底）。
// 该实例尚未执行的 QUEUED 任务标记为 CANCELLED，保证不遗留悬挂记录。
func (m *TaskManager) StopQueue(instanceID string) {
	m.mu.Lock()
	if q, ok := m.queues[instanceID]; ok {
		delete(m.queues, instanceID)
		close(q.ch) // 触发 runQueue 退出（收到 !ok）
	}
	var pending []*Task
	for _, t := range m.tasks {
		if t.InstanceID == instanceID && t.Status == "QUEUED" {
			t.Status = "CANCELLED"
			now := time.Now().UnixMilli()
			t.FinishedAt = &now
			pending = append(pending, t)
		}
	}
	m.mu.Unlock()
	for _, t := range pending {
		m.persist(t)
	}
}

// Cancel QUEUED/RUNNING → CANCELLED（RUNNING 中断 hub 侧等待）；已结束 → 删除记录。
func (m *TaskManager) Cancel(id string) bool {
	m.mu.Lock()
	t, ok := m.tasks[id]
	if !ok {
		m.mu.Unlock()
		return false
	}
	if t.active() {
		t.Status = "CANCELLED"
		now := time.Now().UnixMilli()
		t.FinishedAt = &now
		if cancel, ok := m.cancels[id]; ok {
			cancel()
			delete(m.cancels, id)
		}
		m.mu.Unlock()
		m.persist(t)
		log.Printf("任务已取消: %s", id)
		return true
	}
	delete(m.tasks, id)
	m.mu.Unlock()
	os.Remove(t.resultPath)
	os.Remove(filepath.Join(taskStateDir, id+taskSuffix))
	return true
}

// List 活跃在前（组内创建时间倒序）；activeOnly 只留 QUEUED/RUNNING，modelID 非空时过滤。
// 过滤/位置/快照均在锁内完成，锁外只对快照排序与序列化。
func (m *TaskManager) List(activeOnly bool, modelID string) []map[string]any {
	type item struct {
		snap Task
		pos  int
	}
	var items []item
	m.mu.Lock()
	for _, t := range m.tasks {
		if activeOnly && !t.active() {
			continue
		}
		if modelID != "" && modelID != t.ModelID {
			continue
		}
		snap := snapshotTaskLocked(t)
		items = append(items, item{snap: snap, pos: m.positionLocked(&snap)})
	}
	m.mu.Unlock()
	sort.SliceStable(items, func(i, j int) bool { return items[i].snap.CreatedAt > items[j].snap.CreatedAt })
	sort.SliceStable(items, func(i, j int) bool {
		ai, aj := 1, 1
		if items[i].snap.active() {
			ai = 0
		}
		if items[j].snap.active() {
			aj = 0
		}
		return ai < aj
	})
	out := []map[string]any{}
	for _, it := range items {
		out = append(out, outputJSON(&it.snap, it.pos))
	}
	return out
}

// ActiveCountFor 指定实例当前活跃任务数（实例卡片“工作中”徽标）。
func (m *TaskManager) ActiveCountFor(instanceID string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, t := range m.tasks {
		if t.active() && t.InstanceID == instanceID {
			n++
		}
	}
	return n
}

// Get 单任务详情（含 position），不存在返回 nil。
func (m *TaskManager) Get(id string) map[string]any {
	m.mu.Lock()
	t := m.tasks[id]
	if t == nil {
		m.mu.Unlock()
		return nil
	}
	snap := snapshotTaskLocked(t)
	pos := m.positionLocked(&snap)
	m.mu.Unlock()
	return outputJSON(&snap, pos)
}

// ResultPath 非 TTS 已完成任务的结果文件路径，其余返回空串。
func (m *TaskManager) ResultPath(id string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	t := m.tasks[id]
	if t == nil || t.Status != "DONE" || t.Category == "tts" {
		return ""
	}
	return t.resultPath
}

// outputJSON 序列化任务快照并附加队列位置（position 不落盘）。
func outputJSON(t *Task, position int) map[string]any {
	data, _ := json.Marshal(t)
	var out map[string]any
	json.Unmarshal(data, &out)
	out["position"] = position
	return out
}

// snapshotTaskLocked 在持锁状态下复制任务快照（Result 深拷贝、指针字段复制值），
// 之后锁外序列化不再触碰执行中被修改的字段。
func snapshotTaskLocked(t *Task) Task {
	cp := *t
	if t.Result != nil {
		if r, ok := deepCopyJSON(t.Result).(map[string]any); ok {
			cp.Result = r
		}
	}
	if t.Text != nil {
		v := *t.Text
		cp.Text = &v
	}
	if t.StartedAt != nil {
		v := *t.StartedAt
		cp.StartedAt = &v
	}
	if t.FinishedAt != nil {
		v := *t.FinishedAt
		cp.FinishedAt = &v
	}
	return cp
}

// deepCopyJSON 深拷贝 JSON 容器（map/slice），标量原样返回。
func deepCopyJSON(v any) any {
	switch x := v.(type) {
	case map[string]any:
		cp := make(map[string]any, len(x))
		for k, val := range x {
			cp[k] = deepCopyJSON(val)
		}
		return cp
	case []any:
		cp := make([]any, len(x))
		for i, val := range x {
			cp[i] = deepCopyJSON(val)
		}
		return cp
	default:
		return v
	}
}

// positionLocked 同实例排在该任务前面的 QUEUED 任务数；非 QUEUED 恒为 0。调用方须持锁。
func (m *TaskManager) positionLocked(task *Task) int {
	if task.Status != "QUEUED" {
		return 0
	}
	n := 0
	for _, o := range m.tasks {
		if o.Status == "QUEUED" && o.InstanceID == task.InstanceID && o.CreatedAt < task.CreatedAt {
			n++
		}
	}
	return n
}

func (m *TaskManager) execute(t *Task) {
	m.mu.Lock()
	if t.Status != "QUEUED" {
		m.mu.Unlock()
		return
	}
	t.Status = "RUNNING"
	now := time.Now().UnixMilli()
	t.StartedAt = &now
	ctx, cancel := context.WithCancel(context.Background())
	m.cancels[t.ID] = cancel
	m.mu.Unlock()
	m.persist(t)

	var err error
	if t.Category == "tts" {
		err = m.runTTS(ctx, t)
	} else {
		out := filepath.Join(taskStateDir, t.ID+resultSuffix)
		err = m.forwardToFile(ctx, t.inst, t.requestRaw, out)
		if err == nil {
			preview := resultTextPreview(out)
			// 字段写入须持锁：快照/序列化可能并发读取。
			m.mu.Lock()
			t.resultPath = out
			if t.Text == nil {
				t.Text = preview
			}
			m.mu.Unlock()
		}
	}

	m.mu.Lock()
	delete(m.cancels, t.ID)
	cancel()
	if err != nil {
		if t.Status == "RUNNING" { // 已被 Cancel 标记的保持 CANCELLED
			t.Status = "FAILED"
			t.Error = summarize(err.Error())
			// TTS 历史由 runTTS 统一记录（含音频提取失败详情），此处不再重复记录。
		}
	} else if t.Status == "RUNNING" {
		t.Status = "DONE"
	}
	if t.FinishedAt == nil {
		now := time.Now().UnixMilli()
		t.FinishedAt = &now
	}
	m.mu.Unlock()
	if err != nil {
		log.Printf("任务执行失败: %s: %v", t.ID, err)
	}
	m.persist(t)
	m.evictFinished()
}

// runTTS 响应落盘临时文件 → 提取 audio 写成 wav → 解析 WAV 头取元数据 → 记历史。
func (m *TaskManager) runTTS(ctx context.Context, t *Task) error {
	dir := filepath.Join("data", "history", t.ModelID)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("历史目录不可用: %w", err)
	}
	tmp := filepath.Join(dir, t.ID+".resp.tmp")
	defer os.Remove(tmp)
	if err := m.forwardToFile(ctx, t.inst, t.requestRaw, tmp); err != nil {
		m.history.RecordTTS(t.inst, t.request, t.ID, nil, summarize(err.Error()))
		return err
	}
	result, errMsg := finalizeTTS(m.history, t.inst, t.request, t.ID, tmp)
	if errMsg != "" {
		return fmt.Errorf("%s", errMsg)
	}
	m.mu.Lock()
	t.Result = result
	m.mu.Unlock()
	return nil
}

// finalizeTTS 提取临时响应中的音频、解析 WAV 头、构造结果并写入 TTS 历史。
// 同步（handleRun）与异步（runTTS）两条链路共用同一实现；errMsg 非空表示最终态为失败。
// wavPath 与 tmp 同目录，result["file"] 用 taskID 命名，保证历史音频 URL 可寻址。
func finalizeTTS(history *HistoryManager, inst *Instance, request map[string]any, taskID, tmp string) (result map[string]any, errMsg string) {
	wavPath := filepath.Join(filepath.Dir(tmp), taskID+".wav")
	found, err := extractAudio(tmp, wavPath)
	if err != nil {
		errMsg = "结果音频提取失败: " + summarize(err.Error())
		os.Remove(wavPath)
	} else if !found {
		errMsg = "响应中未找到音频数据"
	} else if info, perr := wav.ParseFile(wavPath); perr != nil {
		errMsg = "结果音频提取失败: " + summarize(perr.Error())
		os.Remove(wavPath)
	} else {
		var size int64
		if st, serr := os.Stat(wavPath); serr == nil {
			size = st.Size()
		}
		result = map[string]any{
			"file":        taskID + ".wav",
			"size":        size,
			"durationSec": round3(info.DurationSec),
			"sampleRate":  info.SampleRate,
			"channels":    info.Channels,
		}
	}
	history.RecordTTS(inst, request, taskID, result, errMsg)
	return result, errMsg
}

// forwardToFile 把 {"model":<服务名>,"request":{...}} POST 到实例 /v1/tasks/run，
// 200 响应体流式落盘；非 200 读错误体抛异常（对应 Java 版 SpeechForwarder）。
func (m *TaskManager) forwardToFile(ctx context.Context, inst *Instance, requestRaw json.RawMessage, target string) error {
	var body bytes.Buffer
	modelName, _ := json.Marshal(inst.Name)
	body.WriteString(`{"model":`)
	body.Write(modelName)
	body.WriteString(`,"request":`)
	if len(requestRaw) > 0 {
		body.Write(requestRaw)
	} else {
		body.WriteString(`{}`)
	}
	body.WriteByte('}')

	url := fmt.Sprintf("http://127.0.0.1:%d/v1/tasks/run", inst.Port)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, &body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := m.forwarder.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		errBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return fmt.Errorf("audiocpp_server 返回 %d: %s", resp.StatusCode, summarize(string(errBody)))
	}
	out, err := os.Create(target)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, resp.Body)
	return err
}

// extractAudio 从响应 JSON 中流式提取顶层 "audio"（base64）解码写 wav。
func extractAudio(src, dst string) (bool, error) {
	f, err := os.Open(src)
	if err != nil {
		return false, err
	}
	defer f.Close()
	dec := json.NewDecoder(f)
	if _, err := dec.Token(); err != nil { // 顶层 '{'
		return false, err
	}
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return false, err
		}
		key, _ := kt.(string)
		if key == "audio" {
			vt, err := dec.Token()
			if err != nil {
				return false, err
			}
			s, ok := vt.(string)
			if !ok {
				return false, nil
			}
			data, err := base64.StdEncoding.DecodeString(s)
			if err != nil {
				return false, err
			}
			return true, os.WriteFile(dst, data, 0644)
		}
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return false, err
		}
	}
	return false, nil
}

// resultTextPreview 非 TTS 结果 JSON 顶层 "text" 截断 100 字（如 ASR 转写文本）。
func resultTextPreview(resultPath string) *string {
	st, err := os.Stat(resultPath)
	if err != nil || st.Size() > previewMaxSize {
		return nil
	}
	data, err := os.ReadFile(resultPath)
	if err != nil {
		return nil
	}
	var obj map[string]any
	if err := json.Unmarshal(data, &obj); err != nil {
		return nil
	}
	if s, ok := obj["text"].(string); ok {
		preview := truncateRunes(s, 100)
		return &preview
	}
	return nil
}

// evictFinished 已完成任务超出保留上限时淘汰最旧（连带删除状态与结果文件）。
func (m *TaskManager) evictFinished() {
	m.mu.Lock()
	defer m.mu.Unlock()
	var finished []*Task
	for _, t := range m.tasks {
		if !t.active() {
			finished = append(finished, t)
		}
	}
	if len(finished) <= finishedKeep {
		return
	}
	sort.Slice(finished, func(i, j int) bool { return finished[i].CreatedAt < finished[j].CreatedAt })
	for _, t := range finished[:len(finished)-finishedKeep] {
		delete(m.tasks, t.ID)
		os.Remove(t.resultPath)
		os.Remove(filepath.Join(taskStateDir, t.ID+taskSuffix))
	}
}

// persist 任务状态原子落盘：持 manager 锁覆盖 marshal+write+rename，
// 保证同一任务（甚至所有任务）的落盘串行化，并发 Cancel/完成不会写出交错/截断状态。
func (m *TaskManager) persist(t *Task) {
	m.mu.Lock()
	defer m.mu.Unlock()
	data, err := json.Marshal(t)
	if err != nil {
		return
	}
	if err := os.MkdirAll(taskStateDir, 0755); err != nil {
		return
	}
	if err := writeFileAtomic(filepath.Join(taskStateDir, t.ID+taskSuffix), data); err != nil {
		log.Printf("任务状态落盘失败: %s: %v", t.ID, err)
	}
}
