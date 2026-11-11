package main

import "strings"

// amdGTTDevice reports device-wide memory counters from amdgpu sysfs.
type amdGTTDevice struct {
	Card       string `json:"card"`
	PCI        string `json:"pci"`
	UsedBytes  int64  `json:"usedBytes"`
	TotalBytes int64  `json:"totalBytes"`
	VRAMUsed   *int64 `json:"vramUsedBytes,omitempty"`
	VRAMTotal  *int64 `json:"vramTotalBytes,omitempty"`
}

// uniqueDrmPCI returns a device only when every DRM fd with a driver entry
// has a PCI identity and all reported identities agree.
func uniqueDrmPCI(contents map[string]string) string {
	var found string
	for _, data := range contents {
		var pci string
		hasDriver := false
		for line := range strings.SplitSeq(data, "\n") {
			key, value, _ := strings.Cut(line, ":")
			switch key {
			case "drm-driver":
				hasDriver = true
			case "drm-pdev":
				pci = strings.ToLower(strings.TrimSpace(value))
			}
		}
		if pci == "" {
			if hasDriver {
				return ""
			}
			continue
		}
		if found != "" && pci != found {
			return ""
		}
		found = pci
	}
	return found
}
