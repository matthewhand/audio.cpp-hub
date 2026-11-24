package main

import (
	"sync"
	"time"
)

// counters is the split measurement for a balanced (or any) route: how many
// forwards each origin target actually served, and how many it failed. It is
// the answer to "is the 2:1 weight really happening?" without reading response
// headers, and it stays per target so a failover route shows the same thing.
//
// Counts are cumulative since process start (see startedAt in /farm/health) and
// are deliberately cheap: one mutex around two maps, touched once per forward.
type counters struct {
	mu     sync.Mutex
	since  time.Time
	served map[string]int64
	failed map[string]int64
}

func newCounters() *counters {
	return &counters{
		since:  time.Now(),
		served: make(map[string]int64),
		failed: make(map[string]int64),
	}
}

// recordServed counts a forward that answered successfully at this target.
func (c *counters) recordServed(target Target) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.served[targetKey(target)]++
}

// recordFailed counts a forward that reached this target but did not answer,
// i.e. something the failover loop then walked past.
func (c *counters) recordFailed(target Target) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.failed[targetKey(target)]++
}

// counts returns one target's totals, zero when it has never been tried.
func (c *counters) counts(target Target) (served, failed int64) {
	if c == nil {
		return 0, 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	key := targetKey(target)
	return c.served[key], c.failed[key]
}

// start is when counting began, for the /farm/health header.
func (c *counters) start() time.Time {
	if c == nil {
		return time.Time{}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.since
}
