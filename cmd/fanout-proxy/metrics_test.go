package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func farmHealth(t *testing.T, p *proxy) map[string]any {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/farm/health", nil)
	rec := httptest.NewRecorder()
	p.handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("health body is not JSON: %v", err)
	}
	return out
}

// routeHealth digs out the health entry for one alias set.
func routeHealth(t *testing.T, health map[string]any, alias string) map[string]any {
	t.Helper()
	routes, _ := health["routes"].([]any)
	for _, r := range routes {
		route, _ := r.(map[string]any)
		aliases, _ := route["aliases"].([]any)
		for _, a := range aliases {
			if a == alias {
				return route
			}
		}
	}
	t.Fatalf("alias %q missing from /farm/health", alias)
	return nil
}

func targetServed(t *testing.T, route map[string]any, instanceName string) (float64, float64) {
	t.Helper()
	targets, _ := route["targets"].([]any)
	for _, tg := range targets {
		target, _ := tg.(map[string]any)
		if target["instanceName"] == instanceName {
			served, _ := target["served"].(float64)
			failed, _ := target["failed"].(float64)
			return served, failed
		}
	}
	t.Fatalf("target %q missing from route health", instanceName)
	return 0, 0
}

func TestCountersNilSafe(t *testing.T) {
	var c *counters
	c.recordServed(Target{Hub: "http://a", InstanceName: "x"})
	c.recordFailed(Target{Hub: "http://a", InstanceName: "x"})
	if s, f := c.counts(Target{Hub: "http://a", InstanceName: "x"}); s != 0 || f != 0 {
		t.Errorf("nil counters reported served=%d failed=%d, want 0/0", s, f)
	}
	if !c.start().IsZero() {
		t.Error("nil counters reported a start time")
	}
}

// Failover route: the standby's share is 100%, and every failed attempt on the
// primary is counted there, so an operator can see a flapping primary in
// /farm/health instead of only in the log.
func TestFarmHealthCountsFailover(t *testing.T) {
	bad := newFakeHub(t, 500, `{"error":{"message":"engine died"}}`, "application/json")
	good := newFakeHub(t, 200, "wav", "audio/wav")
	p := newTestProxy(
		[]Hub{{BaseURL: bad.srv.URL}, {BaseURL: good.srv.URL}},
		[]Route{{
			Aliases: []string{"breeze"},
			Targets: []Target{
				{Hub: bad.srv.URL, InstanceName: "primary"},
				{Hub: good.srv.URL, InstanceName: "standby"},
			},
		}},
	)
	markReady(p.hub, bad.srv.URL, "primary")
	markReady(p.hub, good.srv.URL, "standby")

	for i := 0; i < 3; i++ {
		if rec := post(t, p, `{"model":"breeze","input":"count me"}`); rec.Code != 200 {
			t.Fatalf("request %d: status = %d", i, rec.Code)
		}
	}

	health := farmHealth(t, p)
	if health["countersSince"] == "" {
		t.Error("countersSince missing; counters need a reference point")
	}
	route := routeHealth(t, health, "breeze")
	if served, _ := route["served"].(float64); served != 3 {
		t.Errorf("route served = %v, want 3", route["served"])
	}
	if failed, _ := route["failed"].(float64); failed != 3 {
		t.Errorf("route failed = %v, want 3", route["failed"])
	}
	if served, failed := targetServed(t, route, "primary"); served != 0 || failed != 3 {
		t.Errorf("primary served=%v failed=%v, want 0/3", served, failed)
	}
	if served, failed := targetServed(t, route, "standby"); served != 3 || failed != 0 {
		t.Errorf("standby served=%v failed=%v, want 3/0", served, failed)
	}
}

// The point of the split: a balanced route's counters must show the weight.
func TestFarmHealthCountsRoundRobin(t *testing.T) {
	hubA := newFakeHub(t, 200, "A", "audio/wav")
	hubB := newFakeHub(t, 200, "B", "audio/wav")
	p := newTestProxy(
		[]Hub{{BaseURL: hubA.srv.URL}, {BaseURL: hubB.srv.URL}},
		[]Route{{
			Aliases:  []string{"kokoro"},
			Strategy: StrategyRoundRobin,
			Targets: []Target{
				{Hub: hubA.srv.URL, InstanceName: "kokoro", Weight: 2},
				{Hub: hubB.srv.URL, InstanceName: "kokoro-win1", Weight: 1},
			},
		}},
	)
	markReady(p.hub, hubA.srv.URL, "kokoro")
	markReady(p.hub, hubB.srv.URL, "kokoro-win1")

	for i := 0; i < 6; i++ {
		post(t, p, `{"model":"kokoro","input":"split check"}`)
	}

	route := routeHealth(t, farmHealth(t, p), "kokoro")
	if got, _ := route["served"].(float64); got != 6 {
		t.Errorf("route served = %v, want 6", route["served"])
	}
	if served, failed := targetServed(t, route, "kokoro"); served != 4 || failed != 0 {
		t.Errorf("weight-2 target served=%v failed=%v, want 4/0", served, failed)
	}
	if served, failed := targetServed(t, route, "kokoro-win1"); served != 2 || failed != 0 {
		t.Errorf("weight-1 target served=%v failed=%v, want 2/0", served, failed)
	}
}
