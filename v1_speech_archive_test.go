package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// testWAV returns a tiny valid PCM16 mono WAV (0.1 s at 8 kHz).
func testWAV() []byte {
	const rate, n = 8000, 800
	var b bytes.Buffer
	b.WriteString("RIFF")
	binary.Write(&b, binary.LittleEndian, uint32(36+n*2))
	b.WriteString("WAVEfmt ")
	binary.Write(&b, binary.LittleEndian, uint32(16))
	binary.Write(&b, binary.LittleEndian, uint16(1))
	binary.Write(&b, binary.LittleEndian, uint16(1))
	binary.Write(&b, binary.LittleEndian, uint32(rate))
	binary.Write(&b, binary.LittleEndian, uint32(rate*2))
	binary.Write(&b, binary.LittleEndian, uint16(2))
	binary.Write(&b, binary.LittleEndian, uint16(16))
	b.WriteString("data")
	binary.Write(&b, binary.LittleEndian, uint32(n*2))
	b.Write(make([]byte, n*2))
	return b.Bytes()
}

type archiveCase struct {
	name      string
	cfgOff    bool
	header    map[string]string
	body      string
	wantSaved bool
}

func runArchiveCase(t *testing.T, c archiveCase) (saved int, engineHeaders http.Header) {
	t.Helper()
	chdirTemp(t)
	var mu sync.Mutex
	wavBytes := testWAV()
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		mu.Lock()
		engineHeaders = r.Header.Clone()
		mu.Unlock()
		w.Header().Set("Content-Type", "audio/wav")
		w.Write(wavBytes)
	}))
	defer engine.Close()
	cfg := HubConfig{ProxyMaxBodyBytes: 1 << 20}
	if c.cfgOff {
		off := false
		cfg.V1SpeechArchive = &off
	}
	h := &Hub{cfg: cfg, instances: NewInstanceManager(18090, 8080), history: NewHistoryManager()}
	h.instances.items["s1"] = &Instance{ID: "s1", Name: "sanotts", ModelID: "sanotts", ServerTask: "tts",
		Status: "READY", Port: portOf(t, engine.URL)}
	hub := httptest.NewServer(h.newHandler())
	defer hub.Close()
	req, _ := http.NewRequest("POST", hub.URL+"/v1/audio/speech", strings.NewReader(c.body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range c.header {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !bytes.Equal(got, wavBytes) {
		t.Fatalf("%s: client must still get the audio: status %d, %d bytes", c.name, resp.StatusCode, len(got))
	}
	// Archiving runs after the last byte is streamed, so it can trail the client read.
	deadline := time.Now().Add(2 * time.Second)
	for len(h.history.List("sanotts")) == 0 && c.wantSaved && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !c.wantSaved {
		time.Sleep(50 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	return len(h.history.List("sanotts")), engineHeaders
}

func TestV1SpeechArchiveOptOut(t *testing.T) {
	cases := []archiveCase{
		{name: "default archives", body: `{"model":"sanotts","input":"hi"}`, wantSaved: true},
		{name: "body archive false skips", body: `{"model":"sanotts","input":"hi","archive":false}`},
		{name: "header skips", body: `{"model":"sanotts","input":"hi"}`, header: map[string]string{"X-Hub-No-Archive": "1"}},
		{name: "header true word skips", body: `{"model":"sanotts","input":"hi"}`, header: map[string]string{"X-Hub-No-Archive": "true"}},
		{name: "header 0 still archives", body: `{"model":"sanotts","input":"hi"}`, header: map[string]string{"X-Hub-No-Archive": "0"}, wantSaved: true},
		{name: "config off skips", cfgOff: true, body: `{"model":"sanotts","input":"hi"}`},
		{name: "config off, body true archives", cfgOff: true, body: `{"model":"sanotts","input":"hi","archive":true}`, wantSaved: true},
		{name: "body true beats header", body: `{"model":"sanotts","input":"hi","archive":true}`, header: map[string]string{"X-Hub-No-Archive": "1"}, wantSaved: true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			saved, _ := runArchiveCase(t, c)
			want := 0
			if c.wantSaved {
				want = 1
			}
			if saved != want {
				t.Errorf("history records = %d; want %d", saved, want)
			}
		})
	}
}

func TestV1SpeechNoArchiveHeaderNotForwarded(t *testing.T) {
	_, hdr := runArchiveCase(t, archiveCase{name: "hdr", body: `{"model":"sanotts","input":"hi"}`,
		header: map[string]string{"X-Hub-No-Archive": "1"}})
	if hdr.Get("X-Hub-No-Archive") != "" {
		t.Errorf("X-Hub-No-Archive must not reach the engine, got %q", hdr.Get("X-Hub-No-Archive"))
	}
}

func TestV1SpeechArchiveConfigDefault(t *testing.T) {
	chdirTemp(t)
	if cfg := loadConfig(); !cfg.v1SpeechArchiveDefault() {
		t.Error("archiving must default to on when hub.config.json omits v1SpeechArchive")
	}
}
