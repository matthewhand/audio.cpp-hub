package main

// STT through the fan-out: POST /api/tasks routes by the same alias the speech
// path uses, so the stt/citrinet route gets the same poll cache, the same
// per-origin in-flight cap and the same failover list as TTS
// (docs/fanout-design.md follow-up 1).
//
// The hub's submission contract is {"instanceId","request"} and instanceId is
// hub-local, so the proxy resolves it from the /api/instances snapshot it already
// caches for routing, and rewrites that one field. The engine's own request
// object is relayed byte-for-byte — the same "only the routing key is touched"
// rule the speech path keeps.
//
// Reading a task back is a read-through pinned by ?hub=<baseUrl>, because task
// ids only mean something on the hub that issued them; see handleTaskRead.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// taskIDPattern mirrors the hub's task id rule (internal/idvalidate.SafeID).
// The id becomes a path segment on the upstream hub, so it is validated here
// before it is ever put into a URL.
var taskIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,32}$`)

// taskReadTimeout bounds a read-through. Reads carry no side effects, so unlike
// the unbounded forwards a stuck hub must not be able to pin the request open.
const taskReadTimeout = 30 * time.Second

// ---------------------------------------------------------------- POST /api/tasks

// handleTaskCreate submits an async task (STT today, anything else the route
// table points at) by model alias:
//
//	POST /api/tasks {"model": "<alias>", "request": {…engine fields…}}
//
// It answers as soon as the hub accepts the submission (202 + task record); the
// transcript itself arrives through the pinned read-through below.
func (p *proxy) handleTaskCreate(w http.ResponseWriter, r *http.Request) {
	fields, ok := p.readJSONBody(w, r)
	if !ok {
		return
	}
	engineRequest, err := extractTaskRequest(fields)
	if err != nil {
		openAIError(w, http.StatusBadRequest, err.Error(), nil)
		return
	}
	rt, alias, ok := p.routeByModel(w, fields)
	if !ok {
		return
	}
	p.forwardWithFailover(w, r, alias, rt, func(w http.ResponseWriter, r *http.Request, target Target) (forwardResult, error) {
		instanceID, err := p.taskInstanceID(target)
		if err != nil {
			return forwardResult{}, err
		}
		upstream, err := taskBody(instanceID, engineRequest)
		if err != nil {
			return forwardResult{}, err
		}
		return relayUpstream(w, r, target, "/api/tasks", upstream)
	})
}

// extractTaskRequest returns the engine request object verbatim. The hub would
// default a missing "request" to {}, which would only surface much later as an
// engine-side failure, so the proxy refuses it up front with the shape spelled
// out.
func extractTaskRequest(fields map[string]json.RawMessage) (json.RawMessage, error) {
	raw, ok := fields["request"]
	if !ok {
		return nil, errors.New(`Body needs a "request" object: {"model":"<alias>","request":{…}}`)
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil || probe == nil {
		return nil, errors.New(`"request" must be a JSON object`)
	}
	return raw, nil
}

// taskBody builds the hub submission body: the engine request keeps its
// original bytes and only the hub-local instanceId is added.
func taskBody(instanceID string, engineRequest json.RawMessage) ([]byte, error) {
	id, err := json.Marshal(instanceID)
	if err != nil {
		return nil, err
	}
	return json.Marshal(map[string]json.RawMessage{"instanceId": id, "request": engineRequest})
}

// taskInstanceID resolves the hub-local instanceId a submission needs. An error
// means this target cannot be used and the failover loop records why, exactly
// like "hub is down" or "instance is not READY".
func (p *proxy) taskInstanceID(target Target) (string, error) {
	st, ok := p.hub.hub(target.Hub)
	if !ok {
		return "", errors.New("hub is not in config")
	}
	id := st.instanceID(target.InstanceName)
	if id == "" {
		return "", errors.New("poll cache has no instance id for " + target.InstanceName)
	}
	return id, nil
}

// ---------------------------------------------------------------- 任务读回

// handleTaskRead proxies task status, result and cancel to one hub, pinned by
// ?hub=<baseUrl>.
//
// The pin is mandatory, not a convenience: task ids are hub-local 8-char ids, so
// guessing a host would risk answering with another hub's task (or a confusing
// 404 for one that exists elsewhere). The origin comes back on every submission
// as the X-Fanout-Hub header and in GET /api/instances entries.
//
// There is deliberately no failover here: the task is already running on one
// engine and re-submitting it somewhere else would duplicate work, not recover
// it.
func (p *proxy) handleTaskRead(w http.ResponseWriter, r *http.Request) {
	base, ok := p.pinnedHub(w, r)
	if !ok {
		return
	}
	if id := r.PathValue("id"); id != "" && !taskIDPattern.MatchString(id) {
		openAIError(w, http.StatusBadRequest, "Not a valid task id: "+strconv.Quote(id), nil)
		return
	}
	target := base + r.URL.Path
	if query := forwardQuery(r.URL.Query()); query != "" {
		target += "?" + query
	}
	w.Header().Set("X-Fanout-Hub", base)

	ctx, cancel := context.WithTimeout(r.Context(), taskReadTimeout)
	defer cancel()
	sent, err := relayRead(w, r.WithContext(ctx), r.Method, target)
	if err == nil {
		return
	}
	if sent {
		log.Printf("fanout: client stream from %s broke: %v", base, err)
		return
	}
	openAIError(w, http.StatusBadGateway, "Origin hub unreachable: "+err.Error(), map[string]any{"hub": base})
}

// pinnedHub resolves ?hub=<baseUrl> against the configured hubs, writing the
// 400 / 502 itself. A hub the poll cache reports as down is refused without a
// dial, so a dead host answers immediately instead of after a TCP timeout.
func (p *proxy) pinnedHub(w http.ResponseWriter, r *http.Request) (string, bool) {
	base := strings.TrimRight(strings.TrimSpace(r.URL.Query().Get("hub")), "/")
	if base == "" {
		openAIError(w, http.StatusBadRequest,
			"Task reads need ?hub=<hub baseUrl>: task ids are hub-local, so the hub that ran the task must be named (see X-Fanout-Hub on the submission)",
			map[string]any{"known_hubs": p.cfg.hubBaseURLs()})
		return "", false
	}
	if !p.cfg.hubURLs[base] {
		openAIError(w, http.StatusBadRequest, "Unknown hub "+base,
			map[string]any{"known_hubs": p.cfg.hubBaseURLs()})
		return "", false
	}
	if st, ok := p.hub.hub(base); !ok || !st.ok {
		openAIError(w, http.StatusBadGateway, "Hub "+base+" is not reachable right now",
			map[string]any{"hub": base})
		return "", false
	}
	return base, true
}

// forwardQuery is the inbound query minus the fan-out's own pin, so hub filters
// (active, modelId) survive the hop and nothing else leaks.
func forwardQuery(in url.Values) string {
	out := url.Values{}
	for key, values := range in {
		if strings.EqualFold(key, "hub") {
			continue
		}
		for _, v := range values {
			out.Add(key, v)
		}
	}
	return out.Encode()
}

// relayRead proxies one read verbatim: the hub's own status and body are the
// answer (its 404 TASK_NOT_FOUND has to stay a 404, not become a fan-out
// envelope), so only a transport failure is returned as an error. sent reports
// whether the response had already started, i.e. whether an error can still be
// written to the client.
func relayRead(w http.ResponseWriter, r *http.Request, method, target string) (sent bool, err error) {
	req, err := http.NewRequestWithContext(r.Context(), method, target, nil)
	if err != nil {
		return false, err
	}
	resp, err := forwardClient.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.WriteHeader(resp.StatusCode)
	_, err = io.CopyBuffer(flushWriter{w: w}, resp.Body, make([]byte, 32<<10))
	return true, err
}
