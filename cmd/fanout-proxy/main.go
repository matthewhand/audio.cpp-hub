// Command fanout-proxy is a tiny LAN-only fan-out router for the multi-host
// voice farm (see docs/fanout-design.md, docs/farm.md).
//
// It polls every hub's GET /api/instances, exposes one OpenAI-shaped surface
// on a single port, and routes POST /v1/audio/speech to the first healthy
// backend of a model alias, with failover down the target list.
//
// Deliberately small and stdlib-only: it changes nothing on the hubs, and
// history/voice libraries stay on the origin hub that served the request
// (X-Fanout-Hub / X-Fanout-Instance say which one that was).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// proxy bundles the immutable config with the mutable health cache.
type proxy struct {
	cfg *Config
	hub *healthStore
	lim *limiter
}

func main() {
	configPath := flag.String("config", defaultConfigPath(), "path to farm.routes.json")
	listenOverride := flag.String("listen", "", "override the config listen address (e.g. :18082)")
	flag.Parse()

	cfg, err := LoadConfig(*configPath)
	if err != nil {
		log.Fatalf("fanout-proxy: %v", err)
	}
	if *listenOverride != "" {
		cfg.Listen = *listenOverride
	}

	p := &proxy{cfg: cfg, hub: newHealthStore(cfg), lim: newLimiter(cfg.MaxInFlightPerTarget)}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go p.hub.run(ctx)

	srv := &http.Server{
		Addr:    cfg.Listen,
		Handler: p.handler(),
		// No WriteTimeout: TTS generation is unbounded by design. Client
		// disconnects cancel the upstream request through the context.
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(shutCtx)
	}()

	log.Printf("fanout-proxy listening on %s (config %s, %d hubs, %d routes, in-flight cap %d/target, aliases: %s)",
		cfg.Listen, *configPath, len(cfg.Hubs), len(cfg.Routes), cfg.MaxInFlightPerTarget, strings.Join(cfg.aliases(), ", "))
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("fanout-proxy: %v", err)
	}
	log.Print("fanout-proxy stopped")
}

// defaultConfigPath lets the unit file pin -config while a manual run from any
// directory still finds the committed routes file.
func defaultConfigPath() string {
	if p := os.Getenv("FANOUT_CONFIG"); p != "" {
		return p
	}
	return "farm.routes.json"
}

func (p *proxy) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /farm/health", p.handleFarmHealth)
	mux.HandleFunc("GET /api/instances", p.handleInstances)
	mux.HandleFunc("GET /v1/models", p.handleModels)
	mux.HandleFunc("POST /v1/audio/speech", p.handleSpeech)
	mux.HandleFunc("/", p.handleFallback)
	return withCORS(mux)
}

// withCORS mirrors the hub's /v1/* policy: browser OpenAI clients need
// preflight, and this LAN service carries no credentials.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, OpenAI-*")
			w.Header().Set("Access-Control-Max-Age", "86400")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---------------------------------------------------------------- GET /farm/health

// handleFarmHealth is the ops view: per-hub reachability, latency and last
// error, plus which backend each alias currently resolves to. LAN-only.
func (p *proxy) handleFarmHealth(w http.ResponseWriter, r *http.Request) {
	states, updatedAt := p.hub.snapshot()
	hubs := make([]map[string]any, 0, len(states))
	upCount := 0
	for _, st := range states {
		if st.ok {
			upCount++
		}
		insts := st.instances
		if insts == nil {
			insts = []map[string]any{}
		}
		hubs = append(hubs, map[string]any{
			"baseUrl":   st.baseURL,
			"label":     st.label,
			"ok":        st.ok,
			"latencyMs": st.latencyMs,
			"failures":  st.failures,
			"lastError": st.lastError,
			"checkedAt": formatTime(st.checkedAt),
			"instances": insts,
		})
	}

	routes := make([]map[string]any, 0, len(p.cfg.Routes))
	readyAliases := 0
	for i := range p.cfg.Routes {
		rt := &p.cfg.Routes[i]
		plan := planTargets(rt, p.hub)
		targets := make([]map[string]any, 0, len(plan))
		resolved := ""
		for _, c := range plan {
			targets = append(targets, map[string]any{
				"hub":          c.target.Hub,
				"instanceName": c.target.InstanceName,
				"skipped":      c.skip,
				"inFlight":     p.lim.inFlight(targetKey(c.target)),
			})
			if c.skip == "" && resolved == "" {
				resolved = c.target.Hub + "/" + c.target.InstanceName
			}
		}
		if resolved != "" {
			readyAliases += len(rt.Aliases)
		}
		routes = append(routes, map[string]any{
			"aliases":  rt.Aliases,
			"resolved": resolved,
			"targets":  targets,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":            readyAliases > 0,
		"updatedAt":     formatTime(updatedAt),
		"hubsUp":        upCount,
		"hubsTotal":     len(states),
		"readyAliases":  readyAliases,
		"inFlightCap":   p.cfg.MaxInFlightPerTarget,
		"hubs":          hubs,
		"routes":        routes,
		"knownAliases":  p.cfg.aliases(),
		"historyOrigin": "per-hub: see X-Fanout-Hub response header",
	})
}

// ---------------------------------------------------------------- GET /api/instances

// handleInstances aggregates every up hub's instances, tagging each entry with
// its origin hub so callers can see the whole farm in one call.
func (p *proxy) handleInstances(w http.ResponseWriter, r *http.Request) {
	out := []map[string]any{}
	for _, st := range p.hub.all() { // config order
		if !st.ok {
			continue
		}
		for _, inst := range st.instances {
			tagged := make(map[string]any, len(inst)+2)
			for k, v := range inst {
				tagged[k] = v
			}
			tagged["hub"] = st.baseURL
			tagged["hubLabel"] = st.label
			out = append(out, tagged)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a["hub"] != b["hub"] {
			return strField(a, "hub") < strField(b, "hub")
		}
		return strField(a, "instanceName") < strField(b, "instanceName")
	})
	writeJSON(w, http.StatusOK, out)
}

// strField reads a string field from a decoded upstream object. Hubs are
// remote input: an older build, or a baseUrl pointed at the wrong port, can
// omit a field or make it a different type, and a sort must not panic on that.
func strField(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

// ---------------------------------------------------------------- GET /v1/models

// handleModels lists the aliases that currently resolve to a READY backend.
// OpenAI shape, so existing clients need no change beyond the base URL.
func (p *proxy) handleModels(w http.ResponseWriter, r *http.Request) {
	created := time.Now().Unix()
	data := []map[string]any{}
	for i := range p.cfg.Routes {
		rt := &p.cfg.Routes[i]
		if _, ok := pickTarget(rt, p.hub); !ok {
			continue
		}
		for _, alias := range rt.Aliases {
			data = append(data, map[string]any{
				"id":       alias,
				"object":   "model",
				"created":  created,
				"owned_by": "audiocpp-fanout",
			})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"object": "list", "data": data})
}

// ---------------------------------------------------------------- POST /v1/audio/speech

// handleSpeech routes a speech request by model alias, walking the failover
// list until one backend answers. Once bytes reach the client no retry is
// possible, so every retryable failure has to surface before that.
func (p *proxy) handleSpeech(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, p.cfg.MaxBodyBytes+1))
	if err != nil {
		openAIError(w, http.StatusBadRequest, "Cannot read request body", nil)
		return
	}
	if int64(len(body)) > p.cfg.MaxBodyBytes {
		openAIError(w, http.StatusRequestEntityTooLarge, "Request body too large", nil)
		return
	}
	fields, err := decodeBody(body)
	if err != nil {
		openAIError(w, http.StatusBadRequest, "Body must be a JSON object with a \"model\" field", nil)
		return
	}
	alias, err := extractModel(fields)
	if err != nil {
		openAIError(w, http.StatusBadRequest, err.Error(), map[string]any{"known_models": p.cfg.aliases()})
		return
	}
	rt, ok := p.cfg.routeFor(alias)
	if !ok {
		openAIError(w, http.StatusNotFound, "No fan-out route for model "+alias,
			map[string]any{"known_models": p.cfg.aliases()})
		return
	}

	attempts := []attempt{}
	busy := 0 // targets skipped only because they sit at their in-flight cap
	for _, c := range planTargets(rt, p.hub) {
		if c.skip != "" {
			attempts = append(attempts, attempt{Hub: c.target.Hub, InstanceName: c.target.InstanceName, Reason: c.skip})
			continue
		}
		upstream, err := rewriteModel(fields, c.target.InstanceName)
		if err != nil {
			attempts = append(attempts, attempt{Hub: c.target.Hub, InstanceName: c.target.InstanceName, Reason: err.Error()})
			continue
		}
		// One slot per in-flight forward on this origin instance, so a noisy
		// client cannot pin an engine while the farm looks healthy.
		key := targetKey(c.target)
		if !p.lim.acquire(key) {
			attempts = append(attempts, attempt{Hub: c.target.Hub, InstanceName: c.target.InstanceName, Reason: busyReason(p.cfg.MaxInFlightPerTarget)})
			busy++
			continue
		}
		res, err := func() (speechResult, error) {
			defer p.lim.release(key)
			return relaySpeech(w, r, c.target, upstream)
		}()
		switch {
		case err != nil && res.Streamed:
			// Upstream was already streaming; the client is mid-download, so
			// there is nothing left to fail over to.
			log.Printf("fanout: client stream from %s/%s broke: %v", c.target.Hub, c.target.InstanceName, err)
			return
		case err != nil:
			reason := err.Error()
			var he *httpError
			if errors.As(err, &he) && !retryable(he.status) {
				attempts = append(attempts, attempt{Hub: c.target.Hub, InstanceName: c.target.InstanceName, Reason: reason})
				openAIError(w, he.status, "Upstream rejected the request: "+reason, map[string]any{"attempts": attempts})
				return
			}
			attempts = append(attempts, attempt{Hub: c.target.Hub, InstanceName: c.target.InstanceName, Reason: reason})
		default:
			log.Printf("fanout: %s -> %s/%s", alias, c.target.Hub, c.target.InstanceName)
			return
		}
	}

	// Every usable target was busy: this is load shedding, not an outage, so
	// say 429 with a Retry-After instead of a misleading 503.
	if busy > 0 && busy == len(attempts) {
		w.Header().Set("Retry-After", strconv.Itoa(retryAfterSeconds))
		openAIError(w, http.StatusTooManyRequests,
			"All fan-out backends for model "+alias+" are at their in-flight cap",
			map[string]any{"attempts": attempts, "hubs_tried": hubList(attempts), "inFlightCap": p.cfg.MaxInFlightPerTarget})
		return
	}

	openAIError(w, http.StatusServiceUnavailable,
		"No fan-out backend available for model "+alias,
		map[string]any{"attempts": attempts, "hubs_tried": hubList(attempts)})
}

// handleFallback answers unknown paths with the served surface, which is more
// useful than a bare 404 when an agent is pointed at the wrong port.
func (p *proxy) handleFallback(w http.ResponseWriter, r *http.Request) {
	openAIError(w, http.StatusNotFound, "Unknown endpoint "+r.Method+" "+r.URL.Path, map[string]any{
		"endpoints": []string{
			"GET /farm/health", "GET /api/instances", "GET /v1/models", "POST /v1/audio/speech",
		},
	})
}

// ---------------------------------------------------------------- helpers

// hubList is the flat "which hubs did we try" list in the failure envelope.
func hubList(attempts []attempt) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, a := range attempts {
		if !seen[a.Hub] {
			seen[a.Hub] = true
			out = append(out, a.Hub)
		}
	}
	return out
}

// openAIError keeps the /v1/* error envelope the hub and OpenAI clients expect,
// with the fan-out specific detail in extra.
func openAIError(w http.ResponseWriter, status int, message string, extra map[string]any) {
	typ := "invalid_request_error"
	switch {
	case status == http.StatusTooManyRequests:
		typ = "rate_limit_error" // what OpenAI clients expect from a 429
	case status >= 500:
		typ = "server_error"
	}
	body := map[string]any{"message": message, "type": typ}
	for k, v := range extra {
		body[k] = v
	}
	writeJSON(w, status, map[string]any{"error": body})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func formatTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}
