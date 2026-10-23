package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeMP3TestRequest(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "req.json")
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestKokoroMP3RewriteIsolation(t *testing.T) {
	cases := []struct {
		name, model, path, body string
		want                    bool
		wantError               bool
	}{
		{"explicit_mp3", "kokoro_tts", "/v1/audio/speech", `{"model":"kokoro_tts","input":"hello","voice":"af_bella","response_format":"mp3"}`, true, false},
		{"default_mp3", "kokoro_tts", "/v1/audio/speech", `{"model":"kokoro","input":"hello"}`, true, false},
		{"default_streaming_unchanged", "kokoro_tts", "/v1/audio/speech", `{"model":"kokoro","input":"hello","stream":true}`, false, false},
		{"wav_unchanged", "kokoro_tts", "/v1/audio/speech", `{"response_format":"wav"}`, false, false},
		{"other_model_unchanged", "breeze-tts", "/v1/audio/speech", `{"response_format":"mp3"}`, false, false},
		{"other_route_unchanged", "kokoro_tts", "/v1/audio/transcriptions", `{"response_format":"mp3"}`, false, false},
		{"streaming_rejected", "kokoro_tts", "/v1/audio/speech", `{"response_format":"mp3","stream":true}`, false, true},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			path := writeMP3TestRequest(t, tt.body)
			req, _ := http.NewRequest(http.MethodPost, "http://localhost"+tt.path, strings.NewReader(tt.body))
			req.Header.Set("Content-Type", "application/json")
			got, on, err := prepareKokoroMP3(req, &Instance{ModelID: tt.model}, path, int64(len(tt.body)))
			if (err != nil) != tt.wantError || on != tt.want {
				t.Fatalf("converted=%v err=%v; want converted=%v error=%v", on, err, tt.want, tt.wantError)
			}
			if !tt.want {
				return
			}
			var parsed map[string]json.RawMessage
			if err := json.Unmarshal(got, &parsed); err != nil {
				t.Fatal(err)
			}
			if string(parsed["response_format"]) != `"wav"` {
				t.Fatalf("rewritten format = %s", parsed["response_format"])
			}
			if tt.name == "explicit_mp3" && string(parsed["voice"]) != `"af_bella"` {
				t.Fatalf("voice modified: %s", parsed["voice"])
			}
			if !bytes.Equal([]byte(tt.body), mustRead(t, path)) {
				t.Fatal("rewrote the on-disk original request")
			}
		})
	}
}

func mustRead(t *testing.T, p string) []byte {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestKokoroMP3EncoderFailClosed(t *testing.T) {
	if _, err := kokoroEncodeMP3(context.Background(), []byte("not a WAV")); err == nil {
		t.Fatal("accepted invalid WAV")
	}
	wav := append([]byte("RIFF"), bytes.Repeat([]byte{0}, 4)...)
	wav = append(wav, []byte("WAVE")...)
	wav = append(wav, bytes.Repeat([]byte{0}, 64)...)
	dir := t.TempDir()
	stub := filepath.Join(dir, "ffmpeg")
	if err := os.WriteFile(stub, []byte("#!/bin/sh\nprintf 'BADBADBADBADBADBADBADBADBADBADBADBAD'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	if _, err := kokoroEncodeMP3(context.Background(), wav); err == nil {
		t.Fatal("accepted invalid MP3")
	}
	if err := os.WriteFile(stub, []byte("#!/bin/sh\nprintf 'ID3goodgoodgoodgoodgoodgoodgoodgoodgoodgoodgoodgoodgoodgoodgoodgoodgoodgoodgoodgood'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	b, err := kokoroEncodeMP3(context.Background(), wav)
	if err != nil || !bytes.HasPrefix(b, []byte("ID3")) {
		t.Fatalf("valid stub: %v %q", err, b)
	}
}

func TestBlueGreenLoopbackBind(t *testing.T) {
	for _, tc := range []struct {
		name, host string
		port       int
		want       string
		invalid    bool
	}{
		{"production_default", "", 18080, ":18080", false},
		{"isolated_loopback", "127.0.0.1", 18280, "127.0.0.1:18280", false},
		{"ipv6_loopback", "::1", 18280, "[::1]:18280", false},
		{"reject_hostname", "localhost", 18280, "", true},
		{"reject_port_zero", "", 0, "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := hubListenerAddress(HubConfig{HttpPort: tc.port, HttpBindHost: tc.host})
			if (err != nil) != tc.invalid || got != tc.want {
				t.Fatalf("got %q err %v, want %q invalid=%v", got, err, tc.want, tc.invalid)
			}
		})
	}
}

func TestKokoroMP3HTTPResponse(t *testing.T) {
	wavData := append([]byte("RIFF"), bytes.Repeat([]byte{0}, 4)...)
	wavData = append(wavData, []byte("WAVE")...)
	wavData = append(wavData, bytes.Repeat([]byte{0}, 80)...)
	dir := t.TempDir()
	stub := filepath.Join(dir, "ffmpeg")
	if err := os.WriteFile(stub, []byte("#!/bin/sh\nprintf 'ID3goodgoodgoodgoodgoodgoodgoodgoodgoodgoodgoodgoodgoodgoodgoodgoodgoodgoodgoodgood'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	bodyPath := writeMP3TestRequest(t, `{"model":"kokoro","input":"hello","voice":"af_bella"}`)
	tests := []struct {
		name             string
		status, expected int
		contentType      string
		wav              []byte
	}{
		{"success", 200, 200, "audio/wav", wavData},
		{"upstream_nonwav", 200, 502, "application/json", []byte("{}")},
		{"bad_wav", 200, 502, "audio/wav", []byte("no wav")},
		{"oversized_wav", 200, 502, "audio/wav", bytes.Repeat([]byte{0}, kokoroMP3MaxWAV+1)},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/v1/audio/speech", nil)
			resp := &http.Response{StatusCode: tc.status, Header: http.Header{"Content-Type": []string{tc.contentType}, "Content-Length": []string{"9000"}}, Body: io.NopCloser(bytes.NewReader(tc.wav))}
			h := &Hub{}
			h.sendKokoroMP3(w, req, resp, &Instance{ModelID: "kokoro_tts"}, bodyPath)
			if w.Code != tc.expected {
				t.Fatalf("got HTTP %d wanted %d", w.Code, tc.expected)
			}
			if tc.expected == 200 {
				if got := w.Header().Get("Content-Type"); got != "audio/mpeg" {
					t.Fatalf("bad MP3 MIME %q", got)
				}
				if got := w.Header().Get("Content-Length"); got == "" || got == "9000" {
					t.Fatalf("stale length %q", got)
				}
				if !bytes.HasPrefix(w.Body.Bytes(), []byte("ID3")) {
					t.Fatal("expected ID3 output")
				}
			} else if bytes.HasPrefix(w.Body.Bytes(), []byte("ID3")) {
				t.Fatal("leaked bogus MP3")
			}
		})
	}
}
