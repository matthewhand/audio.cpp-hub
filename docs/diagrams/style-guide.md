# Diagram style guide — audio.cpp-hub monochrome skin

Single source of truth for diagram colors and typography. This is a **project customization** of the
`diagram-design` skill: the shipped editorial skin (white-smoke + atomic-tangerine) is replaced with a
monochrome skin derived from the product's own UI (`web/style.css`), so diagrams read as part of the app.

All diagrams are self-contained HTML with inline SVG. Colors are CSS custom properties; **never hardcode a
hex value in an SVG attribute** — use the semantic classes defined in `_scaffold.html`.

## Semantic roles

| Role | Light | Dark | Use |
|---|---|---|---|
| `paper` | `#f6f6f7` | `#0c0c0e` | Page + node mask background |
| `paper-2` | `#ffffff` | `#141416` | Default node fill, cards |
| `ink` | `#17181c` | `#ededf0` | Primary text, primary stroke |
| `muted` | `#6d6d75` | `#8e8e96` | Secondary text, default arrows |
| `soft` | `#9a9aa4` | `#5f5f68` | Eyebrows, sublabels, boundary labels |
| `rule` | `rgba(23,24,28,0.12)` | `rgba(255,255,255,0.14)` | Hairlines |
| `rule-solid` | `#e0e0e4` | `#2a2a2e` | Stronger borders |
| `accent` | `#17181c` | `#ededf0` | **1–2 focal elements max** (focal = solid ink fill) |
| `accent-contrast` | `#ffffff` | `#111114` | Text on a focal node |
| `accent-tint` | `rgba(23,24,28,0.06)` | `rgba(237,237,240,0.10)` | Focal tint (rare; prefer solid focal) |
| `ok` / `warn` / `err` | `#059669` / `#d97706` / `#dc2626` | `#34d399` / `#fbbf24` / `#f87171` | **Status only** (state machines, ops outcomes) |

### Deliberate deviations from the skill default

- **No link-blue.** The product is strictly monochrome. The skill's `link` role (HTTP/API arrows) is rendered
  as a **dashed `muted` arrow with an explicit protocol label** (e.g. `HTTPS :443`, `HTTP :18080`). Network
  meaning is carried by the label + dash, never by hue.
- **Focal = solid ink fill, not a tint.** Because the accent equals ink, a focal node is dark-filled with
  `accent-contrast` text; this keeps the 1–2 focal rule legible without introducing color.
- **Status colors are opt-in and only in state/ops diagrams.** Architecture, deployment, data, and sequence
  diagrams stay fully grayscale.

## Typography

| Role | Family | Size | Weight |
|---|---|---|---|
| Page H1 | Instrument Serif | 28px (1.75rem) | 400 |
| Node name | Geist / Noto Sans SC | 12px | 600 |
| Sublabel (ports, paths, types) | Geist Mono | 9px | 400 |
| Eyebrow / zone tag | Geist Mono | 7–8px, tracked, uppercase | 500 |
| Arrow label | Geist Mono | 8px, tracked | 400 |
| Editorial aside | Instrument Serif *italic* | 14px | 400 |

Chinese labels use **Noto Sans SC at 12px+** (Geist has no Han glyphs). Human-readable names go in the sans
family; ports/URLs/commands go in mono.

## Light/dark behavior

One file renders correctly in both: tokens flip under `@media (prefers-color-scheme: dark)`. **Never** ship a
light-only or dark-only diagram. The static frame is the source of truth; no JS is required for meaning.

## Geometry rules (non-negotiable)

- 4px grid for every coordinate, size, and gap.
- Rounded right-angle (orthogonal) connectors only — `r=8`, never diagonal `<line>` between off-axis nodes.
- Arrow labels always have an opaque `paper` mask and a **6–10px visible gap** above the stroke.
- No overlapping connectors; two connectors never share an attach point on a box edge (≥12px apart).
- Zones are drawn first (bg → zones → arrows → labels → nodes).
- Complexity budget per diagram: **≤9 nodes, ≤12 arrows, ≤2 focal elements.**
