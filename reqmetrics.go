package main

// Request observability for the /v1/* proxy (#198).
//
// Every POST/PUT that reaches handleV1Proxy gets a RequestRecord: who called (caller IP,
// X-Client tag), which instance served it, how big the input was, how long it queued, when
// the first byte and first audio left the hub, the flush-by-flush chunk timeline of the
// reply and whether the engine had to load the model first. Records live in memory only:
// a ring of the newest requestRingCap per instance plus one hour of latency samples for the
// rolling percentiles. Input text and audio are never stored; only their sizes.

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	requestRingCap      = 100                    // newest requests kept per instance
	clientTagHeader     = "X-Client"             // optional caller tag; hub-only, never forwarded
	clientTagMaxLen     = 64                     // runes kept from X-Client
	requestIDHeader     = "X-Hub-Request-Id"     // set on every recorded /v1 response
	unroutedKey         = "_unrouted"            // ring for requests that matched no READY instance
	chunkCoalesceWindow = 10 * time.Millisecond  // writes closer than this form one chunk
	slowChunkGap        = 100 * time.Millisecond // gaps above this are flagged
	maxChunksPerRequest = 400                    // later writes merge into the last chunk
	errorCaptureBytes   = 512                    // error body prefix kept for the error text
	errorTextMax        = 300                    // runes of error text kept
	sampleWindow        = time.Hour              // percentile sample retention
	maxSamplesPerInst   = 5000
	nearRestartWindow   = 2 * time.Minute // requests this soon after a (re)start are flagged
	loadProbeTimeout    = 250 * time.Millisecond
	inputJSONMeasureCap = 4 << 20 // JSON bodies above this are not parsed for input chars
)

// ChunkMark is one flushed burst of response bytes.
type ChunkMark struct {
	AtMs       int64  `json:"atMs"`                 // offset from request start
	Bytes      int64  `json:"bytes"`                // bytes written in this burst
	GapMs      int64  `json:"gapMs"`                // silence since the previous burst ended
	AudioMs    *int64 `json:"audioMs,omitempty"`    // audio delivered before this burst
	HeadroomMs *int64 `json:"headroomMs,omitempty"` // buffered audio left when it arrived (<0: player ran dry)
	Slow       bool   `json:"slow"`                 // gap > 100 ms
}

// SegmentMark is one engine call of a sentence-chunked stream (metadata only).
type SegmentMark struct {
	Index    int    `json:"index"`
	Chars    int    `json:"chars"`
	EngineMs int64  `json:"engineMs"`
	Status   int    `json:"status"`
	Error    string `json:"error,omitempty"`
}

// RequestRecord is the JSON shape of one /v1 request in the log.
type RequestRecord struct {
	ID                      string        `json:"id"`
	Time                    string        `json:"time"`    // RFC 3339 UTC start time
	StartMs                 int64         `json:"startMs"` // epoch ms
	Instance                string        `json:"instance"`
	InstanceID              string        `json:"instanceId,omitempty"`
	ModelID                 string        `json:"modelId,omitempty"`
	ModelFamily             string        `json:"modelFamily,omitempty"`
	Task                    string        `json:"task,omitempty"` // tts / asr / ...
	Method                  string        `json:"method"`
	Route                   string        `json:"route"`
	CallerIP                string        `json:"callerIp"`
	Client                  string        `json:"client,omitempty"`
	InputBytes              int64         `json:"inputBytes"`
	InputChars              *int          `json:"inputChars,omitempty"`
	InputAudioSec           *float64      `json:"inputAudioSec,omitempty"`
	InFlightAtStart         int           `json:"inFlightAtStart"`
	QueueWaitMs             *int64        `json:"queueWaitMs,omitempty"`
	TTFBMs                  *int64        `json:"ttfbMs,omitempty"`
	FirstAudioMs            *int64        `json:"firstAudioMs,omitempty"`
	TotalMs                 *int64        `json:"totalMs,omitempty"`
	ElapsedMs               int64         `json:"elapsedMs"`
	OutputBytes             int64         `json:"outputBytes"`
	OutputAudioSec          *float64      `json:"outputAudioSec,omitempty"`
	RTF                     *float64      `json:"rtf,omitempty"`
	Status                  int           `json:"status"`
	Error                   string        `json:"error,omitempty"`
	Streamed                bool          `json:"streamed"`        // stream requested, SSE, or hub sentence-chunked
	ChunkedTransfer         bool          `json:"chunkedTransfer"` // reply had no Content-Length
	StreamMode              string        `json:"streamMode,omitempty"`
	InFlight                bool          `json:"inFlight"`
	ClientAborted           bool          `json:"clientAborted"`
	ColdLoad                *bool         `json:"coldLoad,omitempty"`
	ColdLoadSource          string        `json:"coldLoadSource,omitempty"` // engine / inferred / queued
	HubUptimeMsAtStart      int64         `json:"hubUptimeMsAtStart"`
	InstanceUptimeMsAtStart *int64        `json:"instanceUptimeMsAtStart,omitempty"`
	NearRestart             bool          `json:"nearRestart"`
	RestartReason           string        `json:"restartReason,omitempty"` // hub / instance-start / instance-replaced
	ChunkCount              int           `json:"chunkCount"`
	GapsOver100ms           int           `json:"gapsOver100ms"`
	MaxGapMs                int64         `json:"maxGapMs"`
	MinHeadroomMs           *int64        `json:"minHeadroomMs,omitempty"`
	Underrun                bool          `json:"underrun"`
	Chunks                  []ChunkMark   `json:"chunks,omitempty"`
	Segments                []SegmentMark `json:"segments,omitempty"`
}

// RequestMetrics holds the request log, per-instance load/flight state and latency samples.
type RequestMetrics struct {
	mu       sync.Mutex
	hubStart time.Time
	now      func() time.Time
	// probe asks the engine whether the instance's model is resident; ok=false when unknown.
	probe func(inst *Instance) (loaded, ok bool)
	seq   uint64
	rings map[string][]*reqState // newest last; key = instance name or unroutedKey
	insts map[string]*instTrack  // key = instance name
}

type instTrack struct {
	inflight       map[*reqState]struct{}
	lastEnd        time.Time
	lastColdLoadAt time.Time
	lastInstanceID string
	samples        []latSample
}

type latSample struct {
	at           time.Time
	ok           bool
	cold         bool
	underrun     bool
	firstAudioMs int64 // -1 when unknown
	totalMs      int64
	rtf          float64 // -1 when unknown
}

// NewRequestMetrics starts an empty log; hubStart marks the hub's start for restart flags.
func NewRequestMetrics(hubStart time.Time) *RequestMetrics {
	m := &RequestMetrics{
		hubStart: hubStart,
		now:      time.Now,
		rings:    map[string][]*reqState{},
		insts:    map[string]*instTrack{},
	}
	m.probe = httpLoadProbe
	return m
}

func (m *RequestMetrics) track(name string) *instTrack {
	t := m.insts[name]
	if t == nil {
		t = &instTrack{inflight: map[*reqState]struct{}{}}
		m.insts[name] = t
	}
	return t
}

// reqState is the live, mutable side of a record; all fields are guarded by m.mu.
type reqState struct {
	m   *RequestMetrics
	rec RequestRecord
	r   *http.Request

	start      time.Time
	inst       *Instance
	ringKey    string
	ahead      []*reqState
	end        time.Time
	finished   bool
	headerAt   time.Time
	firstByte  time.Time
	firstAudio time.Time
	lastWrite  time.Time
	cold       bool

	contentType     string
	bytesPerSec     int   // audio byte rate of the reply, 0 when unknown
	byteAudio       bool  // audio counted from body bytes (wav/pcm)
	dataOffset      int64 // body offset where audio starts (-1 until known)
	prefix          []byte
	audioBytes      int64
	nonPCMAudio     bool // audio/* we cannot measure (mp3, opus...)
	errBuf          []byte
	explicitErr     string
	streamRequested bool
	contentLength   int64 // declared reply length, -1 when chunked/unknown
	writeFailed     bool  // a write to the client returned an error
}

// Begin opens a record for an incoming /v1 request. route is the request path.
func (m *RequestMetrics) Begin(r *http.Request, route string) *reqState {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	m.seq++
	s := &reqState{m: m, r: r, start: now, dataOffset: -1, contentLength: -1}
	s.rec = RequestRecord{
		ID:                 fmt.Sprintf("%x-%d", m.hubStart.Unix()&0xffffff, m.seq),
		Time:               now.UTC().Format("2006-01-02T15:04:05.000Z"),
		StartMs:            now.UnixMilli(),
		Method:             r.Method,
		Route:              route,
		CallerIP:           callerIP(r),
		Client:             sanitizeClientTag(r.Header.Get(clientTagHeader)),
		InFlight:           true,
		HubUptimeMsAtStart: now.Sub(m.hubStart).Milliseconds(),
		Task:               taskForRoute(route),
	}
	return s
}

// ID is the request id echoed in X-Hub-Request-Id.
func (s *reqState) ID() string {
	if s == nil {
		return ""
	}
	return s.rec.ID
}

// SetRequestedModel names an unrouted request after the model it asked for.
func (s *reqState) SetRequestedModel(model string) {
	if s == nil {
		return
	}
	s.m.mu.Lock()
	s.rec.Instance = sanitizeClientTag(model)
	s.m.mu.Unlock()
}

// SetInstance binds the request to the instance that will serve it, decides whether it
// will hit a cold model load and inserts it (in flight) into that instance's ring.
func (s *reqState) SetInstance(inst *Instance) {
	if s == nil || inst == nil {
		return
	}
	m := s.m
	m.mu.Lock()
	busy := len(m.track(inst.Name).inflight) > 0
	m.mu.Unlock()
	var loaded, probed bool
	if !busy && m.probe != nil {
		loaded, probed = m.probe(inst)
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	t := m.track(inst.Name)
	s.inst = inst
	s.rec.Instance = inst.Name
	s.rec.InstanceID = inst.ID
	s.rec.ModelID = inst.ModelID
	s.rec.ModelFamily = inst.EngineFamily
	if s.rec.ModelFamily == "" {
		s.rec.ModelFamily = inst.ModelID
	}
	if inst.ServerTask != "" {
		s.rec.Task = inst.ServerTask
	}
	for o := range t.inflight {
		s.ahead = append(s.ahead, o)
	}
	s.rec.InFlightAtStart = len(s.ahead)
	switch {
	case len(s.ahead) > 0:
		s.setCold(false, "queued")
	case probed:
		s.setCold(!loaded, "engine")
	case !t.lastEnd.IsZero() && inst.IdleUnloadMs != nil:
		s.setCold(s.start.Sub(t.lastEnd) > time.Duration(*inst.IdleUnloadMs)*time.Millisecond, "inferred")
	case !t.lastEnd.IsZero():
		s.setCold(false, "inferred")
	}

	if created, err := time.Parse("2006-01-02T15:04:05.000Z", inst.CreatedAt); err == nil {
		up := s.start.Sub(created).Milliseconds()
		s.rec.InstanceUptimeMsAtStart = &up
		if up < nearRestartWindow.Milliseconds() && s.rec.RestartReason == "" {
			s.rec.RestartReason = "instance-start"
		}
	}
	if s.rec.HubUptimeMsAtStart < nearRestartWindow.Milliseconds() {
		s.rec.RestartReason = "hub"
	} else if t.lastInstanceID != "" && t.lastInstanceID != inst.ID && s.rec.RestartReason == "" {
		s.rec.RestartReason = "instance-replaced"
	}
	s.rec.NearRestart = s.rec.RestartReason != ""
	t.lastInstanceID = inst.ID

	t.inflight[s] = struct{}{}
	s.ringKey = inst.Name
	m.pushLocked(s)
}

func (s *reqState) setCold(cold bool, source string) {
	s.cold = cold
	v := cold
	s.rec.ColdLoad = &v
	s.rec.ColdLoadSource = source
}

func (m *RequestMetrics) pushLocked(s *reqState) {
	ring := append(m.rings[s.ringKey], s)
	if len(ring) > requestRingCap {
		ring = append([]*reqState(nil), ring[len(ring)-requestRingCap:]...)
	}
	m.rings[s.ringKey] = ring
}

// MeasureInput records the request size: characters of "input" for JSON bodies and audio
// seconds of the uploaded WAV for multipart bodies. The content itself is never kept.
func (s *reqState) MeasureInput(path, contentType string, n int64) {
	if s == nil {
		return
	}
	var chars *int
	var secs *float64
	stream := false
	if isMultipartForm(contentType) {
		secs = multipartWAVSeconds(path, contentType)
	} else if n <= inputJSONMeasureCap {
		chars, stream = jsonInputChars(path)
	}
	s.m.mu.Lock()
	s.streamRequested = stream
	s.rec.InputBytes = n
	s.rec.InputChars = chars
	s.rec.InputAudioSec = secs
	s.m.mu.Unlock()
}

// AddAudioBytes counts PCM bytes the hub encoded into a non-audio wire format (SSE).
func (s *reqState) AddAudioBytes(n int) {
	if s == nil || n <= 0 {
		return
	}
	s.m.mu.Lock()
	defer s.m.mu.Unlock()
	if s.firstAudio.IsZero() {
		s.firstAudio = s.lastWrite
		if len(s.rec.Chunks) > 0 {
			s.firstAudio = s.start.Add(time.Duration(s.rec.Chunks[len(s.rec.Chunks)-1].AtMs) * time.Millisecond)
		}
	}
	s.audioBytes += int64(n)
}

// AddSegment notes one engine call of a sentence-chunked stream.
func (s *reqState) AddSegment(chars int, engine time.Duration, status int, errMsg string) {
	if s == nil {
		return
	}
	s.m.mu.Lock()
	defer s.m.mu.Unlock()
	if len(s.rec.Segments) >= maxChunksPerRequest {
		return
	}
	s.rec.Segments = append(s.rec.Segments, SegmentMark{Index: len(s.rec.Segments), Chars: chars,
		EngineMs: engine.Milliseconds(), Status: status, Error: truncateRunes(errMsg, errorTextMax)})
}

// SetError records an error that happened after the status line was sent (mid-stream).
func (s *reqState) SetError(msg string) {
	if s == nil {
		return
	}
	s.m.mu.Lock()
	s.explicitErr = truncateRunes(msg, errorTextMax)
	s.m.mu.Unlock()
}

// Wrap returns a ResponseWriter that meters status, timing and bytes into the record.
func (s *reqState) Wrap(w http.ResponseWriter) http.ResponseWriter {
	if s == nil {
		return w
	}
	return &meterWriter{ResponseWriter: w, s: s}
}

type meterWriter struct {
	http.ResponseWriter
	s           *reqState
	wroteHeader bool
}

func (mw *meterWriter) WriteHeader(code int) {
	if mw.wroteHeader {
		mw.ResponseWriter.WriteHeader(code)
		return
	}
	mw.wroteHeader = true
	mw.s.onHeader(code, mw.ResponseWriter.Header())
	mw.ResponseWriter.WriteHeader(code)
}

func (mw *meterWriter) Write(b []byte) (int, error) {
	if !mw.wroteHeader {
		mw.WriteHeader(http.StatusOK)
	}
	n, err := mw.ResponseWriter.Write(b)
	if n > 0 {
		mw.s.onWrite(b[:n])
	}
	if err != nil {
		mw.s.onWriteError()
	}
	return n, err
}

func (mw *meterWriter) Flush() {
	if f, ok := mw.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (mw *meterWriter) Unwrap() http.ResponseWriter { return mw.ResponseWriter }

func (s *reqState) onHeader(code int, h http.Header) {
	m := s.m
	m.mu.Lock()
	defer m.mu.Unlock()
	s.headerAt = m.now()
	s.rec.Status = code
	s.rec.StreamMode = h.Get("X-Hub-Stream")
	s.rec.ChunkedTransfer = code < 400 && h.Get("Content-Length") == ""
	if cl, err := strconv.ParseInt(h.Get("Content-Length"), 10, 64); err == nil && cl >= 0 {
		s.contentLength = cl
	}
	ct := strings.ToLower(h.Get("Content-Type"))
	s.contentType = ct
	mt, _, _ := mime.ParseMediaType(ct)
	if code < 400 && (s.streamRequested || s.rec.StreamMode != "" || mt == "text/event-stream") {
		s.rec.Streamed = true
	}
	if code >= 400 {
		return
	}
	headerRate := audioHeaderRate(h)
	switch {
	case mt == "audio/wav" || mt == "audio/x-wav" || mt == "audio/wave":
		s.byteAudio = true
	case mt == "audio/pcm" || mt == "audio/l16":
		s.byteAudio = headerRate > 0
		s.bytesPerSec = headerRate
		s.dataOffset = 0
	case mt == "text/event-stream":
		s.bytesPerSec = headerRate // audio arrives via AddAudioBytes
	case strings.HasPrefix(mt, "audio/"):
		s.nonPCMAudio = true
	}
}

func (s *reqState) onWriteError() {
	s.m.mu.Lock()
	s.writeFailed = true
	s.m.mu.Unlock()
}

// clientAbortedLocked: the client went away before receiving the whole reply.
// A cancelled context alone is not enough: net/http cancels it when a client
// hangs up right after reading a complete Content-Length body.
func (s *reqState) clientAbortedLocked() bool {
	if s.writeFailed {
		return true
	}
	if s.r == nil || s.r.Context().Err() == nil {
		return false
	}
	delivered := s.contentLength >= 0 && s.rec.OutputBytes >= s.contentLength
	return !delivered
}

func (s *reqState) onWrite(b []byte) {
	m := s.m
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	n := int64(len(b))
	before := s.audioBytes
	if s.rec.Status >= 400 && len(s.errBuf) < errorCaptureBytes {
		s.errBuf = append(s.errBuf, b[:min(len(b), errorCaptureBytes-len(s.errBuf))]...)
	}
	if s.byteAudio {
		s.countAudioBytes(b)
	}
	if s.firstByte.IsZero() {
		s.firstByte = now
		if s.nonPCMAudio {
			s.firstAudio = now
		}
	}
	if s.firstAudio.IsZero() && s.audioBytes > 0 {
		s.firstAudio = now
	}
	s.rec.OutputBytes += n

	at := now.Sub(s.start).Milliseconds()
	if len(s.rec.Chunks) > 0 && now.Sub(s.lastWrite) <= chunkCoalesceWindow {
		s.rec.Chunks[len(s.rec.Chunks)-1].Bytes += n
	} else {
		gap := int64(0)
		if !s.lastWrite.IsZero() {
			gap = now.Sub(s.lastWrite).Milliseconds()
		}
		s.rec.ChunkCount++
		slow := gap > slowChunkGap.Milliseconds()
		if slow {
			s.rec.GapsOver100ms++
		}
		s.rec.MaxGapMs = max(s.rec.MaxGapMs, gap)
		mark := ChunkMark{AtMs: at, Bytes: n, GapMs: gap, Slow: slow}
		if s.bytesPerSec > 0 && !s.firstAudio.IsZero() && before > 0 {
			audioMs := before * 1000 / int64(s.bytesPerSec)
			head := audioMs - now.Sub(s.firstAudio).Milliseconds()
			mark.AudioMs, mark.HeadroomMs = &audioMs, &head
			if s.rec.MinHeadroomMs == nil || head < *s.rec.MinHeadroomMs {
				s.rec.MinHeadroomMs = &head
			}
			if head < 0 {
				s.rec.Underrun = true
			}
		}
		if len(s.rec.Chunks) < maxChunksPerRequest {
			s.rec.Chunks = append(s.rec.Chunks, mark)
		} else {
			s.rec.Chunks[len(s.rec.Chunks)-1].Bytes += n
		}
	}
	s.lastWrite = now
}

// countAudioBytes advances the audio byte count of a WAV/PCM body (caller holds m.mu).
func (s *reqState) countAudioBytes(b []byte) {
	pos := s.rec.OutputBytes // body offset of b[0]
	if s.dataOffset < 0 {
		if len(s.prefix) < 4096 {
			s.prefix = append(s.prefix, b[:min(len(b), 4096-len(s.prefix))]...)
		}
		bps, off, _, ok, more := parseWAVPrefix(s.prefix)
		if !ok {
			if !more || len(s.prefix) >= 4096 {
				s.byteAudio = false
				s.prefix = nil
			}
			return
		}
		s.bytesPerSec, s.dataOffset, s.prefix = bps, int64(off), nil
	}
	end := pos + int64(len(b))
	if end > s.dataOffset {
		s.audioBytes += end - max(pos, s.dataOffset)
	}
}

// Finish closes the record: derived timings, queue wait, samples, cold-load bookkeeping.
func (s *reqState) Finish() {
	if s == nil {
		return
	}
	m := s.m
	m.mu.Lock()
	defer m.mu.Unlock()
	if s.finished {
		return
	}
	s.finished = true
	now := m.now()
	s.end = now
	s.rec.InFlight = false
	s.rec.ClientAborted = s.clientAbortedLocked()
	if s.rec.Status == 0 && s.headerAt.IsZero() {
		if s.rec.ClientAborted {
			s.rec.Status = 499 // client closed before the hub answered
		} else {
			s.rec.Status = http.StatusOK
		}
	}
	s.fillDerived(now)
	if s.rec.Status >= 400 && s.rec.Error == "" {
		s.rec.Error = errorTextFromBody(s.errBuf)
	}
	if s.explicitErr != "" {
		s.rec.Error = s.explicitErr
	}
	s.errBuf = nil

	if s.inst == nil {
		if s.rec.Instance == "" {
			s.rec.Instance = "(none)"
		}
		s.ringKey = unroutedKey
		m.pushLocked(s)
		return
	}
	t := m.track(s.inst.Name)
	delete(t.inflight, s)
	t.lastEnd = now
	ok := s.rec.Status < 400 && !s.rec.ClientAborted
	if s.cold && !s.firstByte.IsZero() {
		t.lastColdLoadAt = s.firstByte
	}
	sm := latSample{at: s.start, ok: ok, cold: s.cold, underrun: s.rec.Underrun, firstAudioMs: -1, rtf: -1}
	if s.rec.TotalMs != nil {
		sm.totalMs = *s.rec.TotalMs
	}
	if s.rec.FirstAudioMs != nil {
		sm.firstAudioMs = *s.rec.FirstAudioMs
	} else if s.rec.TTFBMs != nil {
		sm.firstAudioMs = *s.rec.TTFBMs
	}
	if s.rec.RTF != nil {
		sm.rtf = *s.rec.RTF
	}
	t.samples = pruneSamples(append(t.samples, sm), now)
	s.ahead = nil
	s.r = nil
}

// fillDerived computes the reported timings from the raw times (caller holds m.mu).
func (s *reqState) fillDerived(now time.Time) {
	ms := func(t time.Time) *int64 {
		if t.IsZero() {
			return nil
		}
		v := t.Sub(s.start).Milliseconds()
		return &v
	}
	s.rec.ElapsedMs = now.Sub(s.start).Milliseconds()
	s.rec.TTFBMs = ms(s.firstByte)
	if s.rec.TTFBMs == nil && !s.end.IsZero() {
		s.rec.TTFBMs = ms(s.headerAt)
	}
	s.rec.FirstAudioMs = ms(s.firstAudio)
	if !s.end.IsZero() {
		s.rec.TotalMs = ms(s.end)
	}
	if s.bytesPerSec > 0 && s.audioBytes > 0 {
		sec := round3(float64(s.audioBytes) / float64(s.bytesPerSec))
		s.rec.OutputAudioSec = &sec
	}
	if s.rec.TotalMs != nil && s.rec.Status < 400 {
		total := float64(*s.rec.TotalMs) / 1000
		switch {
		case s.rec.OutputAudioSec != nil && *s.rec.OutputAudioSec > 0:
			r := round3(total / *s.rec.OutputAudioSec)
			s.rec.RTF = &r
		case s.rec.InputAudioSec != nil && *s.rec.InputAudioSec > 0:
			r := round3(total / *s.rec.InputAudioSec)
			s.rec.RTF = &r
		}
	}
	// Queue wait: until every request already in flight for this instance finished,
	// never longer than our own time to first byte.
	if s.inst != nil {
		var wait int64
		for _, o := range s.ahead {
			if !o.end.IsZero() {
				wait = max(wait, o.end.Sub(s.start).Milliseconds())
			} else {
				wait = max(wait, now.Sub(s.start).Milliseconds())
			}
		}
		if s.rec.TTFBMs != nil {
			wait = min(wait, *s.rec.TTFBMs)
		}
		wait = max(wait, 0)
		s.rec.QueueWaitMs = &wait
	}
}

func (s *reqState) snapshot(now time.Time, withChunks bool) RequestRecord {
	if !s.finished {
		s.fillDerived(now)
	}
	out := s.rec
	if withChunks {
		out.Chunks = append([]ChunkMark(nil), s.rec.Chunks...)
	} else {
		out.Chunks = nil
	}
	out.Segments = append([]SegmentMark(nil), s.rec.Segments...)
	return out
}

// Recent returns up to limit records, newest first. instance filters by instance name
// ("_unrouted" for requests that matched no instance); empty means all instances.
func (m *RequestMetrics) Recent(instance string, limit int, withChunks bool) []RequestRecord {
	if m == nil {
		return []RequestRecord{}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	var all []*reqState
	for key, ring := range m.rings {
		if instance == "" || key == instance {
			all = append(all, ring...)
		}
	}
	sort.SliceStable(all, func(i, j int) bool {
		if !all[i].start.Equal(all[j].start) {
			return all[i].start.After(all[j].start)
		}
		return all[i].rec.ID > all[j].rec.ID
	})
	if limit > 0 && len(all) > limit {
		all = all[:limit]
	}
	out := make([]RequestRecord, 0, len(all))
	for _, s := range all {
		out = append(out, s.snapshot(now, withChunks))
	}
	return out
}

// Lookup returns one record (with its chunk timeline) by id.
func (m *RequestMetrics) Lookup(id string) (RequestRecord, bool) {
	if m == nil {
		return RequestRecord{}, false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, ring := range m.rings {
		for _, s := range ring {
			if s.rec.ID == id {
				return s.snapshot(m.now(), true), true
			}
		}
	}
	return RequestRecord{}, false
}

type instSnap struct {
	inFlight       int
	lastEnd        time.Time
	lastColdLoadAt time.Time
	coldInFlight   bool
	samples        []latSample
}

func (m *RequestMetrics) instanceSnapshot(name string) instSnap {
	m.mu.Lock()
	defer m.mu.Unlock()
	t := m.insts[name]
	if t == nil {
		return instSnap{}
	}
	out := instSnap{inFlight: len(t.inflight), lastEnd: t.lastEnd, lastColdLoadAt: t.lastColdLoadAt}
	for s := range t.inflight {
		if s.cold && s.firstByte.IsZero() {
			out.coldInFlight = true
		}
	}
	out.samples = append([]latSample(nil), pruneSamples(t.samples, m.now())...)
	t.samples = pruneSamples(t.samples, m.now())
	return out
}

// WindowStats summarises one rolling window of an instance's requests.
type WindowStats struct {
	Count           int      `json:"count"`
	Errors          int      `json:"errors"`
	ColdLoads       int      `json:"coldLoads"`
	Underruns       int      `json:"underruns"`
	FirstAudioP50Ms *int64   `json:"firstAudioP50Ms,omitempty"`
	FirstAudioP90Ms *int64   `json:"firstAudioP90Ms,omitempty"`
	TotalP50Ms      *int64   `json:"totalP50Ms,omitempty"`
	TotalP90Ms      *int64   `json:"totalP90Ms,omitempty"`
	RTFP50          *float64 `json:"rtfP50,omitempty"`
}

// InstanceStatus is one status card of /api/metrics/summary.
type InstanceStatus struct {
	Instance       string                 `json:"instance"`
	InstanceID     string                 `json:"instanceId,omitempty"`
	ModelID        string                 `json:"modelId,omitempty"`
	ModelFamily    string                 `json:"modelFamily,omitempty"`
	Task           string                 `json:"task,omitempty"`
	HubStatus      string                 `json:"hubStatus"` // READY / STARTING / GONE
	State          string                 `json:"state"`     // loaded / cold / loading / starting / unknown / gone
	StateSource    string                 `json:"stateSource,omitempty"`
	Backend        string                 `json:"backend,omitempty"`
	Device         string                 `json:"device,omitempty"` // backend:index, e.g. vulkan:1
	Port           int                    `json:"port,omitempty"`
	StartedAt      int64                  `json:"startedAt,omitempty"`
	InFlight       int                    `json:"inFlight"`
	QueueDepth     int                    `json:"queueDepth"`
	TasksActive    int                    `json:"tasksActive"`
	LastUseAt      int64                  `json:"lastUseAt,omitempty"`
	SinceLastUseMs *int64                 `json:"sinceLastUseMs,omitempty"`
	IdleUnloadMs   *int                   `json:"idleUnloadMs,omitempty"`
	UnloadInMs     *int64                 `json:"unloadInMs,omitempty"`
	LastColdLoadAt int64                  `json:"lastColdLoadAt,omitempty"`
	Memory         map[string]any         `json:"memory,omitempty"`
	Windows        map[string]WindowStats `json:"windows"`
}

// MetricsSummary is the /api/metrics/summary response.
type MetricsSummary struct {
	Now          int64            `json:"now"`
	HubStartedAt int64            `json:"hubStartedAt"`
	HubUptimeMs  int64            `json:"hubUptimeMs"`
	Instances    []InstanceStatus `json:"instances"`
}

var summaryWindows = []struct {
	key string
	d   time.Duration
}{{"15m", 15 * time.Minute}, {"1h", time.Hour}}

// Summary builds status cards for the given live instances plus any instance that has
// requests in the log but is no longer running. Engine probes run in parallel.
func (m *RequestMetrics) Summary(live []*Instance, statusOf func(*Instance) string) MetricsSummary {
	now := m.now()
	statuses := make([]string, len(live))
	for i, inst := range live {
		statuses[i] = statusOf(inst)
	}
	out := MetricsSummary{Now: now.UnixMilli(), HubStartedAt: m.hubStart.UnixMilli(),
		HubUptimeMs: now.Sub(m.hubStart).Milliseconds(), Instances: []InstanceStatus{}}
	type probeRes struct{ loaded, ok bool }
	probes := make([]probeRes, len(live))
	var wg sync.WaitGroup
	for i, inst := range live {
		if statuses[i] != "READY" || m.probe == nil {
			continue
		}
		wg.Add(1)
		go func(i int, inst *Instance) {
			defer wg.Done()
			l, ok := m.probe(inst)
			probes[i] = probeRes{l, ok}
		}(i, inst)
	}
	wg.Wait()

	seen := map[string]bool{}
	for i, inst := range live {
		seen[inst.Name] = true
		snap := m.instanceSnapshot(inst.Name)
		st := InstanceStatus{Instance: inst.Name, InstanceID: inst.ID, ModelID: inst.ModelID,
			ModelFamily: inst.EngineFamily, Task: inst.ServerTask, HubStatus: statuses[i],
			Backend: inst.Backend, Port: inst.Port, IdleUnloadMs: inst.IdleUnloadMs}
		if st.ModelFamily == "" {
			st.ModelFamily = inst.ModelID
		}
		if inst.Device != nil {
			st.Device = fmt.Sprintf("%s:%d", inst.Backend, *inst.Device)
		} else if inst.Backend != "" {
			st.Device = inst.Backend
		}
		if created, err := time.Parse("2006-01-02T15:04:05.000Z", inst.CreatedAt); err == nil {
			st.StartedAt = created.UnixMilli()
		}
		m.fillStatus(&st, snap, now)
		p := probes[i]
		switch {
		case statuses[i] != "READY":
			st.State, st.StateSource = "starting", "hub"
		case p.ok && p.loaded:
			st.State, st.StateSource = "loaded", "engine"
		case p.ok && snap.inFlight > 0:
			st.State, st.StateSource = "loading", "engine"
		case p.ok:
			st.State, st.StateSource = "cold", "engine"
		case snap.coldInFlight:
			st.State, st.StateSource = "loading", "inferred"
		case snap.lastEnd.IsZero():
			st.State = "unknown"
		case inst.IdleUnloadMs != nil && now.Sub(snap.lastEnd) > time.Duration(*inst.IdleUnloadMs)*time.Millisecond:
			st.State, st.StateSource = "cold", "inferred"
		default:
			st.State, st.StateSource = "loaded", "inferred"
		}
		if st.State == "loaded" && snap.inFlight == 0 && inst.IdleUnloadMs != nil && !snap.lastEnd.IsZero() {
			left := int64(*inst.IdleUnloadMs) - now.Sub(snap.lastEnd).Milliseconds()
			left = max(left, 0)
			st.UnloadInMs = &left
		}
		out.Instances = append(out.Instances, st)
	}

	m.mu.Lock()
	var gone []string
	for name := range m.rings {
		if name != unroutedKey && !seen[name] {
			gone = append(gone, name)
		}
	}
	m.mu.Unlock()
	sort.Strings(gone)
	for _, name := range gone {
		st := InstanceStatus{Instance: name, HubStatus: "GONE", State: "gone"}
		m.fillStatus(&st, m.instanceSnapshot(name), now)
		out.Instances = append(out.Instances, st)
	}
	return out
}

func (m *RequestMetrics) fillStatus(st *InstanceStatus, snap instSnap, now time.Time) {
	st.InFlight = snap.inFlight
	st.QueueDepth = max(snap.inFlight-1, 0)
	if !snap.lastEnd.IsZero() {
		st.LastUseAt = snap.lastEnd.UnixMilli()
		since := now.Sub(snap.lastEnd).Milliseconds()
		st.SinceLastUseMs = &since
	}
	if snap.inFlight > 0 {
		st.LastUseAt = now.UnixMilli()
		zero := int64(0)
		st.SinceLastUseMs = &zero
	}
	if !snap.lastColdLoadAt.IsZero() {
		st.LastColdLoadAt = snap.lastColdLoadAt.UnixMilli()
	}
	st.Windows = map[string]WindowStats{}
	for _, w := range summaryWindows {
		st.Windows[w.key] = windowStats(snap.samples, now.Add(-w.d))
	}
}

func windowStats(samples []latSample, since time.Time) WindowStats {
	var ws WindowStats
	var first, total []int64
	var rtf []float64
	for _, s := range samples {
		if s.at.Before(since) {
			continue
		}
		ws.Count++
		if !s.ok {
			ws.Errors++
		}
		if s.cold {
			ws.ColdLoads++
		}
		if s.underrun {
			ws.Underruns++
		}
		if !s.ok {
			continue
		}
		total = append(total, s.totalMs)
		if s.firstAudioMs >= 0 {
			first = append(first, s.firstAudioMs)
		}
		if s.rtf >= 0 {
			rtf = append(rtf, s.rtf)
		}
	}
	p := func(v []int64, q float64) *int64 {
		if len(v) == 0 {
			return nil
		}
		r := rankPercentile(v, q)
		return &r
	}
	ws.FirstAudioP50Ms, ws.FirstAudioP90Ms = p(first, 0.5), p(first, 0.9)
	ws.TotalP50Ms, ws.TotalP90Ms = p(total, 0.5), p(total, 0.9)
	if len(rtf) > 0 {
		sort.Float64s(rtf)
		r := rtf[nearestRank(len(rtf), 0.5)]
		ws.RTFP50 = &r
	}
	return ws
}

// rankPercentile is the nearest-rank percentile (q in (0,1]) of v; v is not modified.
func rankPercentile(v []int64, q float64) int64 {
	s := append([]int64(nil), v...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	return s[nearestRank(len(s), q)]
}

func nearestRank(n int, q float64) int {
	i := int(math.Ceil(q*float64(n))) - 1
	return min(max(i, 0), n-1)
}

func pruneSamples(s []latSample, now time.Time) []latSample {
	cut := 0
	for cut < len(s) && now.Sub(s[cut].at) > sampleWindow {
		cut++
	}
	if over := len(s) - cut - maxSamplesPerInst; over > 0 {
		cut += over
	}
	if cut == 0 {
		return s
	}
	return append([]latSample(nil), s[cut:]...)
}

// --- helpers ---

type reqStateKey struct{}

// withRequestRecorder / requestRecorderFrom carry the recorder to the chunked-stream code.
func withRequestRecorder(r *http.Request, s *reqState) *http.Request {
	if s == nil {
		return r
	}
	return r.WithContext(context.WithValue(r.Context(), reqStateKey{}, s))
}

func requestRecorderFrom(ctx context.Context) *reqState {
	s, _ := ctx.Value(reqStateKey{}).(*reqState)
	return s
}

// sanitizeClientTag keeps [A-Za-z0-9._:@/+=-], replaces every other rune with "_",
// trims surrounding spaces and caps the result at clientTagMaxLen runes.
func sanitizeClientTag(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	var b strings.Builder
	n := 0
	for _, r := range v {
		if n >= clientTagMaxLen {
			break
		}
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			strings.ContainsRune("._:@/+=-", r):
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
		n++
	}
	return b.String()
}

// callerIP is the peer address, or the first valid X-Forwarded-For entry when the peer is
// loopback (a local reverse proxy). Remote peers cannot spoof their address with the header.
func callerIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	if ip != nil && ip.IsLoopback() {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			first := strings.TrimSpace(strings.Split(xff, ",")[0])
			if fip := net.ParseIP(first); fip != nil {
				return fip.String()
			}
		}
	}
	if ip != nil {
		return ip.String()
	}
	return host
}

func taskForRoute(route string) string {
	switch {
	case strings.HasPrefix(route, "/v1/audio/speech"):
		return "tts"
	case strings.HasPrefix(route, "/v1/audio/transcriptions"), strings.HasPrefix(route, "/v1/audio/translations"):
		return "asr"
	}
	return ""
}

func audioHeaderRate(h http.Header) int {
	rate, _ := strconv.Atoi(h.Get("X-Audio-Sample-Rate"))
	ch, _ := strconv.Atoi(h.Get("X-Audio-Channels"))
	bits, _ := strconv.Atoi(h.Get("X-Audio-Bits-Per-Sample"))
	if rate <= 0 || ch <= 0 || bits <= 0 {
		return 0
	}
	return rate * ch * bits / 8
}

// parseWAVPrefix finds the fmt and data chunks in the first bytes of a RIFF/WAVE stream.
// more reports that the prefix is a valid start but too short to decide.
func parseWAVPrefix(b []byte) (bytesPerSec, dataOffset int, dataSize uint32, ok, more bool) {
	if len(b) < 12 {
		return 0, 0, 0, false, len(b) == 0 || strings.HasPrefix("RIFF", string(b[:min(len(b), 4)]))
	}
	if string(b[:4]) != "RIFF" || string(b[8:12]) != "WAVE" {
		return 0, 0, 0, false, false
	}
	off := 12
	for {
		if off+8 > len(b) {
			return 0, 0, 0, false, true
		}
		id := string(b[off : off+4])
		size := int(binary.LittleEndian.Uint32(b[off+4 : off+8]))
		switch id {
		case "fmt ":
			if off+8+16 > len(b) {
				return 0, 0, 0, false, true
			}
			f := b[off+8:]
			ch := int(binary.LittleEndian.Uint16(f[2:4]))
			rate := int(binary.LittleEndian.Uint32(f[4:8]))
			bits := int(binary.LittleEndian.Uint16(f[14:16]))
			bytesPerSec = rate * ch * bits / 8
		case "data":
			if bytesPerSec <= 0 {
				return 0, 0, 0, false, false
			}
			return bytesPerSec, off + 8, uint32(size), true, false
		}
		if size < 0 || size > 1<<30 {
			return 0, 0, 0, false, false
		}
		off += 8 + size + size%2
	}
}

// jsonInputChars counts the runes of the top-level "input" string of a JSON body and
// reports whether the body asked for a streamed reply ("stream": true).
func jsonInputChars(path string) (*int, bool) {
	f, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	var body struct {
		Input  *string `json:"input"`
		Stream any     `json:"stream"`
	}
	if json.NewDecoder(bufio.NewReader(f)).Decode(&body) != nil {
		return nil, false
	}
	stream := body.Stream == true || body.Stream == "true"
	if body.Input == nil {
		return nil, stream
	}
	n := utf8.RuneCountInString(*body.Input)
	return &n, stream
}

// multipartWAVSeconds measures the first uploaded file of a multipart body when it is a WAV.
func multipartWAVSeconds(path, contentType string) *float64 {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil || params["boundary"] == "" {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	mr := multipart.NewReader(bufio.NewReader(f), params["boundary"])
	for {
		part, err := mr.NextPart()
		if err != nil {
			return nil
		}
		if part.FileName() == "" {
			part.Close()
			continue
		}
		head := make([]byte, 4096)
		n, _ := io.ReadFull(part, head)
		rest, _ := io.Copy(io.Discard, part)
		part.Close()
		bps, off, size, ok, _ := parseWAVPrefix(head[:n])
		if !ok {
			return nil
		}
		data := int64(n) + rest - int64(off)
		if size != 0xFFFFFFFF && int64(size) < data {
			data = int64(size)
		}
		sec := round3(float64(max(data, 0)) / float64(bps))
		return &sec
	}
}

func errorTextFromBody(b []byte) string {
	var e struct {
		Error any `json:"error"`
	}
	if json.Unmarshal(b, &e) == nil {
		switch v := e.Error.(type) {
		case map[string]any:
			if msg, ok := v["message"].(string); ok {
				return truncateRunes(msg, errorTextMax)
			}
		case string:
			return truncateRunes(v, errorTextMax)
		}
	}
	return truncateRunes(strings.TrimSpace(strings.ToValidUTF8(string(b), "")), errorTextMax)
}

// httpLoadProbe asks the engine's GET /v1/models whether the model is resident. It reads
// state only; the engine's idle-unload clock counts model runs, not this call.
func httpLoadProbe(inst *Instance) (loaded, ok bool) {
	if inst == nil || inst.Port <= 0 {
		return false, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), loadProbeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/v1/models", inst.Port), nil)
	if err != nil {
		return false, false
	}
	resp, err := loadProbeClient.Do(req)
	if err != nil {
		return false, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, false
	}
	var body struct {
		Data []struct {
			ID     string `json:"id"`
			Loaded *bool  `json:"loaded"`
		} `json:"data"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body) != nil {
		return false, false
	}
	known := false
	for _, d := range body.Data {
		if d.Loaded == nil {
			continue
		}
		if d.ID == inst.Name {
			return *d.Loaded, true
		}
		known = true
		loaded = loaded || *d.Loaded
	}
	return loaded, known
}

var loadProbeClient = &http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: 2, IdleConnTimeout: 30 * time.Second}}

// --- HTTP API ---

// handleMetricsRecent GET /api/metrics/recent?instance=&limit=&chunks=1
func (h *Hub) handleMetricsRecent(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 50
	if v, err := strconv.Atoi(q.Get("limit")); err == nil && v > 0 {
		limit = min(v, 1000)
	}
	withChunks := q.Get("chunks") == "1" || q.Get("chunks") == "true"
	writeJSON(w, http.StatusOK, map[string]any{
		"requests": h.metrics.Recent(q.Get("instance"), limit, withChunks),
		"ringSize": requestRingCap,
	})
}

// handleMetricsRequest GET /api/metrics/requests/{id}
func (h *Hub) handleMetricsRequest(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.metrics.Lookup(r.PathValue("id"))
	if !ok {
		errJSON(w, http.StatusNotFound, "REQUEST_NOT_FOUND", nil, "request not in the in-memory log")
		return
	}
	writeJSON(w, http.StatusOK, rec)
}

// handleMetricsSummary GET /api/metrics/summary
func (h *Hub) handleMetricsSummary(w http.ResponseWriter, r *http.Request) {
	if h.metrics == nil {
		writeJSON(w, http.StatusOK, MetricsSummary{Instances: []InstanceStatus{}})
		return
	}
	live := h.instances.List()
	sum := h.metrics.Summary(live, h.instances.StatusOf)
	byID := map[string]*Instance{}
	for _, inst := range live {
		byID[inst.ID] = inst
	}
	for i := range sum.Instances {
		st := &sum.Instances[i]
		if st.InstanceID == "" || byID[st.InstanceID] == nil {
			continue
		}
		if h.tasks != nil {
			st.TasksActive = h.tasks.ActiveCountFor(st.InstanceID)
			st.QueueDepth = max(st.InFlight+st.TasksActive-1, 0)
		}
		if h.mem != nil {
			if mem := h.mem.MemoryJSON(st.InstanceID); mem != nil {
				delete(mem, "ramSeries")
				delete(mem, "vramSeries")
				st.Memory = mem
			}
		}
	}
	writeJSON(w, http.StatusOK, sum)
}
