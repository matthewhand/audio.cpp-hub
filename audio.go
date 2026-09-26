package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"

	"github.com/matthewhand/audio.cpp-hub/internal/idvalidate"
	"github.com/matthewhand/audio.cpp-hub/internal/wav"
)

// 上传音频存储；RIFF/WAV 头解析见 internal/wav。只认标准 PCM WAV（audioFormat 1 或 3），
// 行为与 Java 版 AudioStore 一致。

const maxUploadBytes = 50 * 1024 * 1024

var uploadDir = filepath.Join("data", "uploads")

// toUserError 把 internal 包（wav 解析 / idvalidate 校验）的错误转成 UserError；
// 其它错误原样返回。
func toUserError(err error) error {
	if err == nil {
		return nil
	}
	var we *wav.Error
	if errors.As(err, &we) {
		return &UserError{Code: we.Code, Params: we.Params, Msg: we.Msg}
	}
	var ie *idvalidate.Error
	if errors.As(err, &ie) {
		return &UserError{Code: ie.Code, Params: ie.Params, Msg: ie.Msg}
	}
	return err
}

// saveUpload 保存上传的 WAV 到 data/uploads/<id>.wav，返回音频信息。
func saveUpload(data []byte) (map[string]any, error) {
	info, err := wav.ParseReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, toUserError(err)
	}
	id := newID()
	if err := os.MkdirAll(uploadDir, 0755); err != nil {
		return nil, err
	}
	path := filepath.Join(uploadDir, id+".wav")
	if err := os.WriteFile(path, data, 0644); err != nil {
		return nil, err
	}
	abs, _ := filepath.Abs(path)
	return wavInfoMap(id, abs, info, int64(len(data))), nil
}

// probeWAV 解析本地路径的 WAV 信息（"本地路径"Tab 用）。
func probeWAV(pathStr string) (map[string]any, error) {
	if !isRegularFile(pathStr) {
		return nil, newUserError("FILE_NOT_FOUND", "文件不存在: "+pathStr)
	}
	st, _ := os.Stat(pathStr)
	if st.Size() > maxUploadBytes {
		return nil, newUserError("FILE_TOO_LARGE", "文件超过 50MB 上限: "+pathStr)
	}
	info, err := wav.ParseFile(pathStr)
	if err != nil {
		return nil, toUserError(err)
	}
	abs, _ := filepath.Abs(pathStr)
	return wavInfoMap("", abs, info, st.Size()), nil
}

// uploadPath 定位上传文件；id 不合法或文件不存在返回空串（防路径穿越）。
func uploadPath(id string) string {
	if !idvalidate.SafeID(id) {
		return ""
	}
	path := filepath.Join(uploadDir, id+".wav")
	if isRegularFile(path) {
		return path
	}
	return ""
}

// wavInfoMap 输出形状与 Java 版 AudioStore.toMap 一致（id 为空则不输出）。
func wavInfoMap(id, absPath string, info wav.Info, sizeBytes int64) map[string]any {
	m := map[string]any{
		"path":          absPath,
		"durationSec":   round3(info.DurationSec),
		"sampleRate":    info.SampleRate,
		"channels":      info.Channels,
		"bitsPerSample": info.BitsPerSample,
		"sizeBytes":     sizeBytes,
	}
	if id != "" {
		m["id"] = id
	}
	return m
}

func round3(d float64) float64 {
	return float64(int64(d*1000+0.5)) / 1000
}
