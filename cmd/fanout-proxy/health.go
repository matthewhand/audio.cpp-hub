package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"sync"
	"time"
)

// failThreshold is how many consecutive poll failures mark a hub down. One
// blip must not move traffic off a warm primary, but two in a row should.
const failThreshold = 2

// maxInstancesBytes caps how much of /api/instances we keep in memory.
const maxInstancesBytes = 4 << 20

// hubState is the last poll result for one hub.
type hubState struct {
	baseURL   string
	label     string
	ok        bool
	latencyMs int64
	failures  int
	lastError string
	instances []map[string]any
	checkedAt time.Time
}

// ready reports whether this hub is up and exposes the named service READY.
func (s *hubState) ready(instanceName string) bool {
	if s == nil || !s.ok {
		return false
	}
	for _, inst := range s.instances {
		if inst["instanceName"] == instanceName && inst["status"] == "READY" {
			return true
		}
	}
	return false
}

// healthStore is the poll cache every routing decision reads. It is the only
// mutable state in the proxy, and it is refreshed by a single ticker.
type healthStore struct {
	mu    sync.RWMutex
	cfg   *Config
	state map[string]*hubState

	updatedAt time.Time
}

func newHealthStore(cfg *Config) *healthStore {
	s := &healthStore{
		cfg:   cfg,
		state: make(map[string]*hubState, len(cfg.Hubs)),
	}
	for _, h := range cfg.Hubs {
		s.state[h.BaseURL] = &hubState{baseURL: h.BaseURL, label: h.Label, lastError: "not polled yet"}
	}
	return s
}

// run polls immediately and then on every interval tick until ctx is done.
func (s *healthStore) run(ctx context.Context) {
	interval := time.Duration(s.cfg.PollIntervalMs) * time.Millisecond
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		s.pollOnce(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// pollOnce probes every hub in parallel and folds the results into the cache.
func (s *healthStore) pollOnce(ctx context.Context) {
	var wg sync.WaitGroup
	for _, h := range s.cfg.Hubs {
		wg.Add(1)
		go func(h Hub) {
			defer wg.Done()
			insts, latency, err := probeHub(ctx, h.BaseURL, time.Duration(s.cfg.PollTimeoutMs)*time.Millisecond)
			s.apply(h.BaseURL, insts, latency, err)
		}(h)
	}
	wg.Wait()
	s.mu.Lock()
	s.updatedAt = time.Now()
	s.mu.Unlock()
}

// probeHub GETs /api/instances on one hub.
func probeHub(ctx context.Context, baseURL string, timeout time.Duration) ([]map[string]any, time.Duration, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/api/instances", nil)
	if err != nil {
		return nil, 0, err
	}
	start := time.Now()
	resp, err := pollClient().Do(req)
	if err != nil {
		return nil, time.Since(start), err
	}
	defer resp.Body.Close()
	latency := time.Since(start)
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096)) // drain for keep-alive
		return nil, latency, &httpError{status: resp.StatusCode, url: baseURL}
	}
	var insts []map[string]any
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxInstancesBytes)).Decode(&insts); err != nil {
		return nil, latency, err
	}
	return insts, latency, nil
}

// apply folds one poll result into the cache and flips ok after failThreshold
// consecutive failures. A success resets the counter, so a hub that comes back
// is trusted again immediately.
func (s *healthStore) apply(baseURL string, insts []map[string]any, latency time.Duration, pollErr error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.state[baseURL]
	if !ok {
		return // hub removed from config at runtime; ignore
	}
	st.checkedAt = time.Now()
	st.latencyMs = latency.Milliseconds()
	if pollErr != nil {
		st.failures++
		st.lastError = pollErr.Error()
		st.instances = nil
	} else {
		st.failures = 0
		st.lastError = ""
		st.instances = insts
	}
	st.ok = st.failures < failThreshold
}

// hub returns a copy of one hub's state.
func (s *healthStore) hub(baseURL string) (hubState, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	st, ok := s.state[baseURL]
	if !ok {
		return hubState{}, false
	}
	return *st, true
}

// all returns every hub state, ordered like the config (failover priority).
func (s *healthStore) all() []hubState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]hubState, 0, len(s.state))
	for _, h := range s.cfg.Hubs {
		if st, ok := s.state[h.BaseURL]; ok {
			out = append(out, *st)
		}
	}
	return out
}

// snapshot returns a copy of every hub state, sorted by base URL. Used by
// /farm/health, where alphabetical order is easier to scan than config order.
func (s *healthStore) snapshot() ([]hubState, time.Time) {
	out := s.all()
	sort.Slice(out, func(i, j int) bool { return out[i].baseURL < out[j].baseURL })
	s.mu.RLock()
	defer s.mu.RUnlock()
	return out, s.updatedAt
}
