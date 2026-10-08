//go:build !linux

package main

// Non-Linux platforms (windows / darwin): RSS has no /proc source here, so
// the per-instance memory object stays omitted — the sampler loop never even
// starts (memRSSSupported gate in memory.go). Kept compiling via the same
// build-tag split as proc_windows.go / proc_other.go; go vet stays clean for
// GOOS=windows/darwin.

const memRSSSupported = false

func procStatusRSSBytes(pid int) (int64, bool) { return 0, false }

func procDrmVRAMBytes(pid int) (int64, bool) { return 0, false }
