package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

// 读取 >64MiB 日志的尾部时，分配量应被限制在 logTailBytes 量级，而不是整个文件。
func TestReadLogTailBoundedMemory(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)

	id := "tailtest"
	if err := os.MkdirAll(filepath.Join("run", id), 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	path := filepath.Join("run", id, "server.log")
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create log: %v", err)
	}
	if _, err := f.WriteString("EARLY-MARKER\n"); err != nil {
		t.Fatalf("write marker: %v", err)
	}
	block := bytes.Repeat([]byte("padding-line\n"), 1024) // ~13 KiB/块
	const target = 66 << 20
	written := 0
	for written < target {
		if _, err := f.Write(block); err != nil {
			t.Fatalf("write filler: %v", err)
		}
		written += len(block)
	}
	for i := 1; i <= 10; i++ {
		fmt.Fprintf(f, "TAIL-LINE-%02d\n", i)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if st.Size() <= int64(logTailBytes) {
		t.Fatalf("测试日志应超过 %d 字节，实际 %d", logTailBytes, st.Size())
	}

	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	out := readLogTail(id)
	runtime.ReadMemStats(&after)

	if !strings.Contains(out, "TAIL-LINE-10") {
		t.Fatalf("日志尾部应包含最后一行，实际: %q", out)
	}
	if strings.Contains(out, "EARLY-MARKER") {
		t.Fatalf("不应读取到文件开头的内容: %q", out)
	}
	// 若整文件读入内存会新增 >= 文件大小的分配；限流读取的分配应远小于文件大小。
	if alloc := after.TotalAlloc - before.TotalAlloc; alloc > 4<<20 {
		t.Fatalf("readLogTail 分配了 %d 字节，未按尾部限制读取", alloc)
	}
}

// 注入项可互相引用且结果确定；子进程环境无重复 key，注入值覆盖父环境。
func TestBuildChildEnvDeterministicAndDedup(t *testing.T) {
	t.Setenv("HUBTEST_OVERRIDE", "inherited")
	injected := map[string]string{
		"HUBTEST_A":        "${HUBTEST_B}",
		"HUBTEST_B":        "x",
		"HUBTEST_OVERRIDE": "injected",
	}

	var first []string
	for run := 0; run < 8; run++ {
		env := buildChildEnv(injected)
		if first == nil {
			first = env
		} else if !equalStrings(first, env) {
			t.Fatalf("第 %d 次结果与首次不一致:\nfirst=%v\nnow  =%v", run, first, env)
		}
	}

	got := map[string]string{}
	for _, kv := range first {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			t.Fatalf("环境项缺少 =: %q", kv)
		}
		if _, dup := got[k]; dup {
			t.Fatalf("子进程环境存在重复 key: %q", k)
		}
		got[k] = v
	}
	if got["HUBTEST_A"] != "x" {
		t.Fatalf("HUBTEST_A 应解析为 x，实际 %q", got["HUBTEST_A"])
	}
	if got["HUBTEST_B"] != "x" {
		t.Fatalf("HUBTEST_B = %q", got["HUBTEST_B"])
	}
	if got["HUBTEST_OVERRIDE"] != "injected" {
		t.Fatalf("注入值应覆盖父环境，实际 %q", got["HUBTEST_OVERRIDE"])
	}
}

// 显式端口做范围/保留/占用校验；自动端口跳过已登记端口。
func TestReservePortValidation(t *testing.T) {
	m := NewInstanceManager(45000, 8080)

	cases := []struct {
		port int
		code string
	}{
		{0, "INSTANCE_PORT_INVALID"},
		{-1, "INSTANCE_PORT_INVALID"},
		{70000, "INSTANCE_PORT_INVALID"},
		{8080, "INSTANCE_PORT_RESERVED"},
	}
	for _, tc := range cases {
		port := tc.port
		_, err := m.reservePort(&port)
		if code := instErrCode(err); code != tc.code {
			t.Fatalf("端口 %d: 期望 %s，实际 %q (%v)", tc.port, tc.code, code, err)
		}
	}

	registered := &Instance{ID: "aaa", Name: "aaa", Port: 45055, exited: make(chan int, 1)}
	if err := m.reserve(registered); err != nil {
		t.Fatalf("reserve: %v", err)
	}
	port := 45055
	if _, err := m.reservePort(&port); instErrCode(err) != "INSTANCE_PORT_IN_USE" {
		t.Fatalf("已登记端口应判定占用，实际: %v", err)
	}
	auto, err := m.reservePort(nil)
	if err != nil {
		t.Fatalf("自动分配端口失败: %v", err)
	}
	if auto == 45055 || auto == 8080 || auto < 45000 {
		t.Fatalf("自动端口不合法: %d", auto)
	}
}

// 同一服务名并发预占时只能有一个成功（原子判重）。
func TestReserveNameAtomic(t *testing.T) {
	m := NewInstanceManager(45000, 8080)
	const n = 32
	var wg sync.WaitGroup
	codes := make([]string, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			inst := &Instance{
				ID:     fmt.Sprintf("id%02d", i),
				Name:   "same-name",
				Port:   46000 + i,
				exited: make(chan int, 1),
			}
			codes[i] = instErrCode(m.reserve(inst))
		}(i)
	}
	wg.Wait()

	success, dup := 0, 0
	for _, c := range codes {
		switch c {
		case "":
			success++
		case "INSTANCE_NAME_DUPLICATE":
			dup++
		default:
			t.Fatalf("意外错误码: %q", c)
		}
	}
	if success != 1 || dup != n-1 {
		t.Fatalf("期望 1 成功 / %d 重复，实际 %d / %d", n-1, success, dup)
	}
}

func instErrCode(err error) string {
	if err == nil {
		return ""
	}
	var ue *UserError
	if errors.As(err, &ue) {
		return ue.Code
	}
	return "non-user-error"
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
