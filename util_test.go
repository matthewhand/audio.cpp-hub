package main

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUserError(t *testing.T) {
	ue := newUserError("CODE", "message")
	if ue.Error() != "message" {
		t.Fatalf("expected message, got %q", ue.Error())
	}
	if ue.Code != "CODE" {
		t.Fatalf("expected CODE, got %q", ue.Code)
	}
}

func TestJSONResponses(t *testing.T) {
	// okJSON
	rec := httptest.NewRecorder()
	okJSON(rec, map[string]string{"foo": "bar"})
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"ok":true`) || !strings.Contains(rec.Body.String(), `"foo":"bar"`) {
		t.Fatalf("unexpected body: %s", rec.Body.String())
	}

	// errJSON
	recErr := httptest.NewRecorder()
	errJSON(recErr, http.StatusBadRequest, "BAD_REQ", map[string]any{"field": "x"}, "bad request")
	if recErr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", recErr.Code)
	}
	if !strings.Contains(recErr.Body.String(), `"ok":false`) || !strings.Contains(recErr.Body.String(), `"code":"BAD_REQ"`) {
		t.Fatalf("unexpected body: %s", recErr.Body.String())
	}

	// errFromErr with UserError
	recUE := httptest.NewRecorder()
	errFromErr(recUE, http.StatusNotFound, "FALLBACK", newUserError("NOT_FOUND", "not here"))
	if !strings.Contains(recUE.Body.String(), `"code":"NOT_FOUND"`) {
		t.Fatalf("expected NOT_FOUND, got: %s", recUE.Body.String())
	}

	// errFromErr with generic error
	recGen := httptest.NewRecorder()
	errFromErr(recGen, http.StatusInternalServerError, "INTERNAL", errors.New("something broke"))
	if !strings.Contains(recGen.Body.String(), `"code":"INTERNAL"`) {
		t.Fatalf("expected INTERNAL, got: %s", recGen.Body.String())
	}
}

func TestReadBodyMap(t *testing.T) {
	// Missing or wrong Content-Type
	reqNoCT, _ := http.NewRequest("POST", "/", bytes.NewReader([]byte(`{"k":"v"}`)))
	recNoCT := httptest.NewRecorder()
	if body := readBodyMap(recNoCT, reqNoCT); body != nil {
		t.Fatal("expected nil body for missing Content-Type")
	}
	if recNoCT.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("expected 415, got %d", recNoCT.Code)
	}

	// Invalid JSON
	reqBadJSON, _ := http.NewRequest("POST", "/", bytes.NewReader([]byte(`{not valid`)))
	reqBadJSON.Header.Set("Content-Type", "application/json")
	recBadJSON := httptest.NewRecorder()
	if body := readBodyMap(recBadJSON, reqBadJSON); body != nil {
		t.Fatal("expected nil body for invalid JSON")
	}
	if recBadJSON.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", recBadJSON.Code)
	}

	// Trailing data after JSON
	reqTrailing, _ := http.NewRequest("POST", "/", bytes.NewReader([]byte(`{"k":"v"} trailing`)))
	reqTrailing.Header.Set("Content-Type", "application/json")
	recTrailing := httptest.NewRecorder()
	if body := readBodyMap(recTrailing, reqTrailing); body != nil {
		t.Fatal("expected nil body for trailing data")
	}
	if recTrailing.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", recTrailing.Code)
	}

	// JSON null
	reqNull, _ := http.NewRequest("POST", "/", bytes.NewReader([]byte(`null`)))
	reqNull.Header.Set("Content-Type", "application/json")
	recNull := httptest.NewRecorder()
	if body := readBodyMap(recNull, reqNull); body != nil {
		t.Fatal("expected nil body for null JSON")
	}
	if recNull.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", recNull.Code)
	}

	// Valid JSON object
	reqValid, _ := http.NewRequest("POST", "/", bytes.NewReader([]byte(`{"key":"value","num":42}`)))
	reqValid.Header.Set("Content-Type", "application/json")
	recValid := httptest.NewRecorder()
	body := readBodyMap(recValid, reqValid)
	if body == nil {
		t.Fatal("expected valid body, got nil")
	}
	if optString(body, "key") != "value" {
		t.Fatalf("expected key=value, got %v", body["key"])
	}
}

func TestUtils(t *testing.T) {
	// newID
	id1 := newID()
	id2 := newID()
	if len(id1) != 32 || len(id2) != 32 || id1 == id2 {
		t.Fatalf("invalid IDs: %q, %q", id1, id2)
	}

	// expandEnv
	lookup := func(k string) string {
		if k == "FOO" {
			return "bar"
		}
		return ""
	}
	if got := expandEnv("prefix_${FOO}_${BAR}_end", lookup); got != "prefix_bar__end" {
		t.Fatalf("unexpected expandEnv result: %q", got)
	}

	// optString and optIntPtr
	m := map[string]any{
		"str": "hello",
		"num": float64(123),
		"nil": nil,
	}
	if optString(m, "str") != "hello" || optString(m, "none") != "" || optString(m, "num") != "" {
		t.Fatalf("unexpected optString results")
	}
	if ptr := optIntPtr(m, "num"); ptr == nil || *ptr != 123 {
		t.Fatalf("unexpected optIntPtr: %v", ptr)
	}
	if optIntPtr(m, "none") != nil || optIntPtr(m, "str") != nil {
		t.Fatalf("expected nil for non-numeric optIntPtr")
	}

	// optStringMap
	smNil, err := optStringMap(map[string]any{}, "opts")
	if err != nil || len(smNil) != 0 {
		t.Fatalf("expected empty map for missing opts: %v, %v", smNil, err)
	}
	smInvalid, err := optStringMap(map[string]any{"opts": "not-map"}, "opts")
	if err == nil || smInvalid != nil {
		t.Fatalf("expected error for non-map opts")
	}
	smValid, err := optStringMap(map[string]any{
		"opts": map[string]any{
			"str":   "val",
			"float": float64(3.14),
			"bool":  true,
		},
	}, "opts")
	if err != nil || smValid["str"] != "val" || smValid["bool"] != "true" {
		t.Fatalf("unexpected optStringMap result: %v, %v", smValid, err)
	}
	// non-scalar in map
	_, err = optStringMap(map[string]any{
		"opts": map[string]any{
			"nested": map[string]any{"k": "v"},
		},
	}, "opts")
	if err == nil {
		t.Fatal("expected error for nested map in optStringMap")
	}

	// summarize
	short := "short error"
	if summarize(short) != short {
		t.Fatalf("expected short unchanged, got %q", summarize(short))
	}
	long := strings.Repeat("A", 350)
	sum := summarize(long)
	if len([]rune(sum)) != 303 || !strings.HasSuffix(sum, "...") {
		t.Fatalf("unexpected summarize: len=%d, text=%s", len([]rune(sum)), sum)
	}

	// truncateRunes
	if truncateRunes("abc", 5) != "abc" {
		t.Fatalf("expected abc unchanged")
	}
	tr := truncateRunes(strings.Repeat("B", 10), 5)
	if tr != "BBBBB…" {
		t.Fatalf("unexpected truncateRunes: %q", tr)
	}
}

func TestFileHelpers(t *testing.T) {
	tmp := t.TempDir()
	fPath := filepath.Join(tmp, "test_file.txt")

	if pathExists(fPath) || isRegularFile(fPath) || isDir(fPath) {
		t.Fatal("non-existent file should be false for all checks")
	}

	// writeFileAtomic
	if err := writeFileAtomic(fPath, []byte("atomic content")); err != nil {
		t.Fatalf("writeFileAtomic failed: %v", err)
	}
	if !pathExists(fPath) || !isRegularFile(fPath) || isDir(fPath) {
		t.Fatal("regular file checks failed after atomic write")
	}
	data, err := os.ReadFile(fPath)
	if err != nil || string(data) != "atomic content" {
		t.Fatalf("read back failed: %v, %s", err, string(data))
	}

	// isDir check on tmp directory
	if !isDir(tmp) || isRegularFile(tmp) {
		t.Fatal("directory checks failed on tmp")
	}
}
