package main

import "sync"

// balancer decides the order in which a route's targets are tried.
//
// A failover route is already ordered by the operator, so its plan is used as
// is. A round_robin route uses smooth weighted round-robin (the nginx
// algorithm): every usable target accumulates its weight on each request, the
// highest total wins, and the winner is charged the sum of the weights. With
// weights 2 and 1 the pattern is A,A,B,A,A,B rather than a bursty A,A,B; with
// equal weights it is a plain rotation.
//
// Only usable targets take part, so a hub that goes down or an instance that
// leaves READY drops out of the rotation and rejoins when it returns. The
// chosen target still walks the rest of the plan when it fails, so balancing
// never weakens the failover guarantee.
type balancer struct {
	mu    sync.Mutex
	state map[*Route]map[string]int // route -> target key -> accumulated weight
}

func newBalancer() *balancer {
	return &balancer{state: make(map[*Route]map[string]int)}
}

// order returns the candidates in the order they should be tried: the chosen
// target first, then everything else in config order, so a failed choice spills
// to the next target exactly like failover.
func (b *balancer) order(rt *Route, plan []candidate) []candidate {
	if b == nil || rt.Strategy != StrategyRoundRobin {
		return plan
	}
	usable := make([]int, 0, len(plan))
	for i := range plan {
		if plan[i].skip == "" {
			usable = append(usable, i)
		}
	}
	if len(usable) < 2 {
		return plan // nothing to choose between
	}

	b.mu.Lock()
	acc, ok := b.state[rt]
	if !ok {
		acc = make(map[string]int, len(usable))
		b.state[rt] = acc
	}
	total := 0
	best := usable[0]
	bestKey := targetKey(plan[best].target)
	for _, i := range usable {
		key := targetKey(plan[i].target)
		w := plan[i].target.Weight
		if w <= 0 {
			w = defaultWeight
		}
		acc[key] += w
		total += w
		if acc[key] > acc[bestKey] {
			best, bestKey = i, key
		}
	}
	acc[bestKey] -= total
	b.mu.Unlock()

	out := make([]candidate, 0, len(plan))
	out = append(out, plan[best])
	for i := range plan {
		if i != best {
			out = append(out, plan[i])
		}
	}
	return out
}
