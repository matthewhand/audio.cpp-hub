package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newTestHubForAPI(t *testing.T) (*Hub, http.Handler) {
	t.Helper()
	tmp := t.TempDir()
	t.Chdir(tmp)

	cfg := HubConfig{
		HttpPort:         18080,
		InstancePortBase: 18090,
		ModelsDir:        "models",
	}
	hub := &Hub{
		cfg:       cfg,
		instances: NewInstanceManager(cfg.InstancePortBase, cfg.HttpPort),
		execs:     NewExecutableRegistry("executables.json"),
		profiles:  NewProfileRegistry("data/profiles.json"),
		history:   NewHistoryManager(),
		voices:    NewVoiceLibrary(),
		downloads: NewDownloadManager(cfg),
		bus:       NewEventBus(),
		metrics:   NewRequestMetrics(time.Now()),
	}
	hub.tasks = NewTaskManager(hub.history)
	hub.mem = NewMemorySampler(hub.instances, hub.tasks, hub.bus)

	handler := hub.newHandler()
	return hub, handler
}

func doRequest(t *testing.T, h http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var r io.Reader
	if body != nil {
		if b, ok := body.([]byte); ok {
			r = bytes.NewReader(b)
		} else if s, ok := body.(string); ok {
			r = strings.NewReader(s)
		} else {
			data, err := json.Marshal(body)
			if err != nil {
				t.Fatalf("failed to marshal body: %v", err)
			}
			r = bytes.NewReader(data)
		}
	}
	req := httptest.NewRequest(method, path, r)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestAPIModels(t *testing.T) {
	_, handler := newTestHubForAPI(t)

	// GET /api/models
	rec := doRequest(t, handler, "GET", "/api/models", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/models failed: %d: %s", rec.Code, rec.Body.String())
	}
	var models []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &models); err != nil || len(models) == 0 {
		t.Fatalf("expected non-empty models array, got err=%v, len=%d", err, len(models))
	}

	// 405 on POST /api/models
	rec405 := doRequest(t, handler, "POST", "/api/models", map[string]any{})
	if rec405.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec405.Code)
	}
	if rec405.Header().Get("Allow") != "GET" {
		t.Fatalf("expected Allow: GET, got %q", rec405.Header().Get("Allow"))
	}

	// GET /api/models/{modelId}/packages
	recPkg := doRequest(t, handler, "GET", "/api/models/kokoro_tts/packages", nil)
	if recPkg.Code != http.StatusOK {
		t.Fatalf("GET packages failed: %d: %s", recPkg.Code, recPkg.Body.String())
	}

	// GET non-existent model packages
	recNoPkg := doRequest(t, handler, "GET", "/api/models/no_such_model/packages", nil)
	if recNoPkg.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for unknown model packages, got %d", recNoPkg.Code)
	}

	// Unknown route 404
	rec404 := doRequest(t, handler, "GET", "/api/unknown_route", nil)
	if rec404.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown api route, got %d", rec404.Code)
	}
}

func TestAPIExecutablesAndProfiles(t *testing.T) {
	_, handler := newTestHubForAPI(t)

	// List executables empty
	rec := doRequest(t, handler, "GET", "/api/executables", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// Add executable (missing name)
	recBad := doRequest(t, handler, "POST", "/api/executables", map[string]any{"path": "/bin/sh"})
	if recBad.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing name, got %d", recBad.Code)
	}

	// Add valid executable
	fakeBin := filepath.Join(".", "fake_bin")
	os.WriteFile(fakeBin, []byte("#!/bin/sh\n"), 0755)
	recAdd := doRequest(t, handler, "POST", "/api/executables", map[string]any{
		"name": "My Exec",
		"path": fakeBin,
		"env":  map[string]string{"SECRET": "tok123"},
	})
	if recAdd.Code != http.StatusOK {
		t.Fatalf("add exec failed: %d: %s", recAdd.Code, recAdd.Body.String())
	}
	var execData map[string]any
	json.Unmarshal(recAdd.Body.Bytes(), &execData)
	execID := optString(execData, "id")

	// Update executable
	recUp := doRequest(t, handler, "PUT", "/api/executables/"+execID, map[string]any{
		"name": "My Exec Updated",
		"path": fakeBin,
		"env":  map[string]string{"SECRET": execEnvMask},
	})
	if recUp.Code != http.StatusOK {
		t.Fatalf("update exec failed: %d: %s", recUp.Code, recUp.Body.String())
	}

	// Update non-existent executable
	recUpNo := doRequest(t, handler, "PUT", "/api/executables/non-existent", map[string]any{
		"name": "Up", "path": fakeBin,
	})
	if recUpNo.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for non-existent exec update, got %d", recUpNo.Code)
	}

	// Exec devices (executable found)
	recDev := doRequest(t, handler, "GET", "/api/executables/"+execID+"/devices", nil)
	// Might return 200 or 504 depending on whether fake_bin implements --list-devices
	_ = recDev.Code

	// Exec devices non-existent
	recDevNo := doRequest(t, handler, "GET", "/api/executables/non-existent/devices", nil)
	if recDevNo.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown exec devices, got %d", recDevNo.Code)
	}

	// Delete executable
	recDel := doRequest(t, handler, "DELETE", "/api/executables/"+execID, nil)
	if recDel.Code != http.StatusOK {
		t.Fatalf("delete exec failed: %d: %s", recDel.Code, recDel.Body.String())
	}

	// Delete non-existent executable
	recDelNo := doRequest(t, handler, "DELETE", "/api/executables/non-existent", nil)
	if recDelNo.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown exec delete, got %d", recDelNo.Code)
	}

	// Profiles
	recProfList := doRequest(t, handler, "GET", "/api/profiles", nil)
	if recProfList.Code != http.StatusOK {
		t.Fatalf("list profiles failed: %d", recProfList.Code)
	}

	// Add profile
	recProfAdd := doRequest(t, handler, "POST", "/api/profiles", map[string]any{
		"name":        "Test Profile",
		"modelId":     "kokoro_tts",
		"weightsPath": fakeBin,
	})
	if recProfAdd.Code != http.StatusOK {
		t.Fatalf("add profile failed: %d: %s", recProfAdd.Code, recProfAdd.Body.String())
	}
	var profData map[string]any
	json.Unmarshal(recProfAdd.Body.Bytes(), &profData)
	profID := optString(profData, "id")

	// Update profile
	recProfUp := doRequest(t, handler, "PUT", "/api/profiles/"+profID, map[string]any{
		"name":        "Test Profile Renamed",
		"modelId":     "kokoro_tts",
		"weightsPath": fakeBin,
	})
	if recProfUp.Code != http.StatusOK {
		t.Fatalf("update profile failed: %d: %s", recProfUp.Code, recProfUp.Body.String())
	}

	// Update non-existent profile
	recProfUpNo := doRequest(t, handler, "PUT", "/api/profiles/no-such-prof", map[string]any{
		"name":        "X",
		"modelId":     "kokoro_tts",
		"weightsPath": fakeBin,
	})
	if recProfUpNo.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown profile update, got %d", recProfUpNo.Code)
	}

	// Delete profile
	recProfDel := doRequest(t, handler, "DELETE", "/api/profiles/"+profID, nil)
	if recProfDel.Code != http.StatusOK {
		t.Fatalf("delete profile failed: %d", recProfDel.Code)
	}

	// Delete non-existent profile
	recProfDelNo := doRequest(t, handler, "DELETE", "/api/profiles/no-such-prof", nil)
	if recProfDelNo.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown profile delete, got %d", recProfDelNo.Code)
	}
}

func TestAPIInstancesAndEventsAndStats(t *testing.T) {
	_, handler := newTestHubForAPI(t)

	// Instances list empty
	rec := doRequest(t, handler, "GET", "/api/instances", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list instances failed: %d", rec.Code)
	}

	// Start instance validation error (no modelId)
	recBadStart := doRequest(t, handler, "POST", "/api/instances", map[string]any{})
	if recBadStart.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty start, got %d", recBadStart.Code)
	}

	// Stop non-existent instance
	recStopNo := doRequest(t, handler, "DELETE", "/api/instances/no-inst", nil)
	if recStopNo.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown instance stop, got %d", recStopNo.Code)
	}

	// Events
	recEvents := doRequest(t, handler, "GET", "/api/events", nil)
	if recEvents.Code != http.StatusOK {
		t.Fatalf("events failed: %d", recEvents.Code)
	}

	// Stats
	recStats := doRequest(t, handler, "GET", "/api/stats", nil)
	if recStats.Code != http.StatusOK {
		t.Fatalf("stats failed: %d", recStats.Code)
	}

	// Metrics recent/summary/request
	recRec := doRequest(t, handler, "GET", "/api/metrics/recent", nil)
	if recRec.Code != http.StatusOK {
		t.Fatalf("metrics recent failed: %d", recRec.Code)
	}
	recSum := doRequest(t, handler, "GET", "/api/metrics/summary", nil)
	if recSum.Code != http.StatusOK {
		t.Fatalf("metrics summary failed: %d", recSum.Code)
	}
	recReqNo := doRequest(t, handler, "GET", "/api/metrics/requests/non-existent", nil)
	if recReqNo.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for non-existent metric request, got %d", recReqNo.Code)
	}
}

func TestAPIAudioAndVoices(t *testing.T) {
	_, handler := newTestHubForAPI(t)

	// Create valid wav
	wavPath := filepath.Join(".", "test.wav")
	makeValidWAV(t, wavPath)
	wavBytes, _ := os.ReadFile(wavPath)

	// Raw audio upload
	reqUpload, err := http.NewRequest("POST", "/api/audio/upload", bytes.NewReader(wavBytes))
	if err != nil {
		t.Fatalf("failed to create upload request: %v", err)
	}
	reqUpload.Header.Set("Content-Type", "application/octet-stream")
	recUpload := httptest.NewRecorder()
	handler.ServeHTTP(recUpload, reqUpload)
	if recUpload.Code != http.StatusOK {
		t.Fatalf("audio upload failed: %d: %s", recUpload.Code, recUpload.Body.String())
	}
	var uploadData map[string]any
	json.Unmarshal(recUpload.Body.Bytes(), &uploadData)
	uploadID := optString(uploadData, "id")

	// Audio info
	recInfo := doRequest(t, handler, "POST", "/api/audio/info", map[string]any{
		"path": wavPath,
	})
	if recInfo.Code != http.StatusOK {
		t.Fatalf("audio info failed: %d: %s", recInfo.Code, recInfo.Body.String())
	}

	// Audio file
	recFile := doRequest(t, handler, "GET", "/api/audio/file?id="+uploadID, nil)
	if recFile.Code != http.StatusOK {
		t.Fatalf("audio file get failed: %d", recFile.Code)
	}
	// Missing id
	recFileNo := doRequest(t, handler, "GET", "/api/audio/file?id=unknown", nil)
	if recFileNo.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for missing audio file id, got %d", recFileNo.Code)
	}

	// Voices: List empty
	recVList := doRequest(t, handler, "GET", "/api/voices", nil)
	if recVList.Code != http.StatusOK {
		t.Fatalf("voices list failed: %d", recVList.Code)
	}

	// Voice Save
	recVSave := doRequest(t, handler, "POST", "/api/voices", map[string]any{
		"name":     "API Voice",
		"uploadId": uploadID,
		"text":     "sample transcript",
	})
	if recVSave.Code != http.StatusOK {
		t.Fatalf("voice save failed: %d: %s", recVSave.Code, recVSave.Body.String())
	}
	var vData map[string]any
	json.Unmarshal(recVSave.Body.Bytes(), &vData)
	vid := optString(vData, "vid")

	// Voice Audio
	recVAudio := doRequest(t, handler, "GET", "/api/voices/"+vid+"/audio", nil)
	if recVAudio.Code != http.StatusOK {
		t.Fatalf("voice audio get failed: %d", recVAudio.Code)
	}

	// Voice Update
	recVUp := doRequest(t, handler, "PUT", "/api/voices/"+vid, map[string]any{
		"name": "API Voice Renamed",
	})
	if recVUp.Code != http.StatusOK {
		t.Fatalf("voice update failed: %d", recVUp.Code)
	}

	// Voice Delete
	recVDel := doRequest(t, handler, "DELETE", "/api/voices/"+vid, nil)
	if recVDel.Code != http.StatusOK {
		t.Fatalf("voice delete failed: %d", recVDel.Code)
	}

	// Voice Delete non-existent
	recVDelNo := doRequest(t, handler, "DELETE", "/api/voices/no-such-vid", nil)
	if recVDelNo.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown voice delete, got %d", recVDelNo.Code)
	}
}

func TestAPIFsEndpoints(t *testing.T) {
	_, handler := newTestHubForAPI(t)

	// /api/fs/roots
	recRoots := doRequest(t, handler, "GET", "/api/fs/roots", nil)
	if recRoots.Code != http.StatusOK {
		t.Fatalf("fs roots failed: %d", recRoots.Code)
	}

	// /api/fs/list
	recList := doRequest(t, handler, "GET", "/api/fs/list?path=.", nil)
	if recList.Code != http.StatusOK {
		t.Fatalf("fs list failed: %d: %s", recList.Code, recList.Body.String())
	}
	recListNo := doRequest(t, handler, "GET", "/api/fs/list?path=", nil)
	if recListNo.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty path in fs list, got %d", recListNo.Code)
	}

	// /api/fs/stat
	recStat := doRequest(t, handler, "GET", "/api/fs/stat?path=.", nil)
	if recStat.Code != http.StatusOK {
		t.Fatalf("fs stat failed: %d", recStat.Code)
	}

	// /api/fs/mkdir
	recMkdir := doRequest(t, handler, "POST", "/api/fs/mkdir", map[string]any{
		"parent": ".",
		"name":   "api_test_folder",
	})
	if recMkdir.Code != http.StatusOK {
		t.Fatalf("fs mkdir failed: %d: %s", recMkdir.Code, recMkdir.Body.String())
	}
}

func TestAPITasksAndHistory(t *testing.T) {
	hub, handler := newTestHubForAPI(t)

	// List tasks empty
	recTList := doRequest(t, handler, "GET", "/api/tasks", nil)
	if recTList.Code != http.StatusOK {
		t.Fatalf("tasks list failed: %d", recTList.Code)
	}

	// Create task validation (no instanceId)
	recTCreateBad := doRequest(t, handler, "POST", "/api/tasks", map[string]any{})
	if recTCreateBad.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty task create, got %d", recTCreateBad.Code)
	}

	// Get non-existent task
	recTGetNo := doRequest(t, handler, "GET", "/api/tasks/no-such-task", nil)
	if recTGetNo.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown task get, got %d", recTGetNo.Code)
	}

	// Delete non-existent task
	recTDelNo := doRequest(t, handler, "DELETE", "/api/tasks/no-such-task", nil)
	if recTDelNo.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown task delete, got %d", recTDelNo.Code)
	}

	// History: List
	recHList := doRequest(t, handler, "GET", "/api/history/kokoro_tts", nil)
	if recHList.Code != http.StatusOK {
		t.Fatalf("history list failed: %d", recHList.Code)
	}

	// History: Groups
	recGList := doRequest(t, handler, "GET", "/api/history/kokoro_tts/groups", nil)
	if recGList.Code != http.StatusOK {
		t.Fatalf("history groups list failed: %d", recGList.Code)
	}

	// History: Create Group
	recGCreate := doRequest(t, handler, "POST", "/api/history/kokoro_tts/groups", map[string]any{
		"name": "My Group",
	})
	if recGCreate.Code != http.StatusOK {
		t.Fatalf("history create group failed: %d: %s", recGCreate.Code, recGCreate.Body.String())
	}
	var gData map[string]any
	json.Unmarshal(recGCreate.Body.Bytes(), &gData)
	gid := optString(gData, "id")

	// History: Rename Group via PUT /api/history/{modelId}/groups/{gid}
	recGRename := doRequest(t, handler, "PUT", "/api/history/kokoro_tts/groups/"+gid, map[string]any{
		"name": "My Group Renamed",
	})
	if recGRename.Code != http.StatusOK {
		t.Fatalf("history rename group failed: %d: %s", recGRename.Code, recGRename.Body.String())
	}

	// History: Delete Group via DELETE /api/history/{modelId}/groups/{gid}
	recGDel := doRequest(t, handler, "DELETE", "/api/history/kokoro_tts/groups/"+gid, nil)
	if recGDel.Code != http.StatusOK {
		t.Fatalf("history delete group failed: %d: %s", recGDel.Code, recGDel.Body.String())
	}

	// History: Record and individual operations
	testInst := &Instance{ModelID: "kokoro_tts", Name: "kokoro"}
	if err := hub.history.RecordTTS(testInst, map[string]any{"text": "Hello world"}, "task-tts-1", map[string]any{"durationSec": 1.2}, ""); err != nil {
		t.Fatalf("RecordTTS failed: %v", err)
	}
	wavPath := filepath.Join("data", "history", "kokoro_tts", "task-tts-1.wav")
	refPath := filepath.Join("data", "history", "kokoro_tts", "task-tts-1.ref.wav")
	os.WriteFile(wavPath, minimalWAV(), 0644)
	os.WriteFile(refPath, minimalWAV(), 0644)

	// Get specific history item
	recHGet := doRequest(t, handler, "GET", "/api/history/kokoro_tts/task-tts-1", nil)
	if recHGet.Code != http.StatusOK {
		t.Fatalf("get history item failed: %d", recHGet.Code)
	}

	// Get audio
	recHAudio := doRequest(t, handler, "GET", "/api/history/kokoro_tts/task-tts-1/audio", nil)
	if recHAudio.Code != http.StatusOK {
		t.Fatalf("get history audio failed: %d", recHAudio.Code)
	}

	// Get ref audio
	recHRefAudio := doRequest(t, handler, "GET", "/api/history/kokoro_tts/task-tts-1/audio/ref", nil)
	if recHRefAudio.Code != http.StatusOK {
		t.Fatalf("get history ref audio failed: %d", recHRefAudio.Code)
	}

	// Set record group
	recHSetGrp := doRequest(t, handler, "PUT", "/api/history/kokoro_tts/task-tts-1/group", map[string]any{
		"groupId": "",
	})
	if recHSetGrp.Code != http.StatusOK {
		t.Fatalf("set history group failed: %d", recHSetGrp.Code)
	}

	// Delete specific history item
	recHDel := doRequest(t, handler, "DELETE", "/api/history/kokoro_tts/task-tts-1", nil)
	if recHDel.Code != http.StatusOK {
		t.Fatalf("delete history item failed: %d", recHDel.Code)
	}

	// History: Clear
	recHClear := doRequest(t, handler, "DELETE", "/api/history/kokoro_tts", nil)
	if recHClear.Code != http.StatusOK {
		t.Fatalf("history clear failed: %d", recHClear.Code)
	}

	// History: Get non-existent
	recHGetNo := doRequest(t, handler, "GET", "/api/history/kokoro_tts/no-such-task", nil)
	if recHGetNo.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown history item, got %d", recHGetNo.Code)
	}

	// History: Audio non-existent
	recHAudioNo := doRequest(t, handler, "GET", "/api/history/kokoro_tts/no-such-task/audio", nil)
	if recHAudioNo.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown history audio, got %d", recHAudioNo.Code)
	}

	// Downloads: List
	recDList := doRequest(t, handler, "GET", "/api/downloads", nil)
	if recDList.Code != http.StatusOK {
		t.Fatalf("downloads list failed: %d", recDList.Code)
	}

	// Downloads: Create validation error
	recDCreateBad := doRequest(t, handler, "POST", "/api/downloads", map[string]any{})
	if recDCreateBad.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty download create, got %d", recDCreateBad.Code)
	}

	// Downloads: Get non-existent
	recDGetNo := doRequest(t, handler, "GET", "/api/downloads/no-such-dl", nil)
	if recDGetNo.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown download get, got %d", recDGetNo.Code)
	}

	// Downloads: Delete non-existent
	recDDelNo := doRequest(t, handler, "DELETE", "/api/downloads/no-such-dl", nil)
	if recDDelNo.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown download delete, got %d", recDDelNo.Code)
	}

	// Downloads: Pause non-existent
	recDPauseNo := doRequest(t, handler, "POST", "/api/downloads/no-such-dl/pause", nil)
	if recDPauseNo.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown download pause, got %d", recDPauseNo.Code)
	}

	// Downloads: Resume non-existent
	recDResumeNo := doRequest(t, handler, "POST", "/api/downloads/no-such-dl/resume", nil)
	if recDResumeNo.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown download resume, got %d", recDResumeNo.Code)
	}
}

func TestV1ProxyEndpoints(t *testing.T) {
	hub, handler := newTestHubForAPI(t)

	// Add an instance to instance manager
	inst := &Instance{
		ID:        "inst-ready",
		Name:      "kokoro",
		ModelID:   "kokoro_tts",
		Status:    "READY",
		CreatedAt: "2026-10-28T12:00:00.000Z",
	}
	hub.instances.items["inst-ready"] = inst

	// OPTIONS /v1/models (CORS preflight)
	recOpt := doRequest(t, handler, "OPTIONS", "/v1/models", nil)
	if recOpt.Code != http.StatusNoContent {
		t.Fatalf("expected 204 for OPTIONS /v1/models, got %d", recOpt.Code)
	}
	if recOpt.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Errorf("missing CORS header")
	}

	// GET /v1/models
	recModels := doRequest(t, handler, "GET", "/v1/models", nil)
	if recModels.Code != http.StatusOK {
		t.Fatalf("expected 200 for GET /v1/models, got %d", recModels.Code)
	}
	var resp map[string]any
	json.Unmarshal(recModels.Body.Bytes(), &resp)
	if resp["object"] != "list" {
		t.Errorf("expected object: list, got %v", resp["object"])
	}
	data, ok := resp["data"].([]any)
	if !ok || len(data) != 1 {
		t.Fatalf("expected 1 model entry, got %v", resp["data"])
	}
	first := data[0].(map[string]any)
	if first["id"] != "kokoro" {
		t.Errorf("model id = %v, want kokoro", first["id"])
	}
}
