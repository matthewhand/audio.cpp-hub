package main

import (
	"bytes"
	"encoding/binary"
	"testing"
)

// ------------------------------------------------------------------ helpers

func wavLE16(v uint16) []byte {
	b := make([]byte, 2)
	binary.LittleEndian.PutUint16(b, v)
	return b
}

func wavLE32(v uint32) []byte {
	b := make([]byte, 4)
	binary.LittleEndian.PutUint32(b, v)
	return b
}

// wavChunk 构造一个 RIFF chunk：id + 声明大小 + 实际 payload；pad 为 true 时补一个字节
// 对齐（用于覆盖奇数长度 chunk 的 padding 逻辑）。
func wavChunk(id string, declared uint32, payload []byte, pad bool) []byte {
	out := append([]byte(id), wavLE32(declared)...)
	out = append(out, payload...)
	if pad {
		out = append(out, 0)
	}
	return out
}

// wavWrap 套上 RIFF/WAVE 文件头。
func wavWrap(body []byte) []byte {
	out := append([]byte("RIFF"), wavLE32(uint32(len(body)+4))...)
	out = append(out, []byte("WAVE")...)
	return append(out, body...)
}

// wavFmtChunk 标准 16 字节 "fmt " chunk。
func wavFmtChunk(format, channels uint16, rate uint32, bits uint16) []byte {
	p := make([]byte, 16)
	binary.LittleEndian.PutUint16(p[0:2], format)
	binary.LittleEndian.PutUint16(p[2:4], channels)
	binary.LittleEndian.PutUint32(p[4:8], rate)
	binary.LittleEndian.PutUint16(p[14:16], bits)
	return wavChunk("fmt ", 16, p, false)
}

func wavDataChunk(n int) []byte {
	return wavChunk("data", uint32(n), make([]byte, n), false)
}

func userErrCode(err error) string {
	if ue, ok := err.(*UserError); ok {
		return ue.Code
	}
	return ""
}

// ------------------------------------------------------------------ tests

func TestParseWAVReader(t *testing.T) {
	clamped := wavWrap(append(wavFmtChunk(1, 1, 44100, 16),
		wavChunk("data", 1000000, make([]byte, 100), false)...))

	cases := []struct {
		name         string
		data         []byte
		fileSize     int64 // 0 => len(data)
		wantErrCode  string
		checkFormat  bool
		wantFormat   int
		wantChannels int
		wantRate     int
		wantBits     int
		wantDuration float64
		durTol       float64
	}{
		{
			name:         "canonical PCM fmt(1)+data",
			data:         wavWrap(append(wavFmtChunk(1, 1, 44100, 16), wavDataChunk(88200)...)),
			wantChannels: 1, wantRate: 44100, wantBits: 16, wantDuration: 1.0, durTol: 1e-9,
		},
		{
			name:         "float fmt(3)",
			data:         wavWrap(append(wavFmtChunk(3, 1, 8000, 32), wavDataChunk(32000)...)),
			wantChannels: 1, wantRate: 8000, wantBits: 32, wantDuration: 1.0, durTol: 1e-9,
		},
		{
			name:        "truncated fmt chunk",
			data:        wavWrap(wavChunk("fmt ", 16, []byte{1, 2, 3}, false)),
			wantErrCode: "WAV_CHUNKS_MISSING",
		},
		{
			name:         "data.chunkSize clamped to remaining bytes",
			data:         clamped,
			wantChannels: 1, wantRate: 44100, wantBits: 16,
			wantDuration: 100.0 / 88200.0, durTol: 1e-6,
		},
		{
			name:        "missing data chunk",
			data:        wavWrap(wavFmtChunk(1, 1, 44100, 16)),
			wantErrCode: "WAV_CHUNKS_MISSING",
		},
		{
			name: "odd-size chunk padding walked correctly",
			data: wavWrap(append(append(
				wavChunk("junk", 3, []byte{1, 2, 3}, true),
				wavFmtChunk(1, 2, 48000, 16)...),
				wavDataChunk(19200)...)),
			wantChannels: 2, wantRate: 48000, wantBits: 16, wantDuration: 0.1, durTol: 1e-9,
		},
		{
			name:        "zero channels -> fmt invalid",
			data:        wavWrap(append(wavFmtChunk(1, 0, 44100, 16), wavDataChunk(100)...)),
			wantErrCode: "WAV_FMT_INVALID",
		},
		{
			name:        "zero sample rate -> fmt invalid",
			data:        wavWrap(append(wavFmtChunk(1, 1, 0, 16), wavDataChunk(100)...)),
			wantErrCode: "WAV_FMT_INVALID",
		},
		{
			name:        "zero bits per sample -> fmt invalid",
			data:        wavWrap(append(wavFmtChunk(1, 1, 44100, 0), wavDataChunk(100)...)),
			wantErrCode: "WAV_FMT_INVALID",
		},
		{
			name:        "non-PCM fmt(2) -> WAV_NOT_PCM with format param",
			data:        wavWrap(append(wavFmtChunk(2, 1, 44100, 16), wavDataChunk(100)...)),
			wantErrCode: "WAV_NOT_PCM", checkFormat: true, wantFormat: 2,
		},
		{
			name:        "not a RIFF file",
			data:        []byte("NOPEnopeNOPE........"),
			wantErrCode: "NOT_WAV",
		},
		{
			name:        "short header -> NOT_WAV",
			data:        []byte("RIFF"),
			wantErrCode: "NOT_WAV",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			size := tc.fileSize
			if size == 0 {
				size = int64(len(tc.data))
			}
			info, err := parseWAVReader(bytes.NewReader(tc.data), size)
			gotCode := userErrCode(err)
			if gotCode != tc.wantErrCode {
				t.Fatalf("error code = %q (err=%v), want %q", gotCode, err, tc.wantErrCode)
			}
			if tc.wantErrCode != "" {
				if tc.checkFormat {
					ue, ok := err.(*UserError)
					if !ok {
						t.Fatalf("error type = %T, want *UserError", err)
					}
					if got := ue.Params["format"]; got != tc.wantFormat {
						t.Fatalf("error format param = %v, want %d", got, tc.wantFormat)
					}
				}
				return
			}
			if info.channels != tc.wantChannels || info.sampleRate != tc.wantRate || info.bitsPerSample != tc.wantBits {
				t.Fatalf("info = %+v, want channels=%d rate=%d bits=%d",
					info, tc.wantChannels, tc.wantRate, tc.wantBits)
			}
			if diff := info.durationSec - tc.wantDuration; diff < -tc.durTol || diff > tc.durTol {
				t.Fatalf("duration = %v, want %v (±%v)", info.durationSec, tc.wantDuration, tc.durTol)
			}
		})
	}
}
