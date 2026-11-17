//go:build linux

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadAmdGTTTwoCardsAndInvalid(t *testing.T) {
	root := t.TempDir()

	// Two AMD cards. device/ is a symlink to the PCI device directory, matching
	// /sys/class/drm/cardN/device. card1 is created first so order is not fs order.
	writePCIDevice(t, root, "0000:0a:00.0", "0x1002\n", "0\n", "8589934592\n")
	linkCardDevice(t, root, "card1", "0000:0a:00.0")

	writePCIDevice(t, root, "0000:03:00.0", "0x1002\n", "1048576\n", "4294967296\n")
	linkCardDevice(t, root, "card0", "0000:03:00.0")

	// Render node and connector must be ignored.
	writePCIDevice(t, root, "0000:03:00.1", "0x1002\n", "1\n", "2\n")
	linkCardDevice(t, root, "renderD128", "0000:03:00.1")
	linkCardDevice(t, root, "card0-HDMI-A-1", "0000:03:00.1")

	// Non-AMD vendor.
	writePCIDevice(t, root, "0000:04:00.0", "0x8086\n", "10\n", "20\n")
	linkCardDevice(t, root, "card2", "0000:04:00.0")

	// Malformed vendor, negative used, zero total, missing total, bad PCI name.
	writePCIDevice(t, root, "0000:05:00.0", "not-a-vendor\n", "10\n", "20\n")
	linkCardDevice(t, root, "card3", "0000:05:00.0")

	writePCIDevice(t, root, "0000:06:00.0", "0x1002\n", "-1\n", "20\n")
	linkCardDevice(t, root, "card4", "0000:06:00.0")

	writePCIDevice(t, root, "0000:07:00.0", "0x1002\n", "10\n", "0\n")
	linkCardDevice(t, root, "card5", "0000:07:00.0")

	writePCIDevice(t, root, "0000:08:00.0", "0x1002\n", "10\n", "")
	linkCardDevice(t, root, "card6", "0000:08:00.0")

	writePCIDevice(t, root, "not-pci", "0x1002\n", "10\n", "20\n")
	linkCardDevice(t, root, "card7", "not-pci")

	// Card directory with no device link.
	if err := os.Mkdir(filepath.Join(root, "card8"), 0o755); err != nil {
		t.Fatal(err)
	}

	got := readAmdGTT(root)
	if len(got) != 2 {
		t.Fatalf("len=%d, want 2: %#v", len(got), got)
	}
	if got[0].Card != "card0" || got[0].PCI != "0000:03:00.0" || got[0].UsedBytes != 1048576 || got[0].TotalBytes != 4294967296 {
		t.Fatalf("card0: %#v", got[0])
	}
	if got[1].Card != "card1" || got[1].PCI != "0000:0a:00.0" || got[1].UsedBytes != 0 || got[1].TotalBytes != 8589934592 {
		t.Fatalf("card1 (zero used must be kept): %#v", got[1])
	}
}

func TestReadAmdGTTMissingRoot(t *testing.T) {
	if got := readAmdGTT(filepath.Join(t.TempDir(), "missing")); got != nil {
		t.Fatalf("got %#v, want nil", got)
	}
}

func writePCIDevice(t *testing.T, root, pci, vendor, used, total string) {
	t.Helper()
	dir := filepath.Join(root, pci)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(dir, "vendor"), vendor)
	writeFile(t, filepath.Join(dir, "mem_info_gtt_used"), used)
	if total != "" {
		writeFile(t, filepath.Join(dir, "mem_info_gtt_total"), total)
	}
}

func linkCardDevice(t *testing.T, root, card, pci string) {
	t.Helper()
	cardDir := filepath.Join(root, card)
	if err := os.MkdirAll(cardDir, 0o755); err != nil {
		t.Fatal(err)
	}
	rel, err := filepath.Rel(cardDir, filepath.Join(root, pci))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(rel, filepath.Join(cardDir, "device")); err != nil {
		t.Fatal(err)
	}
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
