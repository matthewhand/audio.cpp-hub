package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
)

// Ming 3.0 Audio (engine family ming3_audio) prefixes ASR text with the detected
// language and a tab, e.g. "English\twelcome back". The hub strips that prefix
// from the top-level "text" and keeps it as a top-level "language" field (the
// same name as the ASR "language" request parameter), so clients get a clean
// transcript without losing the detection. Other families are never rewritten.

const ming3AudioFamily = "ming3_audio"

// maxASRRewriteBytes caps how much of an ASR JSON response the proxy buffers to
// rewrite; larger bodies stream through untouched.
const maxASRRewriteBytes = 8 << 20

var asrLanguagePrefixRe = regexp.MustCompile(`^(\p{L}[\p{L} ()\-]{0,39})\t`)

func asrFamilyHasLanguagePrefix(family string) bool { return family == ming3AudioFamily }

// splitASRLanguagePrefix splits "<Language>\t<text>" into its parts.
func splitASRLanguagePrefix(text string) (language, rest string, ok bool) {
	m := asrLanguagePrefixRe.FindStringSubmatchIndex(text)
	if m == nil {
		return "", text, false
	}
	return text[m[2]:m[3]], text[m[1]:], true
}

// normalizeASRResponse rewrites a ming3_audio ASR JSON body: cleaned "text" plus
// "language" (kept as is when upstream already set one). Any other family,
// non-JSON body or text without a prefix is returned byte-identical.
func normalizeASRResponse(family string, body []byte) ([]byte, bool) {
	if !asrFamilyHasLanguagePrefix(family) {
		return body, false
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(body, &obj); err != nil {
		return body, false
	}
	var text string
	if raw, ok := obj["text"]; !ok || json.Unmarshal(raw, &text) != nil {
		return body, false
	}
	lang, rest, ok := splitASRLanguagePrefix(text)
	if !ok {
		return body, false
	}
	obj["text"] = marshalNoEscape(rest)
	if _, has := obj["language"]; !has {
		obj["language"] = marshalNoEscape(lang)
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(obj); err != nil {
		return body, false
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), true
}

func marshalNoEscape(s string) json.RawMessage {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.Encode(s)
	return json.RawMessage(bytes.TrimRight(buf.Bytes(), "\n"))
}

// normalizeASRResultFile applies normalizeASRResponse to a task result file in place.
func normalizeASRResultFile(family, path string) error {
	if !asrFamilyHasLanguagePrefix(family) {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	out, changed := normalizeASRResponse(family, data)
	if !changed {
		return nil
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, out, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// rewriteV1ASRResponse buffers and normalizes a ming3_audio /v1/audio/transcriptions*
// JSON response before it is streamed back. resp.Body keeps any unread remainder.
func rewriteV1ASRResponse(path string, inst *Instance, resp *http.Response) {
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(path, "/v1/audio/transcriptions") ||
		!asrFamilyHasLanguagePrefix(inst.EngineFamily) ||
		!strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "json") {
		return
	}
	orig := resp.Body
	data, err := io.ReadAll(io.LimitReader(orig, maxASRRewriteBytes+1))
	if err != nil || len(data) > maxASRRewriteBytes {
		resp.Body = io.NopCloser(io.MultiReader(bytes.NewReader(data), orig))
		return
	}
	if out, changed := normalizeASRResponse(inst.EngineFamily, data); changed {
		data = out
		resp.ContentLength = int64(len(data))
	}
	resp.Body = io.NopCloser(bytes.NewReader(data))
}
