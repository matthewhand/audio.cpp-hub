package main

import (
	"reflect"
	"testing"
)

// plan builds the candidate list planTargets would produce, with the named
// targets marked unusable so the balancer can be exercised without a poll cache.
func plan(rt *Route, skipped map[string]string) []candidate {
	out := make([]candidate, 0, len(rt.Targets))
	for _, t := range rt.Targets {
		out = append(out, candidate{target: t, skip: skipped[t.InstanceName]})
	}
	return out
}

func rrRoute(weights ...int) *Route {
	targets := make([]Target, 0, len(weights))
	for i, w := range weights {
		targets = append(targets, Target{
			Hub:          "http://h" + string(rune('a'+i)) + ":18080",
			InstanceName: "kokoro",
			Weight:       w,
		})
	}
	return &Route{Aliases: []string{"kokoro"}, Strategy: StrategyRoundRobin, Targets: targets}
}

// chose is the target first in the returned order, i.e. the one a request
// would hit before any failover.
func chose(plan []candidate) string { return plan[0].target.Hub }

func TestBalancerFailoverKeepsOrder(t *testing.T) {
	rt := &Route{Strategy: StrategyFailover, Targets: []Target{
		{Hub: "http://a:18080", InstanceName: "x", Weight: 1},
		{Hub: "http://b:18080", InstanceName: "x", Weight: 1},
	}}
	b := newBalancer()
	p := plan(rt, nil)
	for i := 0; i < 4; i++ {
		if got := b.order(rt, p); !reflect.DeepEqual(got, p) {
			t.Fatalf("call %d: failover order changed: %v", i, got)
		}
	}
}

func TestBalancerNilIsConfigOrder(t *testing.T) {
	rt := rrRoute(1, 1)
	p := plan(rt, nil)
	var b *balancer // a proxy built before balancing existed must not panic
	if got := b.order(rt, p); !reflect.DeepEqual(got, p) {
		t.Fatalf("nil balancer reordered targets: %v", got)
	}
}

// Equal weights must rotate, not stick to the first usable target.
func TestBalancerRoundRobinEqualWeights(t *testing.T) {
	rt := rrRoute(1, 1)
	b := newBalancer()
	p := plan(rt, nil)
	want := []string{"http://ha:18080", "http://hb:18080", "http://ha:18080", "http://hb:18080"}
	for i, w := range want {
		if got := chose(b.order(rt, p)); got != w {
			t.Fatalf("request %d chose %s, want %s", i, got, w)
		}
	}
}

// 2:1 must interleave (A,B,A,A,B,A) rather than burst, and hold the ratio over
// a longer run.
func TestBalancerRoundRobinWeights(t *testing.T) {
	rt := rrRoute(2, 1)
	b := newBalancer()
	p := plan(rt, nil)
	const hubA, hubB = "http://ha:18080", "http://hb:18080"
	want := []string{hubA, hubB, hubA, hubA, hubB, hubA}
	for i, w := range want {
		if got := chose(b.order(rt, p)); got != w {
			t.Fatalf("request %d chose %s, want %s", i, got, w)
		}
	}
	counts := map[string]int{}
	for i := 0; i < 30; i++ {
		counts[chose(b.order(rt, p))]++
	}
	if counts[hubA] != 20 || counts[hubB] != 10 {
		t.Errorf("30 requests split %v, want %s=20 %s=10", counts, hubA, hubB)
	}
}

// A single usable target is not a choice: the plan must stay in config order so
// that nothing is needlessly reordered.
func TestBalancerSingleUsableTarget(t *testing.T) {
	rt := rrRoute(1, 1)
	b := newBalancer()
	p := plan(rt, map[string]string{"kokoro": "hub is down"})
	if got := b.order(rt, p); !reflect.DeepEqual(got, p) {
		t.Fatalf("single usable target reordered: %v", got)
	}
}

// A target that is down, starting, or at its in-flight cap is out of the
// rotation: the healthy one must take every request, and when it comes back the
// rotation resumes.
func TestBalancerSkipsUnusableTargets(t *testing.T) {
	const hubA, hubB = "http://ha:18080", "http://hb:18080"
	rt := &Route{Strategy: StrategyRoundRobin, Targets: []Target{
		{Hub: hubA, InstanceName: "kokoro", Weight: 1},
		{Hub: hubB, InstanceName: "kokoro-win1", Weight: 5},
	}}
	b := newBalancer()
	// Windows1 at its in-flight cap: the healthy loopback hub takes every
	// request instead of hammering the busy one.
	busy := plan(rt, map[string]string{"kokoro-win1": "at in-flight cap (2)"})
	for i := 0; i < 5; i++ {
		if got := chose(b.order(rt, busy)); got != hubA {
			t.Fatalf("request %d chose %s, want the only usable target %s", i, got, hubA)
		}
	}
	// It comes back: its 5x weight immediately earns its share again.
	b2 := newBalancer()
	healthy := plan(rt, nil)
	counts := map[string]int{}
	for i := 0; i < 6; i++ {
		counts[chose(b2.order(rt, healthy))]++
	}
	if counts[hubA] != 1 || counts[hubB] != 5 {
		t.Errorf("1:5 split over 6 requests = %v, want %s=1 %s=5", counts, hubA, hubB)
	}
}

// The chosen target goes first but everything else follows in config order, so
// a failed round-robin pick still spills down the route.
func TestBalancerKeepsFallbackOrder(t *testing.T) {
	rt := rrRoute(1, 1)
	b := newBalancer()
	p := plan(rt, nil)
	got := b.order(rt, p)
	if len(got) != 2 {
		t.Fatalf("order length = %d, want 2", len(got))
	}
	if got[0].target.Hub == p[0].target.Hub && got[1].target.Hub != p[1].target.Hub {
		t.Errorf("fallback order = %v, want remaining target after the chosen one", got)
	}
}
