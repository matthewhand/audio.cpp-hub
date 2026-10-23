package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/matthewhand/audio.cpp-hub/internal/idvalidate"
)

// This optional compatibility path is intentionally scoped to non-streaming
// Kokoro speech with explicit response_format=mp3. WAV and other models keep
// using the existing streaming proxy. The native mp3_encode server frontend
// is preferable once its LAME development dependency is available.
const (
	kokoroMP3MaxRequest = 512 << 10
	kokoroMP3MaxWAV     = 24 << 20
	kokoroMP3Timeout    = 25 * time.Second
)

func prepareKokoroMP3(r *http.Request, inst *Instance, bodyPath string, bodyLength int64) ([]byte, bool, error) {
	if inst == nil || inst.ModelID != "kokoro_tts" || r.URL.Path != "/v1/audio/speech" || r.Method != http.MethodPost ||
		!strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		return nil, false, nil
	}
	if bodyLength > kokoroMP3MaxRequest {
		// Larger legacy requests remain under the existing proxy contract.
		return nil, false, nil
	}
	raw, err := os.ReadFile(bodyPath)
	if err != nil {
		return nil, false, err
	}
	var req map[string]json.RawMessage
	if json.Unmarshal(raw, &req) != nil {
		return nil, false, nil
	}
	// Match the OpenAI speech default and the previous Python Kokoro service:
	// omitted response_format means MP3, except for streaming PCM requests.
	format := "mp3"
	if rawFormat, ok := req["response_format"]; ok {
		if json.Unmarshal(rawFormat, &format) != nil || format != "mp3" {
			return nil, false, nil
		}
	}
	var streaming bool
	if len(req["stream"]) > 0 && json.Unmarshal(req["stream"], &streaming) == nil && streaming {
		if _, explicit := req["response_format"]; !explicit {
			return nil, false, nil
		}
		return nil, false, errors.New("MP3 encoding is only supported for non-streaming Kokoro requests")
	}
	req["response_format"] = json.RawMessage(`"wav"`)
	rewritten, err := json.Marshal(req)
	if err != nil {
		return nil, false, err
	}
	return rewritten, true, nil
}

func kokoroEncodeMP3(ctx context.Context, wavData []byte) ([]byte, error) {
	if len(wavData) < 44 || len(wavData) > kokoroMP3MaxWAV ||
		!bytes.Equal(wavData[:4], []byte("RIFF")) || !bytes.Equal(wavData[8:12], []byte("WAVE")) {
		return nil, errors.New("upstream did not provide a bounded WAV")
	}
	ctx, cancel := context.WithTimeout(ctx, kokoroMP3Timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
		"-i", "pipe:0", "-map", "0:a:0", "-codec:a", "libmp3lame", "-b:a", "128k", "-f", "mp3", "pipe:1")
	cmd.Stdin = bytes.NewReader(wavData)
	var output, stderr bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("MP3 encoder timed out or was canceled: %w", ctx.Err())
		}
		return nil, fmt.Errorf("MP3 encoder failed: %w", err)
	}
	mp3 := output.Bytes()
	if len(mp3) < 64 || !(bytes.HasPrefix(mp3, []byte("ID3")) || (mp3[0] == 0xff && mp3[1]&0xe0 == 0xe0)) {
		return nil, errors.New("MP3 encoder produced invalid output")
	}
	return mp3, nil
}

// archiveKokoroMP3WAV writes the original WAV to the existing TTS history,
// so MP3 delivery does not regress the hub's lossless replay/history feature.
func (h *Hub) archiveKokoroMP3WAV(inst *Instance, originalRequest string, wavData []byte) {
	if h.history == nil || inst == nil || !idvalidate.SafeKey(inst.ModelID) {
		return
	}
	var parsed map[string]any
	raw, err := os.ReadFile(originalRequest)
	if err != nil || json.Unmarshal(raw, &parsed) != nil {
		return
	}
	taskID := newID() + newID()
	if !idvalidate.SafeKey(taskID) {
		return
	}
	dir := historyDir(inst.ModelID)
	if os.MkdirAll(dir, 0755) != nil {
		return
	}
	f, err := os.CreateTemp(dir, ".v1-mp3-wav-*.tmp")
	if err != nil {
		return
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err = f.Write(wavData); err != nil {
		f.Close()
		return
	}
	if f.Close() != nil {
		return
	}
	archiveReq := map[string]any{}
	for _, key := range []string{"voice_ref", "reference_text", "seed", "options"} {
		if v, ok := parsed[key]; ok {
			archiveReq[key] = v
		}
	}
	if s, ok := parsed["input"].(string); ok {
		archiveReq["text"] = s
	}
	h.archiveV1Speech(inst, name, taskID, archiveReq)
}

// sendKokoroMP3 is intentionally non-streaming and fails before sending any
// response bytes when the upstream/encoder fails. It never changes unrelated
// models, streaming speech, or the normal WAV proxy path.
func (h *Hub) sendKokoroMP3(w http.ResponseWriter, r *http.Request, resp *http.Response, inst *Instance, bodyPath string) {
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(strings.ToLower(resp.Header.Get("Content-Type")), "audio/wav") {
		v1Error(w, http.StatusBadGateway, "Kokoro MP3 requires a WAV response from the engine")
		return
	}
	wavData, err := io.ReadAll(io.LimitReader(resp.Body, kokoroMP3MaxWAV+1))
	if err != nil || len(wavData) > kokoroMP3MaxWAV {
		v1Error(w, http.StatusBadGateway, "Kokoro WAV exceeded MP3 conversion limit")
		return
	}
	mp3, err := kokoroEncodeMP3(r.Context(), wavData)
	if err != nil {
		// Do not leak raw encoder stderr or paths in the client-visible response.
		v1Error(w, http.StatusBadGateway, "Kokoro MP3 conversion failed")
		return
	}
	copyNonHopHeaders(w.Header(), resp.Header)
	for _, name := range []string{"Content-Length", "Content-Encoding", "Content-Range", "Content-Md5", "Etag", "Accept-Ranges", "Cache-Control"} {
		w.Header().Del(name)
	}
	w.Header().Set("Content-Type", "audio/mpeg")
	w.Header().Set("Content-Length", strconv.Itoa(len(mp3)))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	h.archiveKokoroMP3WAV(inst, bodyPath, wavData)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(mp3)
}
