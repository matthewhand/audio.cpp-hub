//go:build linux

package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const amdVendorID = "0x1002"

// pciAddrRe matches a canonical PCI address (domain:bus:device.function).
var pciAddrRe = regexp.MustCompile(`^(?:[0-9a-fA-F]{4}|[0-9a-fA-F]{8}):[0-9a-fA-F]{2}:[0-9a-fA-F]{2}\.[0-7]$`)

// readAmdGTT scans a DRM class directory (typically /sys/class/drm) for AMD
// cards and returns GTT used/total bytes. Render nodes, connectors, non-AMD
// devices, and malformed or missing entries are ignored. Used may be zero.
// os.ReadDir returns the entries in card-name order.
func readAmdGTT(root string) []amdGTTDevice {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}

	var out []amdGTTDevice
	for _, ent := range entries {
		name := ent.Name()
		if !isDRMCardName(name) {
			continue
		}
		dev, ok := readOneAmdGTT(root, name)
		if !ok {
			continue
		}
		out = append(out, dev)
	}

	return out
}

func isDRMCardName(name string) bool {
	rest, ok := strings.CutPrefix(name, "card")
	if !ok || rest == "" {
		return false
	}
	for _, c := range rest {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func readOneAmdGTT(root, card string) (amdGTTDevice, bool) {
	devDir := filepath.Join(root, card, "device")

	vendorRaw, err := os.ReadFile(filepath.Join(devDir, "vendor"))
	if err != nil || strings.ToLower(strings.TrimSpace(string(vendorRaw))) != amdVendorID {
		return amdGTTDevice{}, false
	}

	used, ok := parseGTTBytes(filepath.Join(devDir, "mem_info_gtt_used"), false)
	if !ok {
		return amdGTTDevice{}, false
	}
	total, ok := parseGTTBytes(filepath.Join(devDir, "mem_info_gtt_total"), true)
	if !ok {
		return amdGTTDevice{}, false
	}

	canon, err := filepath.EvalSymlinks(devDir)
	if err != nil {
		return amdGTTDevice{}, false
	}
	pci := strings.ToLower(filepath.Base(canon))
	if !pciAddrRe.MatchString(pci) {
		return amdGTTDevice{}, false
	}

	return amdGTTDevice{
		VRAMUsed:   readOptionalMemoryBytes(devDir, "mem_info_vram_used", false),
		VRAMTotal:  readOptionalMemoryBytes(devDir, "mem_info_vram_total", true),
		Card:       card,
		PCI:        pci,
		UsedBytes:  used,
		TotalBytes: total,
	}, true
}

func readOptionalMemoryBytes(dir, file string, positive bool) *int64 {
	n, ok := parseGTTBytes(filepath.Join(dir, file), positive)
	if !ok {
		return nil
	}
	return &n
}

// parseGTTBytes reads a sysfs integer. When positive is false, zero is kept.
func parseGTTBytes(path string, positive bool) (int64, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	n, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
	if err != nil || n < 0 {
		return 0, false
	}
	if positive && n == 0 {
		return 0, false
	}
	return n, true
}
