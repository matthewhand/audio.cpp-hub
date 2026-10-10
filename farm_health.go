package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// farm_health.go — same-origin summary of the fan-out proxy's /farm/health.
//
// The browser must not call another origin (CSP connect-src 'self'). The hub
// fetches a fixed URL from process config, never from the request, so this is
// not an SSRF sink. An empty URL disables the probe. Unreachable or invalid
// bodies are a 200 {"available":false}, cached like a success so a down
// fan-out is not hammered.

const (
	farmHealthEnv      = "AUDIOCPP_HUB_FANOUT_URL"
	farmHealthDefault  = "http://127.0.0.1:18082/farm/health"
	farmHealthTimeout  = 1500 * time.Millisecond
	farmHealthTTL      = 5 * time.Second
	farmHealthMaxBytes = 1 << 20
)

// farmFanoutURL reads AUDIOCPP_HUB_FANOUT_URL. Unset uses the default loopback
// fan-out. A set-but-empty (or whitespace) value disables the probe.
func farmFanoutURL() string {
	v, ok := os.LookupEnv(farmHealthEnv)
	if !ok {
		return farmHealthDefault
	}
	return strings.TrimSpace(v)
}

// farmSummary is the small JSON the WebUI chip consumes. Failures is the sum
// of hubs[].failures. Available means the fan-out answered with a usable
// summary, not that the farm's own "ok" flag is true.
type farmSummary struct {
	Available bool
	HubsUp    int
	HubsTotal int
	Failures  int
	CheckedAt string

	// Hubs carries each entry's label plus the instance ids it reports.
	// The handler resolves one of them to HubLabel by matching the local
	// instance ids (see hubLabelFor); unexported, so it never reaches JSON.
	Hubs []farmHubRef
}

// farmHubRef is one fan-out hub entry condensed to what the chip needs: its
// configured label and the ids of the instances it currently reports.
type farmHubRef struct {
	Label       string
	InstanceIDs map[string]struct{}
}

type farmHealth struct {
	url    string
	client *http.Client

	mu     sync.Mutex
	body   farmSummary
	at     time.Time
	has    bool
	flight chan struct{}
}

func newFarmHealth(url string) *farmHealth {
	return &farmHealth{
		url: strings.TrimSpace(url),
		client: &http.Client{
			Timeout: farmHealthTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

// snapshot returns the cached summary, or fetches it. nil receiver and an
// empty URL are "disabled" and return available:false without a network call.
// Success and failure are both cached for farmHealthTTL. Concurrent callers
// share one in-flight fetch.
func (f *farmHealth) snapshot() farmSummary {
	if f == nil || f.url == "" {
		return farmSummary{}
	}
	f.mu.Lock()
	if f.has && time.Since(f.at) < farmHealthTTL {
		body := f.body
		f.mu.Unlock()
		return body
	}
	if f.flight != nil {
		ch := f.flight
		f.mu.Unlock()
		<-ch
		f.mu.Lock()
		body := f.body
		f.mu.Unlock()
		return body
	}
	ch := make(chan struct{})
	f.flight = ch
	f.mu.Unlock()

	body := f.fetch()

	f.mu.Lock()
	f.body = body
	f.at = time.Now()
	f.has = true
	f.flight = nil
	close(ch)
	f.mu.Unlock()
	return body
}

func (f *farmHealth) fetch() farmSummary {
	// Background context: a disconnected client must not poison the shared
	// cache with a false "unavailable" for the whole TTL.
	ctx, cancel := context.WithTimeout(context.Background(), farmHealthTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.url, nil)
	if err != nil {
		return farmSummary{}
	}
	resp, err := f.client.Do(req)
	if err != nil {
		return farmSummary{}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return farmSummary{}
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, farmHealthMaxBytes+1))
	if err != nil || len(raw) > farmHealthMaxBytes {
		return farmSummary{}
	}
	sum, ok := parseFarmHealth(raw, time.Now().UTC())
	if !ok {
		return farmSummary{}
	}
	return sum
}

// parseFarmHealth extracts hubsUp, hubsTotal and the sum of hubs[].failures.
// hubsUp and hubsTotal must both be present non-negative integers with
// up <= total. hubs is optional; a non-null non-array is invalid. A negative
// failures value invalidates the body. ok, when present, must be a bool and
// does not decide availability.
func parseFarmHealth(raw []byte, now time.Time) (farmSummary, bool) {
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil {
		return farmSummary{}, false
	}
	upRaw, okUp := probe["hubsUp"]
	totRaw, okTot := probe["hubsTotal"]
	if !okUp || !okTot {
		return farmSummary{}, false
	}
	up, ok := jsonInt(upRaw)
	if !ok || up < 0 {
		return farmSummary{}, false
	}
	total, ok := jsonInt(totRaw)
	if !ok || total < 0 || up > total {
		return farmSummary{}, false
	}
	failures := 0
	var hubs []farmHubRef
	if hubsRaw, present := probe["hubs"]; present && string(hubsRaw) != "null" {
		var entries []map[string]json.RawMessage
		if err := json.Unmarshal(hubsRaw, &entries); err != nil {
			return farmSummary{}, false
		}
		for _, h := range entries {
			fr, has := h["failures"]
			if !has || string(fr) == "null" {
				continue
			}
			n, ok := jsonInt(fr)
			if !ok || n < 0 {
				return farmSummary{}, false
			}
			failures += n
			hubs = append(hubs, farmHubRefFrom(h))
		}
	}
	if okRaw, present := probe["ok"]; present {
		var b bool
		if err := json.Unmarshal(okRaw, &b); err != nil {
			return farmSummary{}, false
		}
	}
	checked := now.UTC().Format(time.RFC3339)
	if uRaw, present := probe["updatedAt"]; present {
		var s string
		if err := json.Unmarshal(uRaw, &s); err == nil && strings.TrimSpace(s) != "" {
			checked = s
		}
	}
	return farmSummary{
		Available: true,
		HubsUp:    up,
		HubsTotal: total,
		Failures:  failures,
		CheckedAt: checked,
		Hubs:      hubs,
	}, true
}

// farmHubRefFrom reads one hub entry's label and the ids under its
// "instances" passthrough (the fan-out mirrors each up hub's GET /api/instances).
// A missing / malformed label or instances array is "no match", not an error:
// the summary is still usable for the counts, it just carries no hub label.
func farmHubRefFrom(h map[string]json.RawMessage) farmHubRef {
	ref := farmHubRef{InstanceIDs: map[string]struct{}{}}
	if lbl, present := h["label"]; present && string(lbl) != "null" {
		var s string
		if err := json.Unmarshal(lbl, &s); err == nil {
			ref.Label = strings.TrimSpace(s)
		}
	}
	instRaw, present := h["instances"]
	if !present || string(instRaw) == "null" {
		return ref
	}
	var insts []map[string]json.RawMessage
	if err := json.Unmarshal(instRaw, &insts); err != nil {
		return ref
	}
	for _, inst := range insts {
		idRaw, ok := inst["id"]
		if !ok || string(idRaw) == "null" {
			continue
		}
		var id string
		if err := json.Unmarshal(idRaw, &id); err != nil {
			continue
		}
		if id = strings.TrimSpace(id); id != "" {
			ref.InstanceIDs[id] = struct{}{}
		}
	}
	return ref
}

// hubLabelFor returns the label of the fan-out hub entry that reports one of
// the local instance ids, in fan-out config order. Empty when no entry
// matches (single-machine hub, a fan-out that does not list instances, or a
// fan-out whose snapshot predates the local instances).
func (f farmSummary) hubLabelFor(localIDs map[string]struct{}) string {
	if len(localIDs) == 0 {
		return ""
	}
	for _, hub := range f.Hubs {
		if hub.Label == "" {
			continue
		}
		for id := range hub.InstanceIDs {
			if _, ok := localIDs[id]; ok {
				return hub.Label
			}
		}
	}
	return ""
}

func jsonInt(raw json.RawMessage) (int, bool) {
	var n float64
	if err := json.Unmarshal(raw, &n); err != nil {
		return 0, false
	}
	if n != float64(int(n)) || n > 1e9 || n < -1e9 {
		return 0, false
	}
	return int(n), true
}

// handleFarmHealth is GET /api/farm/health. Always 200. The URL is process
// config (see farmFanoutURL); query parameters are ignored.
//
// hubLabel is the fan-out label of the hub entry that reports one of this
// hub's own instances, so the WebUI chip can name the machine it is looking at
// ("GTX 1080 hub"). It is omitted when nothing matches; the client falls back
// to deriving a label from the local GPU name.
func (h *Hub) handleFarmHealth(w http.ResponseWriter, _ *http.Request) {
	var sum farmSummary
	if h != nil && h.farm != nil {
		sum = h.farm.snapshot()
	}
	if !sum.Available {
		writeJSON(w, http.StatusOK, map[string]any{"available": false})
		return
	}
	body := map[string]any{
		"available": true,
		"hubsUp":    sum.HubsUp,
		"hubsTotal": sum.HubsTotal,
		"failures":  sum.Failures,
		"checkedAt": sum.CheckedAt,
	}
	if label := sum.hubLabelFor(localInstanceIDs(h)); label != "" {
		body["hubLabel"] = label
	}
	writeJSON(w, http.StatusOK, body)
}

// localInstanceIDs is the id set of this hub's instances (all statuses).
func localInstanceIDs(h *Hub) map[string]struct{} {
	ids := map[string]struct{}{}
	if h == nil || h.instances == nil {
		return ids
	}
	for _, inst := range h.instances.List() {
		if inst == nil || inst.ID == "" {
			continue
		}
		ids[inst.ID] = struct{}{}
	}
	return ids
}
