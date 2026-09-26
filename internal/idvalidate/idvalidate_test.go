package idvalidate

import (
	"strings"
	"testing"
)

// errCode 提取 *Error 的错误码，非 *Error 返回空串。
func errCode(err error) string {
	if e, ok := err.(*Error); ok {
		return e.Code
	}
	return ""
}

func TestSafeID(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{name: "hex id", in: "a1b2c3d4", want: true},
		{name: "uppercase and dash", in: "ABC-123", want: true},
		{name: "exactly 32 chars", in: strings.Repeat("a", 32), want: true},

		{name: "empty", in: ""},
		{name: "dot", in: "."},
		{name: "dotdot", in: ".."},
		{name: "slash", in: "a/b"},
		{name: "backslash", in: `a\b`},
		{name: "path traversal", in: "../etc/passwd"},
		{name: "underscore rejected (key-only)", in: "a_b"},
		{name: "space", in: "a b"},
		{name: "nul byte", in: "a\x00"},
		{name: "33 chars", in: strings.Repeat("a", 33)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := SafeID(tc.in); got != tc.want {
				t.Fatalf("SafeID(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestSafeKey(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{name: "model id with underscore", in: "index_tts2", want: true},
		{name: "task id", in: "a1b2c3d4", want: true},
		{name: "dash", in: "ABC-123_x", want: true},
		{name: "exactly 64 chars", in: strings.Repeat("a", 64), want: true},

		{name: "empty", in: ""},
		{name: "dotdot", in: ".."},
		{name: "slash", in: "a/b"},
		{name: "backslash", in: `a\b`},
		{name: "path traversal", in: "../../data"},
		{name: "space", in: "a b"},
		{name: "nul byte", in: "a\x00"},
		{name: "65 chars", in: strings.Repeat("a", 65)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := SafeKey(tc.in); got != tc.want {
				t.Fatalf("SafeKey(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestTargetDir(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{name: "simple", in: "model-1", want: true},
		{name: "dot inside", in: "Qwen2.5-7B", want: true},
		{name: "underscore", in: "a_b", want: true},
		{name: "trailing dot", in: "abc.", want: true},
		{name: "exactly 64 chars", in: strings.Repeat("a", 64), want: true},

		{name: "empty", in: ""},
		{name: "dot", in: "."},
		{name: "dotdot", in: ".."},
		{name: "no alphanumeric", in: "---"},
		{name: "slash", in: "a/b"},
		{name: "backslash", in: `a\b`},
		{name: "space", in: "a b"},
		{name: "path traversal", in: "../models"},
		{name: "65 chars", in: strings.Repeat("a", 65)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := TargetDir(tc.in)
			if !tc.want {
				if err == nil {
					t.Fatalf("TargetDir(%q) = %q, want error", tc.in, got)
				}
				if code := errCode(err); code != "INVALID_TARGET_DIR" {
					t.Fatalf("error code = %q, want INVALID_TARGET_DIR", code)
				}
				return
			}
			if err != nil {
				t.Fatalf("TargetDir(%q) unexpected error: %v", tc.in, err)
			}
			if got != tc.in {
				t.Fatalf("TargetDir(%q) = %q, want unchanged", tc.in, got)
			}
		})
	}
}

func TestFilePath(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		want    string
		wantErr bool
	}{
		{name: "simple relative", in: "dir/file.bin", want: "dir/file.bin"},
		{name: "nested relative", in: "a/b/c.bin", want: "a/b/c.bin"},
		{name: "backslash normalized", in: `a\b\c.bin`, want: "a/b/c.bin"},
		{name: "surrounding whitespace trimmed", in: "  dir/file.bin  ", want: "dir/file.bin"},
		{name: "unicode names accepted", in: "目录/文件.bin", want: "目录/文件.bin"},
		{name: "dot-prefixed segment accepted", in: "a/.hidden", want: "a/.hidden"},
		{name: "dotdot-prefixed segment accepted", in: "a/..b/c", want: "a/..b/c"},
		{name: "exactly 256 bytes accepted", in: strings.Repeat("a", 256), want: strings.Repeat("a", 256)},

		{name: "empty rejected", in: "", wantErr: true},
		{name: "whitespace only rejected", in: "   ", wantErr: true},
		{name: "dotdot segment rejected", in: "a/../b", wantErr: true},
		{name: "bare dotdot rejected", in: "..", wantErr: true},
		{name: "bare dot rejected", in: ".", wantErr: true},
		{name: "dot segment rejected", in: "a/./b", wantErr: true},
		{name: "leading slash rejected", in: "/etc/passwd", wantErr: true},
		{name: "drive letter rejected", in: "C:/x", wantErr: true},
		{name: "colon rejected", in: "c:file", wantErr: true},
		{name: "empty segment rejected", in: "a//b", wantErr: true},
		{name: "trailing slash rejected", in: "a/", wantErr: true},
		{name: "lone slash rejected", in: "/", wantErr: true},
		{name: "257 bytes rejected", in: strings.Repeat("a", 257), wantErr: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := FilePath(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %q", got)
				}
				if code := errCode(err); code != "INVALID_FILE_PATH" {
					t.Fatalf("error code = %q, want INVALID_FILE_PATH", code)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}
