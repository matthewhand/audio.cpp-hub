package main

// Long-input chunking for POST /v1/audio/speech.
//
// Some engines have a hard ceiling on one utterance that is well below what an
// agent sends: sanoTTS fails a ~200 character paragraph with "phonemization
// produced no symbols" and a 100-digit run with "phoneme sequence has 342
// tokens ... at most 207". The fan-out cannot see phonemes, so a route declares
// the character budget its engine can actually take (maxInputChars) and
// anything longer is split at sentence boundaries, synthesised chunk by chunk
// on the same target, and returned as one WAV.
//
// Chunking is deliberately not streaming: the caller gets one
// Content-Length WAV exactly like an unchunked reply, so every existing client
// keeps working. It is also not attempted for streamed or non-WAV requests.

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// maxChunkReplyBytes bounds one chunk's engine reply held in memory.
const maxChunkReplyBytes = 256 << 20

// speechChunkingInput reports the text to chunk when this route and request
// should be chunked. ok=false means "forward the body untouched".
func speechChunkingInput(rt *Route, fields map[string]json.RawMessage) (string, bool) {
	if rt == nil || rt.MaxInputChars <= 0 {
		return "", false
	}
	// A streaming request already gets the hub's own sentence streaming; joining
	// chunks would defeat it. A non-WAV reply cannot be concatenated either.
	if stream, _ := rawBool(fields, "stream"); stream {
		return "", false
	}
	if rf, _ := rawString(fields, "response_format"); rf != "" && rf != "wav" {
		return "", false
	}
	input, ok := rawString(fields, "input")
	if !ok || utf8.RuneCountInString(input) <= rt.MaxInputChars {
		return "", false
	}
	return input, true
}

// ---------------------------------------------------------------- 分句

// isSentenceEnd reports whether r ends a sentence. '.' only counts when the
// next rune is not word-like, so decimals, versions and host names stay whole.
func isSentenceEnd(runes []rune, i int) bool {
	r := runes[i]
	switch r {
	case '!', '?', '…', '。', '！', '？':
		return true
	case '.':
		if i+1 >= len(runes) {
			return true
		}
		next := runes[i+1]
		return next == ' ' || next == '\n' || next == '\t' || next == '"' || next == '\'' || next == ')'
	}
	return false
}

// isClauseEnd is the second-choice break: it keeps a long sentence readable
// when it has no full stop inside the budget.
func isClauseEnd(r rune) bool {
	switch r {
	case ',', ';', ':', '—', '–', '，', '、', '；', '：', '\n':
		return true
	}
	return false
}

// trailingClosers belong to the sentence that ended, not the next one.
func isCloser(r rune) bool {
	switch r {
	case '"', '\'', ')', ']', '”', '’', '»':
		return true
	}
	return false
}

// chunkSpeechInput splits text into pieces of at most max runes at sentence
// boundaries, falling back to clause and then word boundaries for a single
// sentence that is itself too long. Whitespace-only pieces are dropped.
func chunkSpeechInput(text string, max int) []string {
	if max <= 0 {
		return nil
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil
	}
	if utf8.RuneCountInString(trimmed) <= max {
		return []string{trimmed}
	}

	runes := []rune(text)
	var sentences []string
	start := 0
	for i := 0; i < len(runes); i++ {
		if !isSentenceEnd(runes, i) {
			continue
		}
		for i+1 < len(runes) && isCloser(runes[i+1]) {
			i++
		}
		if s := strings.TrimSpace(string(runes[start : i+1])); s != "" {
			sentences = append(sentences, s)
		}
		start = i + 1
	}
	if s := strings.TrimSpace(string(runes[start:])); s != "" {
		sentences = append(sentences, s)
	}

	out := make([]string, 0, len(sentences))
	for _, s := range sentences {
		if utf8.RuneCountInString(s) <= max {
			out = append(out, s)
			continue
		}
		out = append(out, splitLongSentence(s, max)...)
	}
	return out
}

// splitLongSentence cuts one over-budget sentence, preferring a clause break,
// then a space, then a hard rune cut. Every returned piece is non-empty and at
// most max runes.
func splitLongSentence(s string, max int) []string {
	rest := []rune(strings.TrimSpace(s))
	var out []string
	for len(rest) > 0 {
		if len(rest) <= max {
			out = append(out, strings.TrimSpace(string(rest)))
			break
		}
		cut := -1
		for i := max - 1; i > 0; i-- {
			if isClauseEnd(rest[i]) {
				cut = i + 1
				break
			}
		}
		if cut < 0 {
			for i := max - 1; i > 0; i-- {
				if rest[i] == ' ' || rest[i] == '\t' {
					cut = i
					break
				}
			}
		}
		if cut <= 0 {
			cut = max
		}
		if piece := strings.TrimSpace(string(rest[:cut])); piece != "" {
			out = append(out, piece)
		}
		rest = []rune(strings.TrimSpace(string(rest[cut:])))
	}
	return out
}

// ---------------------------------------------------------------- WAV 拼接

// wavPart is the layout of one RIFF/WAVE reply: its fmt chunk (compared byte
// for byte against the first part) and its PCM payload.
type wavPart struct {
	fmtChunk []byte
	data     []byte
}

// parseWAVPart finds the fmt and data chunks of a WAV reply. Anything else
// (mp3/opus, a truncated body, a WAV with no fmt before data) is an error: it
// cannot be concatenated.
func parseWAVPart(b []byte) (wavPart, error) {
	if len(b) < 12 || string(b[:4]) != "RIFF" || string(b[8:12]) != "WAVE" {
		return wavPart{}, fmt.Errorf("reply is not a RIFF/WAVE file")
	}
	var part wavPart
	off := 12
	for off+8 <= len(b) {
		id := string(b[off : off+4])
		size := int(binary.LittleEndian.Uint32(b[off+4 : off+8]))
		if size < 0 || off+8+size > len(b) {
			return wavPart{}, fmt.Errorf("chunk %q declares %d bytes past the end of the reply", id, size)
		}
		body := b[off : off+8+size]
		switch id {
		case "fmt ":
			part.fmtChunk = body
		case "data":
			if part.fmtChunk == nil {
				return wavPart{}, fmt.Errorf("data chunk appears before fmt")
			}
			part.data = b[off+8 : off+8+size]
			return part, nil
		}
		off += 8 + size + size%2
	}
	return wavPart{}, fmt.Errorf("no data chunk in reply")
}

// joinWAVs concatenates WAV replies that share one format into a single WAV.
func joinWAVs(parts [][]byte) ([]byte, error) {
	if len(parts) == 0 {
		return nil, fmt.Errorf("no audio to join")
	}
	first, err := parseWAVPart(parts[0])
	if err != nil {
		return nil, fmt.Errorf("chunk 1: %w", err)
	}
	datas := make([][]byte, 0, len(parts))
	dataLen := 0
	for i, p := range parts {
		part, err := parseWAVPart(p)
		if err != nil {
			return nil, fmt.Errorf("chunk %d: %w", i+1, err)
		}
		if !bytes.Equal(part.fmtChunk, first.fmtChunk) {
			return nil, fmt.Errorf("chunk %d has a different WAV format", i+1)
		}
		datas = append(datas, part.data)
		dataLen += len(part.data) + len(part.data)%2 // RIFF pads odd chunks
	}

	var buf bytes.Buffer
	buf.Grow(12 + len(first.fmtChunk) + 8 + dataLen)
	buf.WriteString("RIFF")
	binary.Write(&buf, binary.LittleEndian, uint32(4+len(first.fmtChunk)+8+dataLen))
	buf.WriteString("WAVE")
	buf.Write(first.fmtChunk)
	buf.WriteString("data")
	binary.Write(&buf, binary.LittleEndian, uint32(dataLen))
	for _, d := range datas {
		buf.Write(d)
		if len(d)%2 == 1 {
			buf.WriteByte(0)
		}
	}
	return buf.Bytes(), nil
}

// ---------------------------------------------------------------- 分块转发

// postSpeechChunk sends one chunk body to the target and returns the whole
// reply. It is the buffered counterpart of relayUpstream: nothing is written to
// the client, so a failed chunk can still fail over to another target.
func postSpeechChunk(r *http.Request, target Target, body []byte) (http.Header, []byte, error) {
	url := target.Hub + "/v1/audio/speech"
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.ContentLength = int64(len(body))
	resp, err := forwardClient.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	reply, err := io.ReadAll(io.LimitReader(resp.Body, maxChunkReplyBytes+1))
	if err != nil {
		return nil, nil, err
	}
	if int64(len(reply)) > maxChunkReplyBytes {
		return nil, nil, fmt.Errorf("chunk reply larger than %d bytes", maxChunkReplyBytes)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, nil, &httpError{status: resp.StatusCode, url: target.Hub + ": " + summarize(reply)}
	}
	return resp.Header, reply, nil
}

// relayChunkedSpeech synthesises text in sentence chunks on one target and
// writes the joined WAV. max is the route's maxInputChars.
func relayChunkedSpeech(w http.ResponseWriter, r *http.Request, target Target, fields map[string]json.RawMessage, text string, max int) (forwardResult, error) {
	chunks := chunkSpeechInput(text, max)
	if len(chunks) < 2 {
		// Nothing to split after all: the single-chunk path is cheaper and keeps
		// the engine's own timing headers.
		body, err := rewriteField(fields, "input", strings.TrimSpace(text))
		if err != nil {
			return forwardResult{}, err
		}
		return relayUpstream(w, r, target, "/v1/audio/speech", body)
	}

	start := time.Now()
	parts := make([][]byte, 0, len(chunks))
	for i, chunk := range chunks {
		body, err := rewriteField(fields, "input", chunk)
		if err != nil {
			return forwardResult{}, err
		}
		_, reply, err := postSpeechChunk(r, target, body)
		if err != nil {
			// Nothing has reached the client, so the failover loop may still try
			// another target; name the chunk that broke to make the log readable.
			var he *httpError
			if errors.As(err, &he) {
				return forwardResult{}, &httpError{status: he.status, url: he.url, detail: he.detail + fmt.Sprintf(" (chunk %d/%d)", i+1, len(chunks))}
			}
			return forwardResult{}, fmt.Errorf("chunk %d/%d: %w", i+1, len(chunks), err)
		}
		parts = append(parts, reply)
	}

	joined, err := joinWAVs(parts)
	if err != nil {
		return forwardResult{}, fmt.Errorf("joining %d chunk WAVs: %w", len(parts), err)
	}

	h := w.Header()
	h.Set("Content-Type", "audio/wav")
	h.Set("Content-Length", strconv.Itoa(len(joined)))
	h.Set("X-Fanout-Hub", target.Hub)
	if target.InstanceName != "" {
		h.Set("X-Fanout-Instance", target.InstanceName)
	}
	h.Set("X-Fanout-Chunks", strconv.Itoa(len(parts)))
	h.Set("X-Fanout-Wall-Ms", strconv.FormatInt(time.Since(start).Milliseconds(), 10))
	w.WriteHeader(http.StatusOK)
	_, err = w.Write(joined)
	return forwardResult{Streamed: true}, err
}
