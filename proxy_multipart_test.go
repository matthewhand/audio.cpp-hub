package main

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// buildTranscriptionForm mirrors an OpenAI client: the file part comes first,
// so the model field is only found after skipping the audio bytes.
func buildTranscriptionForm(t *testing.T, model string, audio []byte) (string, []byte) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("file", "clip.wav")
	if err != nil {
		t.Fatal(err)
	}
	fw.Write(audio)
	if model != "" {
		mw.WriteField("model", model)
	}
	mw.WriteField("response_format", "json")
	mw.Close()
	return mw.FormDataContentType(), buf.Bytes()
}

func writeTempBody(t *testing.T, data []byte) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "body.req")
	if err := os.WriteFile(p, data, 0644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestExtractV1MultipartModel(t *testing.T) {
	audio := bytes.Repeat([]byte("RIFF\x00model\"x"), 4096)
	ct, body := buildTranscriptionForm(t, "moss-diarize", audio)
	got, err := extractV1MultipartModel(writeTempBody(t, body), ct)
	if err != nil || got != "moss-diarize" {
		t.Fatalf("got %q, %v; want moss-diarize", got, err)
	}

	ct, body = buildTranscriptionForm(t, "", audio)
	if got, err := extractV1MultipartModel(writeTempBody(t, body), ct); err != nil || got != "" {
		t.Fatalf("missing model: got %q, %v; want empty, nil", got, err)
	}

	if _, err := extractV1MultipartModel(writeTempBody(t, body), "multipart/form-data"); v1ErrStatus(err) != http.StatusBadRequest {
		t.Fatalf("missing boundary: want 400, got %v", err)
	}
	if _, err := extractV1MultipartModel(writeTempBody(t, []byte("garbage")), "multipart/form-data; boundary=zzz"); v1ErrStatus(err) != http.StatusBadRequest {
		t.Fatalf("malformed body: want 400, got %v", err)
	}
}

func TestV1ProxyForwardsMultipartTranscription(t *testing.T) {
	chdirTemp(t)
	audio := []byte("RIFF....WAVEfmt fake-pcm")
	var gotPath, gotModel string
	var gotAudio []byte
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		gotModel = r.FormValue("model")
		if f, _, err := r.FormFile("file"); err == nil {
			gotAudio, _ = io.ReadAll(f)
			f.Close()
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"text":"ok"}`))
	}))
	defer engine.Close()

	h := &Hub{cfg: HubConfig{ProxyMaxBodyBytes: 1 << 20}, instances: NewInstanceManager(18090, 8080)}
	h.instances.items["d1"] = &Instance{ID: "d1", Name: "moss-diarize", Status: "READY", Port: portOf(t, engine.URL)}
	hub := httptest.NewServer(h.newHandler())
	defer hub.Close()

	for _, path := range []string{"/v1/audio/transcriptions", "/v1/audio/transcriptions/details"} {
		gotPath, gotModel, gotAudio = "", "", nil
		ct, body := buildTranscriptionForm(t, "moss-diarize", audio)
		resp, err := http.Post(hub.URL+path, ct, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		out, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s: status %d body %s", path, resp.StatusCode, out)
		}
		if gotPath != path || gotModel != "moss-diarize" || !bytes.Equal(gotAudio, audio) {
			t.Fatalf("%s: engine saw path=%q model=%q audio=%q", path, gotPath, gotModel, gotAudio)
		}
	}

	ct, body := buildTranscriptionForm(t, "nope", audio)
	resp, err := http.Post(hub.URL+"/v1/audio/transcriptions", ct, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown model: want 404, got %d", resp.StatusCode)
	}
}
