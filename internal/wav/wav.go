// Package wav 提供纯 RIFF/WAV 头解析，不依赖 hub 其余代码，便于独立单测。
// 只认标准 PCM WAV（audioFormat 1 或 3），行为与 Java 版 AudioStore 一致。
package wav

import (
	"encoding/binary"
	"fmt"
	"io"
	"os"
)

// Info WAV 头解析结果。
type Info struct {
	SampleRate    int
	Channels      int
	BitsPerSample int
	DurationSec   float64
}

// Error 带 code/params 的解析错误；由调用方转换成各自的用户错误类型。
type Error struct {
	Code   string
	Params map[string]any
	Msg    string
}

func (e *Error) Error() string { return e.Msg }

func newError(code, msg string) *Error {
	return &Error{Code: code, Params: map[string]any{}, Msg: msg}
}

// ParseFile 流式解析 WAV 头（不整文件读入内存）。
func ParseFile(path string) (Info, error) {
	f, err := os.Open(path)
	if err != nil {
		return Info{}, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return Info{}, err
	}
	return ParseReader(f, st.Size())
}

// ParseReader 逐 chunk 读头，命中 data 记大小即止。
// 错误码与 Java 版一致：NOT_WAV / WAV_CHUNKS_MISSING / WAV_NOT_PCM / WAV_FMT_INVALID。
func ParseReader(r io.ReadSeeker, fileSize int64) (Info, error) {
	var info Info
	magic := make([]byte, 12)
	if _, err := io.ReadFull(r, magic); err != nil ||
		string(magic[0:4]) != "RIFF" || string(magic[8:12]) != "WAVE" {
		return info, newError("NOT_WAV", "不是标准 RIFF/WAVE 文件")
	}
	audioFormat := -1
	dataSize := int64(-1)
	position := int64(12)
	for {
		head := make([]byte, 8)
		if _, err := io.ReadFull(r, head); err != nil {
			break
		}
		chunkID := string(head[0:4])
		chunkSize := int64(binary.LittleEndian.Uint32(head[4:8]))
		position += 8
		switch chunkID {
		case "fmt ":
			fmtBuf := make([]byte, 16)
			if _, err := io.ReadFull(r, fmtBuf); err != nil {
				break
			}
			position += 16
			audioFormat = int(binary.LittleEndian.Uint16(fmtBuf[0:2]))
			info.Channels = int(binary.LittleEndian.Uint16(fmtBuf[2:4]))
			info.SampleRate = int(binary.LittleEndian.Uint32(fmtBuf[4:8]))
			info.BitsPerSample = int(binary.LittleEndian.Uint16(fmtBuf[14:16]))
			rest := chunkSize - 16 + chunkSize%2
			if rest > 0 {
				r.Seek(rest, io.SeekCurrent)
				position += rest
			}
		case "data": // 内容无需读取
			dataSize = chunkSize
			if remain := fileSize - position; dataSize > remain && remain >= 0 {
				dataSize = remain
			}
		default:
			r.Seek(chunkSize+chunkSize%2, io.SeekCurrent)
			position += chunkSize + chunkSize%2
		}
		if chunkID == "data" {
			break
		}
	}
	if audioFormat == -1 || dataSize < 0 {
		return info, newError("WAV_CHUNKS_MISSING", "WAV 中缺少 fmt 或 data chunk")
	}
	if audioFormat != 1 && audioFormat != 3 {
		return info, &Error{Code: "WAV_NOT_PCM",
			Params: map[string]any{"format": audioFormat},
			Msg:    fmt.Sprintf("非 PCM WAV（audioFormat=%d），仅支持 1(PCM int) 或 3(float)", audioFormat)}
	}
	if info.Channels <= 0 || info.SampleRate <= 0 || info.BitsPerSample <= 0 {
		return info, newError("WAV_FMT_INVALID", "WAV fmt 参数非法")
	}
	bytesPerSec := float64(info.SampleRate) * float64(info.Channels) * float64(info.BitsPerSample) / 8
	if bytesPerSec > 0 {
		info.DurationSec = float64(dataSize) / bytesPerSec
	}
	return info, nil
}
