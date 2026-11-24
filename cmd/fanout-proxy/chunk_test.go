package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"
)

// ---------------------------------------------------------------- 分句

func TestChunkSpeechInput(t *testing.T) {
	tests := []struct {
		name  string
		text  string
		max   int
		want  []string
		check func(t *testing.T, got []string)
	}{
		{
			name: "short text is one chunk",
			text: "Hello there.",
			max:  100,
			want: []string{"Hello there."},
		},
		{
			name: "sentence boundaries split",
			text: "One sentence. Two sentence. Three!",
			max:  20,
			want: []string{"One sentence.", "Two sentence.", "Three!"},
		},
		{
			name: "closing quotes and brackets stay with their sentence",
			text: `He said "go." Then (quietly) left.`,
			max:  20,
			want: []string{`He said "go."`, "Then (quietly) left."},
		},
		{
			name: "a dotted host name is not a sentence break",
			text: "Point it at 10.0.0.36:18082 and it works.",
			max:  30,
			check: func(t *testing.T, got []string) {
				for _, c := range got {
					if utf8.RuneCountInString(c) > 30 {
						t.Errorf("chunk %q is over the budget", c)
					}
					// A period between digits is not a sentence end, so an address
					// must never be the tail of one chunk and the head of the next.
					if strings.HasPrefix(c, ".") || strings.HasSuffix(c, "10.0.") || strings.HasSuffix(c, "10.0.0.") {
						t.Errorf("chunks %q split a dotted address", got)
					}
				}
				joined := strings.Join(got, " ")
				if !strings.Contains(joined, "10.0.0.36") {
					t.Errorf("chunks %q lost the address", got)
				}
			},
		},
		{
			name: "trailing whitespace is dropped",
			text: "   Trim me.   ",
			max:  100,
			want: []string{"Trim me."},
		},
		{name: "empty is nil", text: "   ", max: 100, want: nil},
		{name: "no budget is nil", text: "anything", max: 0, want: nil},
		{
			name: "one over-long sentence breaks at a clause",
			text: "This is a rather long clause, and this is another part of the same sentence that goes on.",
			max:  40,
			check: func(t *testing.T, got []string) {
				if len(got) < 2 {
					t.Fatalf("got %d chunks, want the sentence split", len(got))
				}
				for _, c := range got {
					if utf8.RuneCountInString(c) > 40 {
						t.Errorf("chunk %q is %d runes, over the 40-rune budget", c, utf8.RuneCountInString(c))
					}
				}
				if joined := strings.Join(got, " "); strings.Join(strings.Fields(joined), " ") != strings.Join(strings.Fields("This is a rather long clause, and this is another part of the same sentence that goes on."), " ") {
					t.Errorf("chunks lost or reordered words: %q", got)
				}
			},
		},
		{
			name: "a run with no separators is hard-cut under the budget",
			text: strings.Repeat("7", 95),
			max:  40,
			check: func(t *testing.T, got []string) {
				if len(got) != 3 {
					t.Fatalf("got %d chunks, want 3", len(got))
				}
				for _, c := range got {
					if utf8.RuneCountInString(c) > 40 {
						t.Errorf("chunk %q is %d runes, over budget", c, utf8.RuneCountInString(c))
					}
				}
				if joined := strings.Join(got, ""); joined != strings.Repeat("7", 95) {
					t.Errorf("hard cut lost characters: %d of 95", len(joined))
				}
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := chunkSpeechInput(tc.text, tc.max)
			if tc.check != nil {
				tc.check(t, got)
				return
			}
			if len(got) != len(tc.want) {
				t.Fatalf("chunks = %q, want %q", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Errorf("chunk %d = %q, want %q", i, got[i], tc.want[i])
				}
			}
		})
	}
}

// ---------------------------------------------------------------- WAV 拼接

// testWAV builds a minimal 16-bit PCM WAV.
func testWAV(rate, channels int, sample []byte) []byte {
	var buf bytes.Buffer
	bits := 16
	blockAlign := channels * bits / 8
	buf.WriteString("RIFF")
	binary.Write(&buf, binary.LittleEndian, uint32(36+len(sample)))
	buf.WriteString("WAVEfmt ")
	binary.Write(&buf, binary.LittleEndian, uint32(16))
	binary.Write(&buf, binary.LittleEndian, uint16(1))
	binary.Write(&buf, binary.LittleEndian, uint16(channels))
	binary.Write(&buf, binary.LittleEndian, uint32(rate))
	binary.Write(&buf, binary.LittleEndian, uint32(rate*blockAlign))
	binary.Write(&buf, binary.LittleEndian, uint16(blockAlign))
	binary.Write(&buf, binary.LittleEndian, uint16(bits))
	buf.WriteString("data")
	binary.Write(&buf, binary.LittleEndian, uint32(len(sample)))
	buf.Write(sample)
	return buf.Bytes()
}

func TestJoinWAVs(t *testing.T) {
	a := testWAV(24000, 1, []byte{1, 0, 2, 0})
	b := testWAV(24000, 1, []byte{3, 0, 4, 0, 5, 0})
	joined, err := joinWAVs([][]byte{a, b})
	if err != nil {
		t.Fatalf("joinWAVs: %v", err)
	}
	part, err := parseWAVPart(joined)
	if err != nil {
		t.Fatalf("joined WAV does not parse: %v", err)
	}
	if want := []byte{1, 0, 2, 0, 3, 0, 4, 0, 5, 0}; !bytes.Equal(part.data, want) {
		t.Errorf("joined PCM = %v, want %v", part.data, want)
	}
	var riff uint32
	if err := binary.Read(bytes.NewReader(joined[4:8]), binary.LittleEndian, &riff); err != nil || int(riff) != len(joined)-8 {
		t.Errorf("RIFF size = %d (%v), want %d", riff, err, len(joined)-8)
	}
	if one, err := joinWAVs([][]byte{a}); err != nil || len(one) != len(a) {
		t.Errorf("single-part join = %d bytes (%v), want the input untouched (%d)", len(one), err, len(a))
	}
	if _, err := joinWAVs([][]byte{a, testWAV(48000, 2, []byte{1, 0, 2, 0})}); err == nil {
		t.Error("joinWAVs accepted a different format")
	}
	if _, err := joinWAVs([][]byte{a, []byte("not a wav")}); err == nil {
		t.Error("joinWAVs accepted a non-WAV reply")
	}
	if _, err := joinWAVs(nil); err == nil {
		t.Error("joinWAVs accepted no parts")
	}
}

// ---------------------------------------------------------------- 端到端分块

// wavHub answers every /v1/audio/speech POST with its own WAV and records the
// inputs it was asked to speak.
type wavHub struct {
	srv    *httptest.Server
	mu     sync.Mutex
	inputs []string
	calls  int
	status int
	wav    []byte
}

func newWAVHub(t *testing.T, status int, sample []byte) *wavHub {
	h := &wavHub{status: status, wav: testWAV(24000, 1, sample)}
	h.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		h.calls++
		var body struct {
			Input string `json:"input"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		h.inputs = append(h.inputs, body.Input)
		status, wav := h.status, h.wav
		h.mu.Unlock()
		if status != http.StatusOK {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_, _ = io.WriteString(w, `{"error":{"message":"engine died"}}`)
			return
		}
		w.Header().Set("Content-Type", "audio/wav")
		w.Header().Set("X-Audiocpp-Wall-Ms", "12.5")
		w.WriteHeader(status)
		_, _ = w.Write(wav)
	}))
	t.Cleanup(h.srv.Close)
	return h
}

func (h *wavHub) seen() (int, []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.calls, append([]string(nil), h.inputs...)
}

func TestSpeechChunksLongInput(t *testing.T) {
	hub := newWAVHub(t, http.StatusOK, []byte{1, 0, 2, 0})
	p := newTestProxy(
		[]Hub{{BaseURL: hub.srv.URL}},
		[]Route{{
			Aliases:       []string{"instant", "sanotts"},
			MaxInputChars: 20,
			Targets:       []Target{{Hub: hub.srv.URL, InstanceName: "sanotts"}},
		}},
	)
	markReady(p.hub, hub.srv.URL, "sanotts")

	rec := post(t, p, `{"model":"instant","input":"One sentence here. Another one there. And a third."}`)
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	calls, inputs := hub.seen()
	if calls != 3 {
		t.Fatalf("hub calls = %d, want 3 chunks (inputs %q)", calls, inputs)
	}
	for _, in := range inputs {
		if utf8.RuneCountInString(in) > 20 {
			t.Errorf("chunk %q exceeds the 20-rune budget", in)
		}
	}
	if got := rec.Header().Get("X-Fanout-Chunks"); got != "3" {
		t.Errorf("X-Fanout-Chunks = %q, want 3", got)
	}
	if got := rec.Header().Get("Content-Type"); got != "audio/wav" {
		t.Errorf("Content-Type = %q, want audio/wav", got)
	}
	part, err := parseWAVPart(rec.Body.Bytes())
	if err != nil {
		t.Fatalf("reply is not one WAV: %v", err)
	}
	if want := 3 * 4; len(part.data) != want {
		t.Errorf("joined PCM = %d bytes, want %d (one 4-byte take per chunk)", len(part.data), want)
	}
	if got := rec.Header().Get("X-Fanout-Instance"); got != "sanotts" {
		t.Errorf("X-Fanout-Instance = %q, want sanotts", got)
	}
	if cl := rec.Header().Get("Content-Length"); cl != strconv.Itoa(rec.Body.Len()) {
		t.Errorf("Content-Length = %q, want %d: a joined reply is not streamed", cl, rec.Body.Len())
	}
}

func TestSpeechChunksFailOver(t *testing.T) {
	primary := newWAVHub(t, http.StatusInternalServerError, nil)
	standby := newWAVHub(t, http.StatusOK, []byte{9, 0})
	p := newTestProxy(
		[]Hub{{BaseURL: primary.srv.URL}, {BaseURL: standby.srv.URL}},
		[]Route{{
			Aliases:       []string{"instant"},
			MaxInputChars: 20,
			Targets: []Target{
				{Hub: primary.srv.URL, InstanceName: "sanotts"},
				{Hub: standby.srv.URL, InstanceName: "sanotts"},
			},
		}},
	)
	markReady(p.hub, primary.srv.URL, "sanotts")
	markReady(p.hub, standby.srv.URL, "sanotts")

	rec := post(t, p, `{"model":"instant","input":"One sentence here. Another one there."}`)
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("X-Fanout-Hub"); got != standby.srv.URL {
		t.Errorf("X-Fanout-Hub = %q, want the standby %q", got, standby.srv.URL)
	}
	if n, _ := primary.seen(); n != 1 {
		t.Errorf("primary calls = %d, want 1 (fail fast on a dead target, not per chunk)", n)
	}
}

func TestSpeechShortInputSkipsChunking(t *testing.T) {
	hub := newWAVHub(t, http.StatusOK, []byte{1, 0})
	p := newTestProxy(
		[]Hub{{BaseURL: hub.srv.URL}},
		[]Route{{
			Aliases:       []string{"instant"},
			MaxInputChars: 100,
			Targets:       []Target{{Hub: hub.srv.URL, InstanceName: "sanotts"}},
		}},
	)
	markReady(p.hub, hub.srv.URL, "sanotts")

	rec := post(t, p, `{"model":"instant","input":"Short enough."}`)
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("X-Fanout-Chunks"); got != "" {
		t.Errorf("X-Fanout-Chunks = %q, want no chunking on a short input", got)
	}
}

func TestSpeechStreamingIsNotChunked(t *testing.T) {
	hub := newWAVHub(t, http.StatusOK, []byte{1, 0})
	p := newTestProxy(
		[]Hub{{BaseURL: hub.srv.URL}},
		[]Route{{
			Aliases:       []string{"instant"},
			MaxInputChars: 20,
			Targets:       []Target{{Hub: hub.srv.URL, InstanceName: "sanotts"}},
		}},
	)
	markReady(p.hub, hub.srv.URL, "sanotts")

	post(t, p, `{"model":"instant","input":"One sentence here. Another one there.","stream":true}`)
	if n, _ := hub.seen(); n != 1 {
		t.Errorf("hub calls = %d, want 1: a streamed request is the hub's business, not the splitter's", n)
	}
}

// ---------------------------------------------------------------- 头部透传

func TestSpeechPassesEngineHeaders(t *testing.T) {
	hub := newWAVHub(t, http.StatusOK, []byte{1, 0})
	p := newTestProxy([]Hub{{BaseURL: hub.srv.URL}}, breezeRoute(hub.srv.URL, hub.srv.URL))
	markReady(p.hub, hub.srv.URL, "breeze")

	rec := post(t, p, `{"model":"breeze","input":"hi"}`)
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("X-Audiocpp-Wall-Ms"); got != "12.5" {
		t.Errorf("X-Audiocpp-Wall-Ms = %q, want the engine's 12.5", got)
	}
	if expose := rec.Header().Get("Access-Control-Expose-Headers"); !strings.Contains(expose, "X-Audiocpp-Wall-Ms") {
		t.Errorf("Access-Control-Expose-Headers = %q, want the timing header exposed to browsers", expose)
	}
	if got := rec.Header().Get("X-Fanout-Hub"); got != hub.srv.URL {
		t.Errorf("X-Fanout-Hub = %q, want %q", got, hub.srv.URL)
	}
}
