package main

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
)

const (
	defaultListen        = ":18082"
	defaultPollMs        = 7000
	defaultPollTimeoutMs = 3000
	// Same ceiling as the hub's /api/* body limit (util.go maxBodyBytes): TTS
	// bodies are small, but reference audio may be inlined as base64.
	defaultMaxBodyBytes int64 = 64 << 20
	// defaultMaxInFlightPerTarget bounds concurrent speech forwards per origin
	// target. Hub task queues are serial, so without a cap one noisy agent
	// owns an instance's single engine slot and every other agent queues
	// behind it. Two still lets a client overlap a request with its own
	// cleanup; set it <= 0 to disable the cap entirely.
	defaultMaxInFlightPerTarget = 2
)

// instanceNamePattern mirrors the hub's service-name rule (instance.go
// instanceNamePattern) so a typo in farm.routes.json fails at startup instead
// of turning every request into a 404 from the upstream hub.
var instanceNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// Hub is one polled audio.cpp-hub endpoint. Label is ops-only sugar shown in
// GET /farm/health.
type Hub struct {
	BaseURL string `json:"baseUrl"`
	Label   string `json:"label"`
}

// Target is one candidate backend of a route: a hub plus the service name
// (instanceName) that hub must currently expose READY.
type Target struct {
	Hub          string `json:"hub"`
	InstanceName string `json:"instanceName"`
}

// Route binds the names agents may pass as "model" (aliases) to an ordered
// backend list. Order is failover priority: first usable target wins.
type Route struct {
	Aliases []string `json:"aliases"`
	Targets []Target `json:"targets"`
}

// Config is farm.routes.json. Only Listen/PollIntervalMs/MaxInFlightPerTarget
// are worth tuning; everything else describes the farm topology.
type Config struct {
	Listen               string  `json:"listen"`
	PollIntervalMs       int     `json:"pollIntervalMs"`
	PollTimeoutMs        int     `json:"pollTimeoutMs"`
	MaxBodyBytes         int64   `json:"maxBodyBytes"`
	MaxInFlightPerTarget int     `json:"maxInFlightPerTarget"`
	Hubs                 []Hub   `json:"hubs"`
	Routes               []Route `json:"routes"`

	hubURLs map[string]bool   // known hub base URLs, for target validation
	byAlias map[string]*Route // lower-cased alias -> owning route
}

// LoadConfig reads, defaults and validates a farm.routes.json file.
func LoadConfig(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if err := cfg.normalize(); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return &cfg, nil
}

// normalize applies defaults and builds lookup maps, or explains what is wrong.
func (c *Config) normalize() error {
	c.Listen = strings.TrimSpace(c.Listen)
	if c.Listen == "" {
		c.Listen = defaultListen
	}
	if c.PollIntervalMs <= 0 {
		c.PollIntervalMs = defaultPollMs
	}
	if c.PollTimeoutMs <= 0 {
		c.PollTimeoutMs = defaultPollTimeoutMs
	}
	if c.MaxBodyBytes <= 0 {
		c.MaxBodyBytes = defaultMaxBodyBytes
	}
	// Only an absent (0) key is defaulted: an explicit negative cap is the
	// documented "no cap" escape hatch and must survive normalize.
	if c.MaxInFlightPerTarget == 0 {
		c.MaxInFlightPerTarget = defaultMaxInFlightPerTarget
	}
	if len(c.Hubs) == 0 {
		return fmt.Errorf("hubs is empty")
	}
	if len(c.Routes) == 0 {
		return fmt.Errorf("routes is empty")
	}

	c.hubURLs = make(map[string]bool, len(c.Hubs))
	for i := range c.Hubs {
		c.Hubs[i].BaseURL = strings.TrimRight(strings.TrimSpace(c.Hubs[i].BaseURL), "/")
		if c.Hubs[i].BaseURL == "" {
			return fmt.Errorf("hubs[%d].baseUrl is empty", i)
		}
		if c.hubURLs[c.Hubs[i].BaseURL] {
			return fmt.Errorf("duplicate hub %q", c.Hubs[i].BaseURL)
		}
		c.hubURLs[c.Hubs[i].BaseURL] = true
	}

	c.byAlias = make(map[string]*Route)
	for i := range c.Routes {
		rt := &c.Routes[i]
		if len(rt.Aliases) == 0 {
			return fmt.Errorf("routes[%d].aliases is empty", i)
		}
		if len(rt.Targets) == 0 {
			return fmt.Errorf("routes[%d].targets is empty", i)
		}
		for _, alias := range rt.Aliases {
			alias = strings.TrimSpace(alias)
			if alias == "" {
				return fmt.Errorf("routes[%d] has an empty alias", i)
			}
			key := strings.ToLower(alias)
			if _, dup := c.byAlias[key]; dup {
				return fmt.Errorf("duplicate alias %q", alias)
			}
			c.byAlias[key] = rt
		}
		for j := range rt.Targets {
			t := &rt.Targets[j]
			t.Hub = strings.TrimRight(strings.TrimSpace(t.Hub), "/")
			if !c.hubURLs[t.Hub] {
				return fmt.Errorf("routes[%d].targets[%d].hub %q is not listed in hubs", i, j, t.Hub)
			}
			if !instanceNamePattern.MatchString(t.InstanceName) {
				return fmt.Errorf("routes[%d].targets[%d].instanceName %q is not a valid service name", i, j, t.InstanceName)
			}
		}
	}
	return nil
}

// routeFor resolves an agent-facing model name. Lookup is case-insensitive;
// an empty name never resolves.
func (c *Config) routeFor(alias string) (*Route, bool) {
	if alias == "" {
		return nil, false
	}
	rt, ok := c.byAlias[strings.ToLower(alias)]
	return rt, ok
}

// aliases returns every known alias, sorted, for /v1/models and error hints.
func (c *Config) aliases() []string {
	out := make([]string, 0, len(c.byAlias))
	for _, rt := range c.Routes {
		out = append(out, rt.Aliases...)
	}
	sort.Strings(out)
	return out
}
