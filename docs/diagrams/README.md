# Architecture & operations diagrams

A coherent visual documentation set for **audio.cpp-hub** (Go rewrite), derived from the repository at
`feat/go-magpie-tts`. Every diagram is hand-authored SVG in a **single self-contained HTML file** — open it in
a browser, no build step. PNG previews (light + dark) are in [`assets/`](assets).

> Content is sourced from the actual code. Anything inferred is flagged as an assumption in
> [`INVENTORY.md`](INVENTORY.md). The set follows the `diagram-design` skill with a project **monochrome
> skin** ([`style-guide.md`](style-guide.md)) derived from the app's own UI.

![Overall architecture](assets/hero-overview.png)

## Index

| Diagram | Type | Audience | Answers |
|---|---|---|---|
| [hero-overview](hero-overview.html) · [png](assets/hero-overview.png) | Architecture | everyone | What the project is; clients, boundary, engine, weights |
| [system-architecture](system-architecture.html) · [png](assets/system-architecture.png) | Architecture | dev / contributor | The hub's runtime components and how they connect |
| [deployment-docker](deployment-docker.html) · [png](assets/deployment-docker.png) | Deployment | operator | Host vs container: devices, ports, volumes, artifacts |
| [deployment-modes](deployment-modes.html) · [png](assets/deployment-modes.png) | Deployment | operator | Native/systemd vs Docker bridge vs LXC host-network |
| [seq-tts-task](seq-tts-task.html) · [png](assets/seq-tts-task.png) | Sequence | dev / operator | Async TTS task, queue → engine → history |
| [seq-openai-proxy](seq-openai-proxy.html) · [png](assets/seq-openai-proxy.png) | Sequence | integrator | `/v1/*` transparent proxy path |
| [seq-instance-lifecycle](seq-instance-lifecycle.html) · [png](assets/seq-instance-lifecycle.png) | Sequence | operator | Starting and stopping a model child process |
| [seq-download](seq-download.html) · [png](assets/seq-download.png) | Sequence | operator | Segmented weight download with resume |
| [seq-auth](seq-auth.html) · [png](assets/seq-auth.png) | Sequence | security | AuthN/AuthZ — **there is none, by design** |
| [seq-failure-recovery](seq-failure-recovery.html) · [png](assets/seq-failure-recovery.png) | Sequence | operator | Timeouts, cancel, restart replay |
| [integration-external](integration-external.html) · [png](assets/integration-external.png) | DP integration | integrator | HF / mirrors / ModelScope / engine / clients |
| [data-flow](data-flow.html) · [png](assets/data-flow.png) | Data flow | dev / operator | How data enters, transforms, persists, exits |
| [security-boundaries](security-boundaries.html) · [png](assets/security-boundaries.png) | Architecture (secure paved road) | security | Trust zones, permitted vs forbidden ingress |
| [ops-startup-shutdown-health](ops-startup-shutdown-health.html) · [png](assets/ops-startup-shutdown-health.png) | Process | operator | Boot, health, warm-up, graceful stop, logs |
| [state-machines](state-machines.html) · [png](assets/state-machines.png) | State machine | dev / operator | Instance and task state lifecycles |
| [data-model](data-model.html) · [png](assets/data-model.png) | ER | dev | Persisted artifacts and their relationships |
| [dependency-graph](dependency-graph.html) · [png](assets/dependency-graph.png) | Dependency | dev | Go package/module dependencies |
| [ui-information-architecture](ui-information-architecture.html) · [png](assets/ui-information-architecture.png) | Tree | user / contributor | Web UI structure and i18n coverage |
| [ci-release-pipeline](ci-release-pipeline.html) · [png](assets/ci-release-pipeline.png) | Process | maintainer | CI gates and the tag release pipeline |

## Conventions

- **Skin:** monochrome, derived from `web/style.css`. Colors are CSS custom properties; the accent is ink
  (focal = solid ink fill). No link-blue — HTTP is signalled by a dashed arrow + protocol label.
- **Status colors** (`--ok` / `--warn` / `--err`) appear only in `state-machines` and ops outcomes.
- **Light/dark:** every file renders both via `@media (prefers-color-scheme: dark)`. The static frame is the
  source of truth; no JavaScript is required to read any diagram.
- **Accessibility:** every `<svg>` is `role="img"` with a prefixed `<title>`/`<desc>`; labels are text, not
  paths.
- **Geometry:** 4px grid, orthogonal `r=8` connectors, masked arrow labels with a visible gap, ≥12px between
  attach points on a shared edge. Budget: ≤9 nodes / ≤12 arrows / ≤2 focal elements per diagram.
- **Language:** Chinese-first labels with English/Geist-Mono technical sublabels.

## Editing & regenerating

1. Open a diagram's `.html` and edit the inline SVG. Start from [`_scaffold.html`](_scaffold.html) for a new
   one; see [`CONTRIBUTING.md`](CONTRIBUTING.md) for the class reference and rules.
2. Validate the a11y / single-file contract:
   ```bash
   python3 ~/.config/opencode/skills/diagram-design/scripts/self_check.py <slug>.html
   ```
3. Re-render the PNG previews (light + dark, diagram only):
   ```bash
   cd docs/diagrams
   npm i -D playwright            # once
   PLAYWRIGHT_BROWSERS_PATH=<browser-cache> node render.mjs
   ```
   `render.mjs` writes `assets/<slug>.png` and `assets/<slug>-dark.png` at 2× scale.

## Source references

Each diagram cites its source files in the summary cards next to the SVG and in
[`INVENTORY.md`](INVENTORY.md). Key sources: `main.go`, `api.go`, `instance.go`, `task.go`, `download.go`,
`history.go`, `voices.go`, `proxy.go`, `registry.go`, `packages.go`, `models.go`, `internal/*`,
`Dockerfile.amd`, `compose.amd.yaml`, `docker/start-*.sh`, `.github/workflows/*`, `web/*`.

## Assumptions & limitations

- The set documents the **Go** implementation only; the retired Java version is intentionally absent.
- Deployment diagrams describe the maintainer's representative AMD/Vulkan and LXC topologies; per-host
  values (device index, GIDs, host paths) come from `.env`/`compose` and may differ.
- `security-boundaries` applies the skill's "secure paved road" pattern to the code's actual controls; it is
  **not** a formal threat model. The product has **no authentication** — see `SECURITY.md`.
- Data-model and dependency diagrams use logical groupings to respect the node budget; they are not exhaustive.
- Diagrams are documentation, not tests — they will drift if the code changes. Update them with the same PR
  that changes the behavior they describe.
