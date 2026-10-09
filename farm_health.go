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
	if hubsRaw, present := probe["hubs"]; present && string(hubsRaw) != "null" {
		var hubs []map[string]json.RawMessage
		if err := json.Unmarshal(hubsRaw, &hubs); err != nil {
			return farmSummary{}, false
		}
		for _, h := range hubs {
			fr, has := h["failures"]
			if !has || string(fr) == "null" {
				continue
			}
			n, ok := jsonInt(fr)
			if !ok || n < 0 {
				return farmSummary{}, false
			}
			failures += n
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
	}, true
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
func (h *Hub) handleFarmHealth(w http.ResponseWriter, _ *http.Request) {
	var sum farmSummary
	if h != nil && h.farm != nil {
		sum = h.farm.snapshot()
	}
	if !sum.Available {
		writeJSON(w, http.StatusOK, map[string]any{"available": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"available":  true,
		"hubsUp":     sum.HubsUp,
		"hubsTotal":  sum.HubsTotal,
		"failures":   sum.Failures,
		"checkedAt":  sum.CheckedAt,
	})
}
