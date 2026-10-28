package main

import (
	"net"
	"testing"
)

func TestDownloadValidationAndSSRF(t *testing.T) {
	// validateDlURL
	if _, err := validateDlURL("ftp://example.com/file"); err == nil {
		t.Fatal("expected error for ftp url")
	}
	if _, err := validateDlURL("javascript:alert(1)"); err == nil {
		t.Fatal("expected error for javascript url")
	}
	if u, err := validateDlURL("https://huggingface.co/model.bin"); err != nil || u != "https://huggingface.co/model.bin" {
		t.Fatalf("expected valid url, got %q, %v", u, err)
	}
	if u, err := validateDlURL("http://localhost:8080/model.bin"); err != nil || u != "http://localhost:8080/model.bin" {
		t.Fatalf("expected valid url, got %q, %v", u, err)
	}

	// dlURLHost
	if dlURLHost("https://HuggingFace.co:443/path") != "huggingface.co" {
		t.Fatalf("expected huggingface.co, got %q", dlURLHost("https://HuggingFace.co:443/path"))
	}
	if dlURLHost("not-a-valid-url:::") != "" {
		t.Fatalf("expected empty for invalid url")
	}

	// dlDisallowedIP
	disallowed := []string{
		"127.0.0.1", "::1", // loopback
		"10.0.0.1", "172.16.0.1", "192.168.1.1", // RFC 1918
		"169.254.1.1", "169.254.169.254", // link-local & cloud metadata
		"100.64.0.1", // CGNAT
		"198.18.0.1", // benchmark
		"192.0.0.1",  // IETF protocol
		"224.0.0.1",  // multicast
		"0.0.0.0",    // unspecified
	}
	for _, ipStr := range disallowed {
		ip := net.ParseIP(ipStr)
		if !dlDisallowedIP(ip) {
			t.Fatalf("expected IP %s to be disallowed", ipStr)
		}
	}
	if !dlDisallowedIP(nil) {
		t.Fatal("nil IP should be disallowed")
	}

	allowed := []string{
		"8.8.8.8", "1.1.1.1", "140.82.121.3", // public IPs
	}
	for _, ipStr := range allowed {
		ip := net.ParseIP(ipStr)
		if dlDisallowedIP(ip) {
			t.Fatalf("expected public IP %s to be allowed", ipStr)
		}
	}

	// dlSSRFError
	ssrfErr := dlSSRFError("http://127.0.0.1/test")
	if ssrfErr.Code != "DOWNLOAD_SSRF_BLOCKED" {
		t.Fatalf("expected DOWNLOAD_SSRF_BLOCKED, got %s", ssrfErr.Code)
	}

	// dlHTTPError
	if e := dlHTTPError(401, "/file"); e.Code != "DOWNLOAD_AUTH" {
		t.Fatalf("expected DOWNLOAD_AUTH for 401, got %s", e.Code)
	}
	if e := dlHTTPError(403, "/file"); e.Code != "DOWNLOAD_AUTH" {
		t.Fatalf("expected DOWNLOAD_AUTH for 403, got %s", e.Code)
	}
	if e := dlHTTPError(404, "/file"); e.Code != "REMOTE_NOT_FOUND" {
		t.Fatalf("expected REMOTE_NOT_FOUND for 404, got %s", e.Code)
	}
	if e := dlHTTPError(500, "/file"); e.Code != "HEAD_FAILED" {
		t.Fatalf("expected HEAD_FAILED for 500, got %s", e.Code)
	}

	// dlPercent and dlActive
	if !dlActive(dlStatusPending) || !dlActive(dlStatusRunning) || !dlActive(dlStatusPaused) {
		t.Fatal("PENDING, RUNNING and PAUSED should be active")
	}
	if dlActive(dlStatusDone) || dlActive(dlStatusFailed) || dlActive("OTHER") {
		t.Fatal("DONE and FAILED should not be active")
	}

	taskZero := &DownloadTask{}
	if dlPercent(taskZero) != -1 {
		t.Fatalf("expected -1 for 0 total, got %d", dlPercent(taskZero))
	}
	task50 := &DownloadTask{
		Files: []*dlFileEntry{
			{
				Size:     100,
				Segments: []dlSegment{{Done: 50}},
			},
		},
	}
	if dlPercent(task50) != 50 {
		t.Fatalf("expected 50 for 50/100, got %d", dlPercent(task50))
	}
	if task50.totalBytes() != 100 || task50.downloadedBytes() != 50 {
		t.Fatalf("unexpected total/done bytes")
	}
}

func TestDownloadManagerHostGuards(t *testing.T) {
	cfg := HubConfig{
		HfEndpoint: "https://my-local-mirror.internal:8080",
	}
	dm := NewDownloadManager(cfg)

	// isTrustedHost
	if !dm.isTrustedHost("my-local-mirror.internal") {
		t.Fatal("configured HfEndpoint host should be trusted")
	}
	if dm.isTrustedHost("other-host.com") {
		t.Fatal("other host should not be trusted")
	}
	if dm.isTrustedHost("") {
		t.Fatal("empty host should not be trusted")
	}

	// isAllowedHost
	if !dm.isAllowedHost("huggingface.co") || !dm.isAllowedHost("hf-mirror.com") || !dm.isAllowedHost("modelscope.cn") {
		t.Fatal("built-in hosts should be allowed")
	}
	if !dm.isAllowedHost("my-local-mirror.internal") {
		t.Fatal("trusted host should also be in allowed hosts")
	}
	if dm.isAllowedHost("evil.com") {
		t.Fatal("evil.com should not be in allowed hosts")
	}

	// guardDlURL on trusted host (bypasses SSRF IP check)
	u, err := dm.guardDlURL("http://my-local-mirror.internal/model.bin")
	if err != nil || u != "http://my-local-mirror.internal/model.bin" {
		t.Fatalf("trusted host should pass guardDlURL: %v", err)
	}

	// guardDlURL on loopback IP (not trusted) -> rejected
	_, err = dm.guardDlURL("http://127.0.0.1/model.bin")
	if err == nil {
		t.Fatal("expected SSRF error for 127.0.0.1")
	}
	if ue, ok := err.(*UserError); !ok || ue.Code != "DOWNLOAD_SSRF_BLOCKED" {
		t.Fatalf("expected DOWNLOAD_SSRF_BLOCKED, got %v", err)
	}

	// guardDlURL on invalid scheme
	if _, err := dm.guardDlURL("ftp://example.com/model.bin"); err == nil {
		t.Fatal("expected error for ftp scheme")
	}
}
