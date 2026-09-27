# Visual documentation — audio.cpp-hub

A coherent diagram set derived from the actual repository (Go implementation,
`main`). Each diagram is a single self-contained HTML file with inline SVG, so
it renders in any browser and is directly editable.

**Start here:** [`INVENTORY.md`](INVENTORY.md) records every diagram's type,
audience, the question it answers, the source files it was built from,
confidence level, and any assumptions.

> Ground rule used throughout: nothing is invented. Every component, port,
> path, constant, and state name traces to a source file (cited in the
> inventory and in each `<desc>`). Anything inferred is marked in
> `INVENTORY.md`.

## Index

| File | Type | Audience | Answers |
|---|---|---|---|
| [`01-hero.html`](01-hero.html) | Architecture (hero) | README / newcomers | What is this, for whom, what does it wrap? |
| [`02-system-architecture.html`](02-system-architecture.html) | Architecture | Developers | What are the runtime components, stores, boundaries? |
| [`03-deployment.html`](03-deployment.html) | Deployment | Operators | Where does it run (native vs Docker), ports, mounts, devices? |
| [`04-integration.html`](04-integration.html) | Integration / dependency | Developers, operators | What external systems and protocols are involved? |
| [`05-data-flow.html`](05-data-flow.html) | Data flow | Developers | How does payload data enter, transform, persist, expire? |
| [`06-security-boundaries.html`](06-security-boundaries.html) | Layer stack / trust zones | Operators, security | What are the trust zones, credentials, unauthenticated surfaces? |
| [`07-seq-http-api.html`](07-seq-http-api.html) | Sequence | Developers | Normal API request (and why there is no authn step) |
| [`08-seq-core-tts.html`](08-seq-core-tts.html) | Sequence | Developers | Core op: TTS end-to-end with history extraction |
| [`09-seq-proxy.html`](09-seq-proxy.html) | Sequence | Developers / integrators | OpenAI-compatible `/v1/*` routing by `model` |
| [`10-seq-download.html`](10-seq-download.html) | Sequence | Operators | Weight download: probe → segments → resume |
| [`11-seq-failure.html`](11-seq-failure.html) | Sequence | Developers, ops | Failure / retry / timeout / recovery paths |
| [`12-operations.html`](12-operations.html) | Process / runbook | Operators | Startup, shutdown, health, backup, diagnosis |
| [`13-state-instance-task.html`](13-state-instance-task.html) | State machine | Developers | Instance and task lifecycles |
| [`14-data-model.html`](14-data-model.html) | ER / data model | Developers | On-disk entities and their relationships |

## Design system

Diagrams use the Diagram Design editorial skin at its **shipped default**
(neutral white-smoke paper, jet-black ink, atomic-tangerine accent, blue-slate
muted). Typography: Instrument Serif (titles), Geist (human-readable labels),
Geist Mono (ports, paths, constants — technical content only).

Conventions held across the set:

- **Colour roles** — `accent` (coral) marks at most 1–2 focal elements per
  diagram; `link`-blue is external HTTP/API; muted is internal; dashed is
  return / async / passive.
- **Node shapes** — white + ink stroke = hub component; ink-wash = store/state;
  3% wash + 30% stroke = external; dashed-accent = security/optional.
- **Boundaries** — dashed zone rects with a mono uppercase eyebrow on a
  paper-coloured mask.
- **Connectors** — rounded orthogonal elbows only (no diagonal slants);
  every arrow label sits 6–10px clear of its stroke on an opaque mask; no
  overlapping strokes; distinct attach points when several lines share an edge.
- **Accessibility** — every SVG is `role="img"` with a prefixed `<title>` and
  a content-describing `<desc>`, per the skill's accessible-SVG contract.

Light theme is the default. The skill also supports a dark variant per diagram
(`*-dark.html`); these were not generated — see *Recommended future diagrams*.

## Regenerating / editing

Edit the HTML files directly; the inline `<svg>` is the source of truth.

```bash
# Validate every diagram (self-check contract + connector geometry) — needs Python 3 only
scripts/render-diagrams.sh validate

# Export diagram-only PNGs / SVGs into docs/diagrams/previews/
scripts/render-diagrams.sh png
scripts/render-diagrams.sh svg

# Review locally
scripts/render-diagrams.sh serve        # http://127.0.0.1:8099
```

`validate` uses the Diagram Design skill scripts. It auto-discovers them; if
they live elsewhere, set `DIAGRAM_DESIGN_SCRIPTS=/path/to/skill/scripts`.
PNG/SVG export needs a headless Chromium; validation does not.

## Source references

Every diagram is cross-checked against:

`main.go` · `api.go` · `instance.go` · `task.go` · `history.go` · `voices.go` ·
`download.go` · `packages.go` · `proxy.go` · `registry.go` · `audio.go` ·
`fs.go` · `constants.go` · `util.go` · `internal/wav` · `internal/idvalidate` ·
`web/` (frontend) · `docs/API.md` · `SECURITY.md` · `DOCKER.md` ·
`compose.yaml` · `compose.amd.yaml` · `Dockerfile.amd` ·
`docker/start-hub.sh` · `docker/start-instance.sh` · `hub.config.example.json` ·
`executables.json.example` · `README.md` · `.github/workflows/`.

## Assumptions and limitations

- **Style = default skin.** The user chose the shipped default palette over a
  brand match; switch to a saved profile if a client skin is wanted.
- **No dark variants generated.** The skill supports them; add per need.
- **macOS release** is documented in `README.md` but was not verified against a
  workflow file in this pass — marked `[inferred]` in diagram 3.
- **Windows tray** is shown only as a host behaviour, not as architecture.
- **`internal/wav`** is grouped into one node in the data-flow diagram.
- Diagrams describe the **system as coded**, not a deployment instance; the
  concrete ports shown (8080/18080, 18090+) come from the example config.

## Recommended future diagrams

- **Dark-theme variants** of each diagram (`*-dark.html`) for slide decks.
- **Per-category model matrix** (ER/table) if `models.json` keeps growing.
- **Compose sequence** for the container `start-instance.sh` warm-up path.
- **Threat-model detail** for the `/api/fs/*` + `/api/executables*` write
  surface, if the hub ever gains optional auth.
