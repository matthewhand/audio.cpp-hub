package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// pcmWAV builds a PCM16 mono WAV holding n samples of value v at the given rate.
func pcmWAV(rate, n int, v int16) []byte {
	pcm := make([]byte, n*2)
	for i := 0; i < n; i++ {
		binary.LittleEndian.PutUint16(pcm[i*2:], uint16(v))
	}
	var b bytes.Buffer
	b.WriteString("RIFF")
	binary.Write(&b, binary.LittleEndian, uint32(36+len(pcm)))
	b.WriteString("WAVEfmt ")
	binary.Write(&b, binary.LittleEndian, uint32(16))
	binary.Write(&b, binary.LittleEndian, uint16(1))
	binary.Write(&b, binary.LittleEndian, uint16(1))
	binary.Write(&b, binary.LittleEndian, uint32(rate))
	binary.Write(&b, binary.LittleEndian, uint32(rate*2))
	binary.Write(&b, binary.LittleEndian, uint16(2))
	binary.Write(&b, binary.LittleEndian, uint16(16))
	b.WriteString("data")
	binary.Write(&b, binary.LittleEndian, uint32(len(pcm)))
	b.Write(pcm)
	return b.Bytes()
}

func TestSplitSpeechChunks(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"", nil},
		{"   ", nil},
		{"Hello there.", []string{"Hello there."}},
		{"The weather today looks lovely, with clear skies all afternoon. You might want a light jacket later, because it cools down quickly after sunset. Let me know if you want the forecast for tomorrow as well.",
			[]string{"The weather today looks lovely,", "with clear skies all afternoon.",
				"You might want a light jacket later, because it cools down quickly after sunset.",
				"Let me know if you want the forecast for tomorrow as well."}},
		{"Dr. Smith paid 3.50 dollars today. Then he left!", []string{"Dr. Smith paid 3.50 dollars today.", "Then he left!"}},
		{"Really?! \"Yes.\" Fine", []string{"Really?!", "\"Yes.\"", "Fine"}},
		{"First line\nsecond line", []string{"First line", "second line"}},
		{"你好。今天天气很好！", []string{"你好。", "今天天气很好！"}},
		{"Short one. ...", []string{"Short one. ..."}},
	}
	for _, c := range cases {
		got := splitSpeechChunks(c.in)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("splitSpeechChunks(%q)\n got %q\nwant %q", c.in, got, c.want)
		}
	}
}

func TestSplitSpeechChunksLongFirstSentenceWithoutCommas(t *testing.T) {
	in := "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone. Done."
	got := splitSpeechChunks(in)
	if len(got) < 3 || len(strings.Fields(got[0])) > 12 {
		t.Fatalf("first chunk must be short for fast first audio, got %q", got)
	}
	if strings.Join(got, " ") != in {
		t.Fatalf("chunks must cover the text exactly, got %q", got)
	}
}

func TestSplitSpeechChunksCapsVeryLongSentences(t *testing.T) {
	in := "Start. " + strings.Repeat("word ", 120) + "end."
	for _, c := range splitSpeechChunks(in) {
		if n := len([]rune(c)); n > speechChunkMaxRunes {
			t.Fatalf("chunk of %d runes exceeds cap %d", n, speechChunkMaxRunes)
		}
	}
}

type chunkEngine struct {
	mu     sync.Mutex
	bodies []map[string]any
	rates  map[int]int // request index -> sample rate override
	status map[int]int // request index -> HTTP status override
	block  map[int]chan struct{}
	ctxErr chan error
}

func (e *chunkEngine) handler(w http.ResponseWriter, r *http.Request) {
	var m map[string]any
	json.NewDecoder(r.Body).Decode(&m)
	e.mu.Lock()
	idx := len(e.bodies)
	e.bodies = append(e.bodies, m)
	rate := 8000
	if v, ok := e.rates[idx]; ok {
		rate = v
	}
	st, blk := e.status[idx], e.block[idx]
	e.mu.Unlock()
	if blk != nil {
		close(blk)
		select {
		case <-r.Context().Done():
			e.ctxErr <- r.Context().Err()
		case <-time.After(3 * time.Second):
			e.ctxErr <- nil
		}
		return
	}
	if st != 0 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(st)
		w.Write([]byte(`{"error":{"message":"engine boom"}}`))
		return
	}
	w.Header().Set("Content-Type", "audio/wav")
	w.Write(pcmWAV(rate, 400, int16(idx+1)))
}

func (e *chunkEngine) count() int { e.mu.Lock(); defer e.mu.Unlock(); return len(e.bodies) }

func newChunkHub(t *testing.T, e *chunkEngine, modelID string) (*Hub, string) {
	t.Helper()
	chdirTemp(t)
	engine := httptest.NewServer(http.HandlerFunc(e.handler))
	t.Cleanup(engine.Close)
	h := &Hub{cfg: HubConfig{ProxyMaxBodyBytes: 1 << 20}, instances: NewInstanceManager(18090, 8080), history: NewHistoryManager()}
	name := strings.ReplaceAll(modelID, "_", "-")
	h.instances.items["m1"] = &Instance{ID: "m1", Name: name, ModelID: modelID, ServerTask: "tts",
		Status: "READY", Port: portOf(t, engine.URL)}
	hub := httptest.NewServer(h.newHandler())
	t.Cleanup(hub.Close)
	return h, hub.URL
}

const threeSentences = "The weather today looks lovely, with clear skies all afternoon. You might want a light jacket later, because it cools down quickly after sunset. Let me know if you want the forecast for tomorrow as well."

func postSpeech(t *testing.T, url, body string, hdr map[string]string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("POST", url+"/v1/audio/speech", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

// expectedPCM is what the fake engine returns for n chunks, joined.
func expectedPCM(n int) []byte {
	var b bytes.Buffer
	for i := 0; i < n; i++ {
		w := pcmWAV(8000, 400, int16(i+1))
		b.Write(w[44:])
	}
	return b.Bytes()
}

func waitHistory(h *Hub, model string, want int) int {
	deadline := time.Now().Add(2 * time.Second)
	for len(h.history.List(model)) < want && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if want == 0 {
		time.Sleep(50 * time.Millisecond)
	}
	return len(h.history.List(model))
}

func TestV1SpeechChunkedStreamWAV(t *testing.T) {
	e := &chunkEngine{}
	h, url := newChunkHub(t, e, "ming3_tts")
	body := `{"model":"ming3-tts","input":"` + threeSentences + `","voice":"warm","seed":42,"stream":true,"options":{"instruct":"speak softly"}}`
	resp := postSpeech(t, url, body, nil)
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "audio/wav" {
		t.Fatalf("status %d content-type %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	if len(got) < 44 || string(got[:4]) != "RIFF" || string(got[36:40]) != "data" ||
		binary.LittleEndian.Uint32(got[40:44]) != 0xFFFFFFFF || binary.LittleEndian.Uint32(got[24:28]) != 8000 {
		t.Fatalf("want a streaming WAV header (data size 0xFFFFFFFF, 8 kHz), got % x", got[:min(44, len(got))])
	}
	if !bytes.Equal(got[44:], expectedPCM(4)) {
		t.Fatalf("PCM must be the 4 chunks joined in order with no gaps: got %d bytes", len(got)-44)
	}
	if e.count() != 4 {
		t.Fatalf("engine calls = %d; want 4", e.count())
	}
	wantInputs := splitSpeechChunks(threeSentences)
	for i, b := range e.bodies {
		if b["input"] != wantInputs[i] || b["voice"] != "warm" || b["seed"] != float64(42) || b["model"] != "ming3-tts" {
			t.Errorf("chunk %d body %v", i, b)
		}
		if o, _ := b["options"].(map[string]any); o["instruct"] != "speak softly" {
			t.Errorf("chunk %d lost options.instruct: %v", i, b["options"])
		}
		for _, k := range []string{"stream", "stream_format", "archive"} {
			if _, ok := b[k]; ok {
				t.Errorf("chunk %d must not forward hub-only field %q", i, k)
			}
		}
		if b["response_format"] != "wav" {
			t.Errorf("chunk %d response_format = %v; want wav", i, b["response_format"])
		}
	}
	if n := waitHistory(h, "ming3_tts", 1); n != 1 {
		t.Fatalf("joined result must be archived once, got %d records", n)
	}
	rec := h.history.List("ming3_tts")[0]
	raw, _ := json.Marshal(rec)
	if !strings.Contains(string(raw), "lovely, with clear skies all afternoon. You might") || !strings.Contains(string(raw), `"durationSec":0.2`) {
		t.Errorf("archive must hold the full text and the joined 0.2 s audio: %s", raw)
	}
}

func TestV1SpeechChunkedStreamPCM(t *testing.T) {
	e := &chunkEngine{}
	_, url := newChunkHub(t, e, "ming3_tts")
	resp := postSpeech(t, url, `{"model":"ming3-tts","input":"One. Two.","stream_format":"audio","response_format":"pcm"}`, nil)
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "audio/pcm" || resp.Header.Get("X-Audio-Sample-Rate") != "8000" {
		t.Fatalf("status %d ct %q rate %q", resp.StatusCode, resp.Header.Get("Content-Type"), resp.Header.Get("X-Audio-Sample-Rate"))
	}
	if !bytes.Equal(got, expectedPCM(2)) {
		t.Fatalf("raw PCM must be the chunks joined, got %d bytes", len(got))
	}
}

func TestV1SpeechChunkedStreamSSE(t *testing.T) {
	e := &chunkEngine{}
	_, url := newChunkHub(t, e, "ming3_tts")
	resp := postSpeech(t, url, `{"model":"ming3-tts","input":"One. Two. Three.","stream_format":"sse"}`, nil)
	defer resp.Body.Close()
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("status %d ct %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	var pcm bytes.Buffer
	var done map[string]any
	sawDone := false
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := strings.TrimPrefix(line, "data: ")
		if data == "[DONE]" {
			sawDone = true
			break
		}
		var ev map[string]any
		if err := json.Unmarshal([]byte(data), &ev); err != nil {
			t.Fatalf("bad event %q", data)
		}
		switch ev["type"] {
		case "speech.audio.delta":
			b, _ := base64.StdEncoding.DecodeString(ev["audio"].(string))
			pcm.Write(b)
		case "speech.audio.done":
			done = ev
		}
	}
	if !sawDone || done == nil || done["sample_rate"] != float64(8000) {
		t.Fatalf("want speech.audio.done with sample_rate then [DONE], got done=%v sawDone=%v", done, sawDone)
	}
	if !bytes.Equal(pcm.Bytes(), expectedPCM(3)) {
		t.Fatalf("SSE deltas must decode to the joined PCM, got %d bytes", pcm.Len())
	}
}

func TestV1SpeechChunkedStreamArchiveOptOut(t *testing.T) {
	for name, c := range map[string]struct {
		body string
		hdr  map[string]string
	}{
		"header": {`{"model":"ming3-tts","input":"One. Two.","stream":true}`, map[string]string{"X-Hub-No-Archive": "1"}},
		"body":   {`{"model":"ming3-tts","input":"One. Two.","stream":true,"archive":false}`, nil},
	} {
		t.Run(name, func(t *testing.T) {
			e := &chunkEngine{}
			h, url := newChunkHub(t, e, "ming3_tts")
			resp := postSpeech(t, url, c.body, c.hdr)
			io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode != 200 {
				t.Fatalf("status %d", resp.StatusCode)
			}
			if n := waitHistory(h, "ming3_tts", 0); n != 0 {
				t.Fatalf("opted-out stream archived %d records", n)
			}
		})
	}
}

func TestV1SpeechChunkedStreamOnlyForOptedInFamilies(t *testing.T) {
	e := &chunkEngine{}
	_, url := newChunkHub(t, e, "sanotts")
	resp := postSpeech(t, url, `{"model":"sanotts","input":"One. Two.","stream":true}`, nil)
	io.ReadAll(resp.Body)
	resp.Body.Close()
	if e.count() != 1 || e.bodies[0]["stream"] != true || e.bodies[0]["input"] != "One. Two." {
		t.Fatalf("non-opted-in family must be proxied untouched, engine saw %v", e.bodies)
	}
}

func TestV1SpeechChunkedStreamNotUsedWithoutStream(t *testing.T) {
	e := &chunkEngine{}
	_, url := newChunkHub(t, e, "ming3_tts")
	resp := postSpeech(t, url, `{"model":"ming3-tts","input":"One. Two."}`, nil)
	io.ReadAll(resp.Body)
	resp.Body.Close()
	if e.count() != 1 || e.bodies[0]["input"] != "One. Two." {
		t.Fatalf("non-streaming request must stay a single proxied call, engine saw %v", e.bodies)
	}
}

func TestV1SpeechChunkedStreamFirstChunkErrorIsRelayed(t *testing.T) {
	e := &chunkEngine{status: map[int]int{0: 500}}
	h, url := newChunkHub(t, e, "ming3_tts")
	resp := postSpeech(t, url, `{"model":"ming3-tts","input":"One. Two.","stream":true}`, nil)
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 500 || !strings.Contains(string(got), "engine boom") {
		t.Fatalf("want the engine's 500 relayed, got %d %q", resp.StatusCode, got)
	}
	if e.count() != 1 || waitHistory(h, "ming3_tts", 0) != 0 {
		t.Fatalf("must stop after a failed first chunk and not archive (calls %d)", e.count())
	}
}

func TestV1SpeechChunkedStreamFormatMismatchStops(t *testing.T) {
	e := &chunkEngine{rates: map[int]int{1: 16000}}
	h, url := newChunkHub(t, e, "ming3_tts")
	resp := postSpeech(t, url, `{"model":"ming3-tts","input":"One. Two. Three.","stream":true}`, nil)
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !bytes.Equal(got[44:], expectedPCM(1)) {
		t.Fatalf("only the first chunk's PCM may be sent once the format changes, got %d bytes", len(got)-44)
	}
	if e.count() != 2 || waitHistory(h, "ming3_tts", 0) != 0 {
		t.Fatalf("must stop on a format change and not archive (calls %d)", e.count())
	}
}

func TestV1SpeechChunkedStreamCancelsOnDisconnect(t *testing.T) {
	blk := make(chan struct{})
	e := &chunkEngine{block: map[int]chan struct{}{1: blk}, ctxErr: make(chan error, 1)}
	h, url := newChunkHub(t, e, "ming3_tts")
	resp := postSpeech(t, url, `{"model":"ming3-tts","input":"One. Two. Three. Four.","stream":true}`, nil)
	buf := make([]byte, 44+800)
	if _, err := io.ReadFull(resp.Body, buf); err != nil {
		t.Fatalf("first chunk not streamed before the rest: %v", err)
	}
	<-blk // chunk 2 is in flight at the engine
	resp.Body.Close()
	select {
	case err := <-e.ctxErr:
		if err == nil {
			t.Fatal("in-flight chunk request was not cancelled after the client left")
		}
	case <-time.After(4 * time.Second):
		t.Fatal("timed out waiting for the engine handler")
	}
	time.Sleep(100 * time.Millisecond)
	if e.count() != 2 {
		t.Fatalf("remaining chunks must not be requested after disconnect, engine calls %d", e.count())
	}
	if waitHistory(h, "ming3_tts", 0) != 0 {
		t.Fatal("a cancelled stream must not be archived")
	}
}
