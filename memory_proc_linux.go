//go:build linux

package main

import (
	"os"
	"path/filepath"
	"strconv"
)

// Linux /proc readers for the memory sampler. The parsing itself is
// platform-neutral (memory.go) so the tests run everywhere; only the file
// access lives behind this build tag (same split as proc_windows.go /
// proc_other.go).

const memRSSSupported = true

// procStatusRSSBytes reads VmRSS from /proc/<pid>/status.
func procStatusRSSBytes(pid int) (int64, bool) {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/status")
	if err != nil {
		return 0, false
	}
	return parseVmRSSBytes(string(data))
}

// procDrmVRAMBytes sums drm-memory-vram across /proc/<pid>/fdinfo/* entries
// (de-duplicated by drm-client-id; see sumDrmVRAMBytes).
func procDrmVRAMBytes(pid int) (int64, bool) {
	dir := filepath.Join("/proc", strconv.Itoa(pid), "fdinfo")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, false
	}
	contents := make(map[string]string, len(entries))
	for _, e := range entries {
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue // fd closed between readdir and read
		}
		contents[e.Name()] = string(data)
	}
	return sumDrmVRAMBytes(contents)
}
