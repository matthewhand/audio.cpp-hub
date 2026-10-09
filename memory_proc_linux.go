//go:build linux

package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Linux /proc readers for the memory sampler. The parsing itself is
// platform-neutral (memory.go) so the tests run everywhere; only the file
// access lives behind this build tag (same split as proc_windows.go /
// proc_other.go).

const memRSSSupported = true

// drmCardDir is where amdgpu publishes per-card VRAM size
// (card*/device/mem_info_vram_total).
const drmCardDir = "/sys/class/drm"

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

// drmCardIndex parses a /sys/class/drm entry name ("card0", "renderD128") into
// its card index; ok=false for the entries that are not cards (render nodes,
// version files).
func drmCardIndex(name string) (int, bool) {
	if !strings.HasPrefix(name, "card") {
		return 0, false
	}
	n, err := strconv.Atoi(name[len("card"):])
	if err != nil || n < 0 {
		return 0, false
	}
	return n, true
}

// procDrmVramTotals reads mem_info_vram_total from every DRM card and returns
// card index → VRAM bytes. Best-effort: cards without the file (or without
// VRAM accounting) are simply absent, so the map is empty on boxes where the
// file does not exist. The sampler calls it at most once — the total is the
// scale of the WebUI's VRAM bar, not a per-sample reading.
func procDrmVramTotals() map[int]int64 {
	entries, err := os.ReadDir(drmCardDir)
	if err != nil {
		return nil
	}
	out := map[int]int64{}
	for _, e := range entries {
		idx, ok := drmCardIndex(e.Name())
		if !ok {
			continue
		}
		data, err := os.ReadFile(filepath.Join(drmCardDir, e.Name(), "device", "mem_info_vram_total"))
		if err != nil {
			continue
		}
		if n, ok := parseDrmVramTotal(string(data)); ok {
			out[idx] = n
		}
	}
	return out
}
