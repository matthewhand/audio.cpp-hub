package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPackages(t *testing.T) {
	// findPackageFamily
	if fam := findPackageFamily(""); fam != nil {
		t.Fatal("expected nil for empty family id")
	}
	if fam := findPackageFamily("non_existent_family"); fam != nil {
		t.Fatal("expected nil for non-existent family id")
	}
	fam := findPackageFamily("kokoro_tts")
	if fam == nil {
		t.Fatal("expected kokoro_tts family to exist")
	}

	// resolvePackage with default
	pkgDefault := resolvePackage(fam, "")
	if pkgDefault == nil {
		t.Fatal("expected default package for kokoro_tts")
	}
	if !pkgDefault.Default && pkgDefault.ID == "" {
		t.Fatalf("unexpected default package: %+v", pkgDefault)
	}

	// resolvePackage with explicit valid ID
	pkgExplicit := resolvePackage(fam, pkgDefault.ID)
	if pkgExplicit == nil || pkgExplicit.ID != pkgDefault.ID {
		t.Fatalf("expected package %s, got %+v", pkgDefault.ID, pkgExplicit)
	}

	// resolvePackage with explicit invalid ID
	if pkgNone := resolvePackage(fam, "non_existent_pkg_id"); pkgNone != nil {
		t.Fatalf("expected nil for unknown package ID, got %+v", pkgNone)
	}

	// resolvePackage with malformed JSON
	if pkgBad := resolvePackage(json.RawMessage(`{invalid`), ""); pkgBad != nil {
		t.Fatal("expected nil for malformed json")
	}

	// resolvePackage with no default flag (fallback to first)
	customFam := json.RawMessage(`{"packages":[{"id":"p1","default":false},{"id":"p2","default":false}]}`)
	pkgFallback := resolvePackage(customFam, "")
	if pkgFallback == nil || pkgFallback.ID != "p1" {
		t.Fatalf("expected fallback to first package p1, got %+v", pkgFallback)
	}

	// buildResolveURL
	endpoint := "https://huggingface.co"
	repo := "hexgrad/Kokoro-82M"
	rev := "main"
	remote := "voices/af_heart (sample) [1].bin"
	url := buildResolveURL(endpoint, repo, rev, remote)
	if !strings.HasPrefix(url, "https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/") {
		t.Fatalf("unexpected url prefix: %s", url)
	}
	// Space should be encoded as %20
	if !strings.Contains(url, "%20") || strings.Contains(url, "+") {
		t.Fatalf("expected space as %%20, got: %s", url)
	}

	// modelscopeRepo
	if r := modelscopeRepo("audio-cpp/audio.cpp-gguf"); r != "HereIsMark/audio.cpp-gguf" {
		t.Fatalf("unexpected modelscope repo: %s", r)
	}
	if r := modelscopeRepo("single-repo-name"); r != "HereIsMark/single-repo-name" {
		t.Fatalf("unexpected single modelscope repo: %s", r)
	}
}
