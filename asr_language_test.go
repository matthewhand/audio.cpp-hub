package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func decodeASR(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var obj map[string]any
	if err := json.Unmarshal(body, &obj); err != nil {
		t.Fatalf("response is not JSON: %v: %s", err, body)
	}
	return obj
}

func TestSplitASRLanguagePrefix(t *testing.T) {
	cases := []struct {
		in, lang, rest string
		ok             bool
	}{
		{"English\twelcome back everyone", "English", "welcome back everyone", true},
		{"Chinese\t你好世界", "Chinese", "你好世界", true},
		{"welcome back everyone", "", "welcome back everyone", false},
		{"", "", "", false},
		{"\tleading tab only", "", "\tleading tab only", false},
		{"two words\tare not a language? still letters", "two words", "are not a language? still letters", true},
		{"[S01]\tnot a language", "", "[S01]\tnot a language", false},
		{"hello world, this has a\ttab later", "", "hello world, this has a\ttab later", false},
	}
	for _, c := range cases {
		lang, rest, ok := splitASRLanguagePrefix(c.in)
		if lang != c.lang || rest != c.rest || ok != c.ok {
			t.Errorf("splitASRLanguagePrefix(%q) = (%q, %q, %v), want (%q, %q, %v)", c.in, lang, rest, ok, c.lang, c.rest, c.ok)
		}
	}
}

func TestNormalizeASRResponseMing3StripsPrefixAndCapturesLanguage(t *testing.T) {
	in := []byte(`{"text":"English\twelcome back everyone let us start with the","timing":{"wall_ms":2326.65,"rtf":0.775549}}`)
	out, changed := normalizeASRResponse("ming3_audio", in)
	if !changed {
		t.Fatalf("want changed for prefixed ming3_audio text")
	}
	obj := decodeASR(t, out)
	if obj["text"] != "welcome back everyone let us start with the" {
		t.Fatalf("text = %q", obj["text"])
	}
	if obj["language"] != "English" {
		t.Fatalf("language = %v, want English", obj["language"])
	}
	timing, _ := obj["timing"].(map[string]any)
	if timing == nil || timing["rtf"] != 0.775549 {
		t.Fatalf("timing not preserved: %v", obj["timing"])
	}
}

func TestNormalizeASRResponseMing3NoPrefixUnchanged(t *testing.T) {
	in := []byte(`{"text":"welcome back everyone","timing":{"rtf":0.5}}`)
	out, changed := normalizeASRResponse("ming3_audio", in)
	if changed || !bytes.Equal(out, in) {
		t.Fatalf("no-prefix body must be byte-identical; changed=%v out=%s", changed, out)
	}
	if _, has := decodeASR(t, out)["language"]; has {
		t.Fatalf("no language field expected without a prefix")
	}
}

func TestNormalizeASRResponseOtherFamiliesUntouched(t *testing.T) {
	in := []byte(`{"text":"English\twelcome back"}`)
	for _, fam := range []string{"", "moss_transcribe_diarize", "parakeet_tdt", "nemotron_asr", "qwen3_asr"} {
		out, changed := normalizeASRResponse(fam, in)
		if changed || !bytes.Equal(out, in) {
			t.Fatalf("family %q: body must be untouched, got %s", fam, out)
		}
	}
}

func TestNormalizeASRResponseKeepsUpstreamLanguage(t *testing.T) {
	in := []byte(`{"text":"English\twelcome","language":"en"}`)
	out, changed := normalizeASRResponse("ming3_audio", in)
	if !changed {
		t.Fatalf("want text cleaned")
	}
	obj := decodeASR(t, out)
	if obj["text"] != "welcome" || obj["language"] != "en" {
		t.Fatalf("got text=%q language=%v", obj["text"], obj["language"])
	}
}

func TestNormalizeASRResponseNonJSONUntouched(t *testing.T) {
	for _, in := range [][]byte{[]byte("English\tplain text"), []byte(`{"text":42}`), []byte(`[1,2]`)} {
		out, changed := normalizeASRResponse("ming3_audio", in)
		if changed || !bytes.Equal(out, in) {
			t.Fatalf("input %s must be untouched, got %s", in, out)
		}
	}
}

func TestNormalizeASRResultFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "x.result.json")
	if err := os.WriteFile(p, []byte(`{"text":"English\thello there"}`), 0644); err != nil {
		t.Fatal(err)
	}
	if err := normalizeASRResultFile("ming3_audio", p); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	obj := decodeASR(t, data)
	if obj["text"] != "hello there" || obj["language"] != "English" {
		t.Fatalf("result file not normalized: %s", data)
	}
	if prev := resultTextPreview(p); prev == nil || *prev != "hello there" {
		t.Fatalf("preview = %v", prev)
	}

	q := filepath.Join(dir, "y.result.json")
	orig := []byte(`{"text":"English\thello there"}`)
	if err := os.WriteFile(q, orig, 0644); err != nil {
		t.Fatal(err)
	}
	if err := normalizeASRResultFile("moss_transcribe_diarize", q); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(q); !bytes.Equal(data, orig) {
		t.Fatalf("other family result file rewritten: %s", data)
	}
}

func TestV1ProxyMing3TranscriptionLanguagePrefix(t *testing.T) {
	chdirTemp(t)
	reply := `{"text":"English\twelcome back","timing":{"rtf":0.7}}`
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Length", strconv.Itoa(len(reply)))
		w.Write([]byte(reply))
	}))
	defer engine.Close()

	h := &Hub{cfg: HubConfig{ProxyMaxBodyBytes: 1 << 20}, instances: NewInstanceManager(18090, 8080)}
	port := portOf(t, engine.URL)
	h.instances.items["m1"] = &Instance{ID: "m1", Name: "ming3-audio", Status: "READY", Port: port, EngineFamily: "ming3_audio"}
	h.instances.items["d1"] = &Instance{ID: "d1", Name: "moss-diarize", Status: "READY", Port: port, EngineFamily: "moss_transcribe_diarize"}
	hub := httptest.NewServer(h.newHandler())
	defer hub.Close()

	post := func(model string) (*http.Response, []byte) {
		ct, body := buildTranscriptionForm(t, model, []byte("RIFF....WAVE"))
		resp, err := http.Post(hub.URL+"/v1/audio/transcriptions", ct, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		out, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s: status %d body %s", model, resp.StatusCode, out)
		}
		return resp, out
	}

	resp, out := post("ming3-audio")
	obj := decodeASR(t, out)
	if obj["text"] != "welcome back" || obj["language"] != "English" {
		t.Fatalf("ming3-audio via hub: %s", out)
	}
	if cl := resp.Header.Get("Content-Length"); cl != "" && cl != strconv.Itoa(len(out)) {
		t.Fatalf("Content-Length %s does not match body length %d", cl, len(out))
	}

	_, out = post("moss-diarize")
	if string(out) != reply {
		t.Fatalf("other family must pass through unchanged, got %s", out)
	}
}
