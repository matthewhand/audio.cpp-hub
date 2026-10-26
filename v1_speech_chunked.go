package main

// Sentence-chunked streaming for /v1/audio/speech (#196).
//
// Offline-only TTS families (ming3_tts) can't stream from the engine, so the hub splits the
// input into sentences/clauses (with a short first chunk for fast first audio), synthesises
// the chunks in order on the same instance and streams each one's PCM as soon as it is done.
// Opt-in per request: "stream": true or "stream_format": "audio"|"sse". Families opt in via
// HubConfig.V1SpeechChunkedStreamModels (default: ming3_tts only).

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/matthewhand/audio.cpp-hub/internal/idvalidate"
)

const (
	// speechChunkMaxRunes caps one chunk; longer sentences are cut at a clause break or a space.
	speechChunkMaxRunes = 250
	// speechFirstChunkWords: a first sentence longer than this is cut at its first clause break
	// (or after speechFirstChunkCut words when it has none) so the first audio arrives sooner.
	speechFirstChunkWords = 6
	speechFirstChunkCut   = 8
	// v1ChunkMaxWAVBytes bounds one chunk's engine reply held in memory.
	v1ChunkMaxWAVBytes = 256 << 20
	// v1SSEDeltaPCMBytes is the PCM payload size of one speech.audio.delta event.
	v1SSEDeltaPCMBytes = 32 << 10
)

// defaultChunkedStreamModels lists the model families that get hub-side chunked streaming
// when hub.config.json does not set v1SpeechChunkedStreamModels.
var defaultChunkedStreamModels = []string{"ming3_tts"}

// v1SpeechChunkedStream reports whether modelID's /v1/audio/speech supports hub-side
// sentence-chunked streaming.
func (c HubConfig) v1SpeechChunkedStream(modelID string) bool {
	models := defaultChunkedStreamModels
	if c.V1SpeechChunkedStreamModels != nil {
		models = c.V1SpeechChunkedStreamModels
	}
	for _, m := range models {
		if m == modelID {
			return true
		}
	}
	return false
}

// chunkedStreamMode is how chunk audio is written back: a WAV with a streaming header,
// raw PCM, or OpenAI-style SSE speech.audio.delta events.
type chunkedStreamMode string

const (
	chunkedWAV chunkedStreamMode = "wav"
	chunkedPCM chunkedStreamMode = "pcm"
	chunkedSSE chunkedStreamMode = "sse"
)

// v1ChunkedStreamModeFor reads the opt-in from a parsed request body. on=false means a
// normal (non-chunked) request; errMsg is set for an opt-in the hub can't serve.
func v1ChunkedStreamModeFor(body map[string]any) (mode chunkedStreamMode, on bool, errMsg string) {
	sf, _ := body["stream_format"].(string)
	stream, _ := body["stream"].(bool)
	if sf == "" && !stream {
		return "", false, ""
	}
	switch sf {
	case "sse":
		return chunkedSSE, true, ""
	case "", "audio":
		switch optString(body, "response_format") {
		case "", "wav":
			return chunkedWAV, true, ""
		case "pcm":
			return chunkedPCM, true, ""
		default:
			return "", true, "Streaming supports response_format wav or pcm"
		}
	default:
		return "", true, "Unsupported stream_format: " + sf + " (use audio or sse)"
	}
}

// maybeChunkedV1Speech serves the request with chunked streaming when the instance's family
// opted in and the request asked to stream. It returns false when the request should be
// proxied normally.
func (h *Hub) maybeChunkedV1Speech(w http.ResponseWriter, r *http.Request, inst *Instance, bodyPath string) bool {
	if r.URL.Path != "/v1/audio/speech" || r.Method != http.MethodPost || inst.ServerTask != "tts" ||
		!h.cfg.v1SpeechChunkedStream(inst.ModelID) {
		return false
	}
	data, err := os.ReadFile(bodyPath)
	if err != nil {
		return false
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber() // keep seeds and other integers exact when re-encoding per chunk
	var body map[string]any
	if dec.Decode(&body) != nil || body == nil {
		return false
	}
	mode, on, errMsg := v1ChunkedStreamModeFor(body)
	if !on {
		return false
	}
	if errMsg != "" {
		v1Error(w, http.StatusBadRequest, errMsg)
		return true
	}
	input, ok := body["input"].(string)
	if !ok {
		return false // let the engine report the bad request
	}
	chunks := splitSpeechChunks(input)
	if len(chunks) == 0 {
		v1Error(w, http.StatusBadRequest, "input is empty")
		return true
	}
	h.chunkedV1Speech(w, r, inst, body, chunks, mode)
	return true
}

// chunkedV1Speech synthesises chunks in order and streams each as it finishes. The joined
// audio is archived like a normal reply unless the request opted out; a failed, cancelled
// or format-changing stream is not archived.
func (h *Hub) chunkedV1Speech(w http.ResponseWriter, r *http.Request, inst *Instance,
	body map[string]any, chunks []string, mode chunkedStreamMode) {
	ctx := r.Context()
	start := time.Now()
	flusher, _ := w.(http.Flusher)
	flush := func() {
		if flusher != nil {
			flusher.Flush()
		}
	}
	var archive *chunkArchive
	if h.history != nil && v1SpeechShouldArchive(h.cfg.v1SpeechArchiveDefault(), r.Header.Get(noArchiveHeader), body) {
		archive = &chunkArchive{req: v1SpeechArchiveRequest(body)}
		defer archive.discard()
	}
	var format wavFormat
	var firstMs int64
	sent := false
	for i, text := range chunks {
		if ctx.Err() != nil {
			return
		}
		status, ctype, reply, err := h.speechChunkCall(ctx, r, inst, body, text)
		if err == nil && status != http.StatusOK {
			if !sent {
				if ctype == "" {
					ctype = "application/json"
				}
				w.Header().Set("Content-Type", ctype)
				w.WriteHeader(status)
				w.Write(reply)
				return
			}
			err = fmt.Errorf("engine returned HTTP %d", status)
		}
		var f wavFormat
		var pcm []byte
		if err == nil {
			f, pcm, err = parseWAVPCM(reply)
		}
		if err == nil && sent && f != format {
			err = fmt.Errorf("chunk format %+v differs from first chunk %+v", f, format)
		}
		if err != nil {
			if ctx.Err() != nil {
				return // client left; nothing to report
			}
			log.Printf("/v1/audio/speech chunked stream: chunk %d/%d failed: %v", i+1, len(chunks), err)
			if !sent {
				v1Error(w, http.StatusBadGateway, "Model instance failed: "+summarize(err.Error()))
			} else if mode == chunkedSSE {
				writeSSE(w, map[string]any{"type": "error", "error": map[string]any{"message": "chunk failed: " + summarize(err.Error())}})
				flush()
			}
			return
		}
		if !sent {
			format = f
			firstMs = time.Since(start).Milliseconds()
			writeChunkedHeaders(w, mode, format)
			if mode == chunkedWAV {
				if _, werr := w.Write(format.header(0xFFFFFFFF)); werr != nil {
					return
				}
			}
			if archive != nil {
				archive.open(inst.ModelID, format)
			}
			sent = true
		}
		if !writeChunkPCM(w, mode, pcm, flush) {
			return // client disconnected; ctx cancellation stops the rest
		}
		if archive != nil {
			archive.write(pcm)
		}
	}
	if mode == chunkedSSE {
		writeSSE(w, map[string]any{
			"type": "speech.audio.done", "sample_rate": format.rate, "channels": format.channels,
			"bits_per_sample": format.bits, "chunks": len(chunks),
			"timing": map[string]any{"ttft_ms": firstMs, "total_ms": time.Since(start).Milliseconds()},
		})
		io.WriteString(w, "data: [DONE]\n\n")
		flush()
	}
	if archive != nil {
		if path, taskID, ok := archive.finish(); ok {
			h.archiveV1Speech(inst, path, taskID, archive.req)
		}
	}
}

// speechChunkCall posts one chunk to the instance with the caller's fields (voice, seed,
// options...) and returns the engine's whole reply.
func (h *Hub) speechChunkCall(ctx context.Context, r *http.Request, inst *Instance, body map[string]any,
	text string) (status int, ctype string, reply []byte, err error) {
	req := make(map[string]any, len(body))
	for k, v := range body {
		req[k] = v
	}
	req["input"] = text
	req["response_format"] = "wav"
	for _, k := range []string{"stream", "stream_format", "archive"} {
		delete(req, k)
	}
	payload, err := json.Marshal(req)
	if err != nil {
		return 0, "", nil, err
	}
	url := fmt.Sprintf("http://127.0.0.1:%d%s", inst.Port, r.URL.RequestURI())
	up, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return 0, "", nil, err
	}
	copyNonHopHeaders(up.Header, r.Header)
	for _, k := range []string{noArchiveHeader, "Content-Length", "Accept"} {
		up.Header.Del(k)
	}
	up.Header.Set("Content-Type", "application/json")
	resp, err := v1UpstreamClientFor(proxyResponseHeaderTimeout(h.cfg)).Do(up)
	if err != nil {
		return 0, "", nil, err
	}
	defer resp.Body.Close()
	reply, err = io.ReadAll(io.LimitReader(resp.Body, v1ChunkMaxWAVBytes+1))
	if err == nil && len(reply) > v1ChunkMaxWAVBytes {
		err = errors.New("chunk reply too large")
	}
	return resp.StatusCode, resp.Header.Get("Content-Type"), reply, err
}

func writeChunkedHeaders(w http.ResponseWriter, mode chunkedStreamMode, f wavFormat) {
	h := w.Header()
	switch mode {
	case chunkedSSE:
		h.Set("Content-Type", "text/event-stream")
	case chunkedPCM:
		h.Set("Content-Type", "audio/pcm")
	default:
		h.Set("Content-Type", "audio/wav")
	}
	h.Set("X-Audio-Sample-Rate", strconv.Itoa(int(f.rate)))
	h.Set("X-Audio-Channels", strconv.Itoa(int(f.channels)))
	h.Set("X-Audio-Bits-Per-Sample", strconv.Itoa(int(f.bits)))
	h.Set("X-Hub-Stream", "sentence-chunked")
	h.Del("Content-Length")
	w.WriteHeader(http.StatusOK)
}

// writeChunkPCM writes one chunk's samples in the response's framing; false if the client left.
func writeChunkPCM(w http.ResponseWriter, mode chunkedStreamMode, pcm []byte, flush func()) bool {
	step := v1ResponseChunk
	if mode == chunkedSSE {
		step = v1SSEDeltaPCMBytes
	}
	for off := 0; off < len(pcm); off += step {
		end := min(off+step, len(pcm))
		var err error
		if mode == chunkedSSE {
			err = writeSSE(w, map[string]any{"type": "speech.audio.delta", "audio": base64.StdEncoding.EncodeToString(pcm[off:end])})
		} else {
			_, err = w.Write(pcm[off:end])
		}
		if err != nil {
			return false
		}
		flush()
	}
	return true
}

func writeSSE(w io.Writer, ev map[string]any) error {
	b, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "data: %s\n\n", b)
	return err
}

// v1SpeechArchiveRequest picks the request fields kept in operation history.
func v1SpeechArchiveRequest(parsed map[string]any) map[string]any {
	req := map[string]any{}
	if parsed == nil {
		return req
	}
	for _, k := range []string{"input", "voice_ref", "reference_text"} {
		if s := optString(parsed, k); s != "" {
			name := k
			if k == "input" {
				name = "text"
			}
			req[name] = s
		}
	}
	if seed, ok := parsed["seed"]; ok && seed != nil {
		req["seed"] = seed // numeric seeds too (the old inline code only kept string seeds)
	}
	if o, ok := parsed["options"].(map[string]any); ok {
		req["options"] = o
	}
	return req
}

// chunkArchive tees the joined PCM to a temp WAV in the model's history dir.
type chunkArchive struct {
	req    map[string]any
	f      *os.File
	path   string
	taskID string
	format wavFormat
	bytes  int64
}

func (a *chunkArchive) open(modelID string, f wavFormat) {
	a.taskID = newID() + newID()
	if !idvalidate.SafeKey(a.taskID) || !idvalidate.SafeKey(modelID) {
		return
	}
	dir := historyDir(modelID)
	if os.MkdirAll(dir, 0755) != nil {
		return
	}
	tf, err := os.CreateTemp(dir, ".v1-*.wav.tmp")
	if err != nil {
		return
	}
	a.f, a.path, a.format = tf, tf.Name(), f
	if _, err := tf.Write(f.header(0)); err != nil {
		a.drop(err)
	}
}

func (a *chunkArchive) write(pcm []byte) {
	if a.f == nil {
		return
	}
	if _, err := a.f.Write(pcm); err != nil {
		a.drop(err)
		return
	}
	a.bytes += int64(len(pcm))
}

func (a *chunkArchive) drop(err error) {
	log.Printf("/v1/audio/speech chunked archive write failed, skipping archive: %v", err)
	a.f.Close()
	os.Remove(a.path)
	a.f = nil
}

// finish patches the WAV sizes and closes the file, ready for archiveV1Speech.
func (a *chunkArchive) finish() (path, taskID string, ok bool) {
	if a.f == nil || a.bytes == 0 || a.bytes > 0xFFFFFFFF-36 {
		return "", "", false
	}
	if _, err := a.f.WriteAt(a.format.header(uint32(a.bytes)), 0); err != nil {
		a.drop(err)
		return "", "", false
	}
	if err := a.f.Close(); err != nil {
		a.drop(err)
		return "", "", false
	}
	a.f = nil
	return a.path, a.taskID, true
}

// discard removes the temp file unless archiveV1Speech already renamed it away.
func (a *chunkArchive) discard() {
	if a.f != nil {
		a.f.Close()
		a.f = nil
	}
	if a.path != "" {
		os.Remove(a.path)
	}
}

// wavFormat is the fmt chunk fields that must match across chunks.
type wavFormat struct {
	tag, channels uint16
	rate          uint32
	bits          uint16
}

// header returns a canonical 44-byte WAV header; dataSize 0xFFFFFFFF marks a stream of
// unknown length.
func (f wavFormat) header(dataSize uint32) []byte {
	riff := uint32(0xFFFFFFFF)
	if dataSize != 0xFFFFFFFF {
		riff = 36 + dataSize
	}
	block := f.channels * f.bits / 8
	var b bytes.Buffer
	b.WriteString("RIFF")
	binary.Write(&b, binary.LittleEndian, riff)
	b.WriteString("WAVEfmt ")
	binary.Write(&b, binary.LittleEndian, uint32(16))
	binary.Write(&b, binary.LittleEndian, f.tag)
	binary.Write(&b, binary.LittleEndian, f.channels)
	binary.Write(&b, binary.LittleEndian, f.rate)
	binary.Write(&b, binary.LittleEndian, f.rate*uint32(block))
	binary.Write(&b, binary.LittleEndian, block)
	binary.Write(&b, binary.LittleEndian, f.bits)
	b.WriteString("data")
	binary.Write(&b, binary.LittleEndian, dataSize)
	return b.Bytes()
}

// parseWAVPCM returns a WAV's format and sample bytes, tolerating extra chunks and an
// unknown (0xFFFFFFFF) or overlong data size.
func parseWAVPCM(b []byte) (wavFormat, []byte, error) {
	var f wavFormat
	if len(b) < 12 || string(b[:4]) != "RIFF" || string(b[8:12]) != "WAVE" {
		return f, nil, errors.New("engine reply is not a WAV")
	}
	haveFmt := false
	for off := 12; off+8 <= len(b); {
		id := string(b[off : off+4])
		size := int(binary.LittleEndian.Uint32(b[off+4 : off+8]))
		body := off + 8
		if size < 0 || body+size > len(b) {
			size = len(b) - body
		}
		switch id {
		case "fmt ":
			if size < 16 {
				return f, nil, errors.New("WAV fmt chunk too short")
			}
			f = wavFormat{
				tag:      binary.LittleEndian.Uint16(b[body:]),
				channels: binary.LittleEndian.Uint16(b[body+2:]),
				rate:     binary.LittleEndian.Uint32(b[body+4:]),
				bits:     binary.LittleEndian.Uint16(b[body+14:]),
			}
			haveFmt = true
		case "data":
			if !haveFmt || f.channels == 0 || f.bits == 0 || f.rate == 0 {
				return f, nil, errors.New("WAV data before a valid fmt chunk")
			}
			frame := int(f.channels) * int(f.bits) / 8
			pcm := b[body : body+size]
			return f, pcm[:len(pcm)-len(pcm)%max(frame, 1)], nil
		}
		off = body + size + size%2
	}
	return f, nil, errors.New("WAV has no data chunk")
}

// ------------------------------------------------------------------ text splitting

var speechAbbrevs = map[string]bool{
	"mr": true, "mrs": true, "ms": true, "dr": true, "prof": true, "st": true, "sr": true,
	"jr": true, "vs": true, "etc": true, "e.g": true, "i.e": true, "no": true, "approx": true,
}

// splitSpeechChunks splits text into sentence chunks for streaming: sentences end at
// .!?… (followed by space or end), at CJK 。！？, or at a newline; sentences over
// speechChunkMaxRunes are cut at a clause break or space; and a long first sentence is cut
// early so the first chunk is short.
func splitSpeechChunks(text string) []string {
	var out []string
	pending := "" // punctuation-only fragment waiting to join a neighbour
	for _, s := range splitSentences(text) {
		for _, piece := range capChunk(s, speechChunkMaxRunes) {
			if !hasLetterOrDigit(piece) {
				if len(out) > 0 {
					out[len(out)-1] += " " + piece
				} else {
					pending = strings.TrimSpace(pending + " " + piece)
				}
				continue
			}
			if pending != "" {
				piece, pending = pending+" "+piece, ""
			}
			out = append(out, piece)
		}
	}
	if len(out) == 0 && pending != "" {
		return []string{pending}
	}
	if len(out) > 0 {
		out = append(splitFirstChunk(out[0]), out[1:]...)
	}
	return out
}

func splitSentences(text string) []string {
	rs := []rune(text)
	var out []string
	start := 0
	emit := func(end int) {
		if s := strings.TrimSpace(string(rs[start:end])); s != "" {
			out = append(out, s)
		}
		start = end
	}
	for i := 0; i < len(rs); i++ {
		r := rs[i]
		if r == '\n' {
			emit(i)
			continue
		}
		if !isSentenceEnd(r) {
			continue
		}
		j := i + 1
		wide := isWideSentenceEnd(r)
		for j < len(rs) && (isSentenceEnd(rs[j]) || isClosingPunct(rs[j])) {
			wide = wide || isWideSentenceEnd(rs[j])
			j++
		}
		if !wide && j < len(rs) && !unicode.IsSpace(rs[j]) {
			i = j - 1
			continue
		}
		if r == '.' && j == i+1 && isAbbrevBefore(rs[start:i]) {
			continue
		}
		emit(j)
		i = j - 1
	}
	emit(len(rs))
	return out
}

func isSentenceEnd(r rune) bool {
	return r == '.' || r == '!' || r == '?' || r == '…' || isWideSentenceEnd(r)
}

func isWideSentenceEnd(r rune) bool { return r == '。' || r == '！' || r == '？' }

func isClosingPunct(r rune) bool {
	return strings.ContainsRune("\"')]}’”」』）", r)
}

func isClauseBreak(r rune) bool { return strings.ContainsRune(",;:，；：、—", r) }

func isAbbrevBefore(rs []rune) bool {
	k := len(rs)
	for k > 0 && !unicode.IsSpace(rs[k-1]) {
		k--
	}
	word := strings.TrimLeft(string(rs[k:]), "\"'([{“‘")
	if wr := []rune(word); len(wr) == 1 && unicode.IsUpper(wr[0]) {
		return true // an initial, as in "J. Smith"
	}
	return speechAbbrevs[strings.ToLower(word)]
}

func hasLetterOrDigit(s string) bool {
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return true
		}
	}
	return false
}

// capChunk cuts s into pieces of at most max runes, preferring clause breaks, then spaces.
func capChunk(s string, max int) []string {
	var out []string
	rs := []rune(s)
	for len(rs) > max {
		cut := -1
		for i := max - 1; i >= max/3; i-- {
			if isClauseBreak(rs[i]) {
				cut = i + 1
				break
			}
		}
		if cut < 0 {
			for i := max; i >= max/3; i-- {
				if unicode.IsSpace(rs[i]) {
					cut = i
					break
				}
			}
		}
		if cut < 0 {
			cut = max
		}
		if p := strings.TrimSpace(string(rs[:cut])); p != "" {
			out = append(out, p)
		}
		rs = []rune(strings.TrimSpace(string(rs[cut:])))
	}
	if p := strings.TrimSpace(string(rs)); p != "" {
		out = append(out, p)
	}
	return out
}

// splitFirstChunk shortens the first chunk: after its first clause break when the sentence is
// longer than speechFirstChunkWords, or after speechFirstChunkCut words when it has none.
func splitFirstChunk(s string) []string {
	words := strings.Fields(s)
	if len(words) <= 1 {
		return splitFirstChunkNoSpaces(s)
	}
	if len(words) <= speechFirstChunkWords {
		return []string{s}
	}
	for k := 2; k <= 2*speechFirstChunkWords && k < len(words); k++ {
		w := []rune(words[k-1])
		if isClauseBreak(w[len(w)-1]) {
			return []string{strings.Join(words[:k], " "), strings.Join(words[k:], " ")}
		}
	}
	if len(words) > speechFirstChunkCut+3 {
		return []string{strings.Join(words[:speechFirstChunkCut], " "), strings.Join(words[speechFirstChunkCut:], " ")}
	}
	return []string{s}
}

// splitFirstChunkNoSpaces handles scripts written without spaces (CJK): cut a long first
// sentence after its first clause break.
func splitFirstChunkNoSpaces(s string) []string {
	rs := []rune(s)
	if len(rs) <= 24 {
		return []string{s}
	}
	for i := 4; i < 24; i++ {
		if isClauseBreak(rs[i]) {
			return []string{string(rs[:i+1]), strings.TrimSpace(string(rs[i+1:]))}
		}
	}
	return []string{s}
}
