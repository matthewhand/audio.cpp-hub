# Authoring diagrams

Each diagram is a **single self-contained HTML file** with inline SVG and embedded CSS, following the
[`diagram-design`](../../.worktrees/diagrams) skill (installed copy:
`~/.config/opencode/skills/diagram-design`) plus the project monochrome skin in [`style-guide.md`](style-guide.md).

## Quick start

1. Copy [`_scaffold.html`](_scaffold.html) to `<slug>.html`.
2. Replace the `__TITLE__` / `__EYEBROW__` / `__H1__` / `__SUBTITLE__` / `__DESC__` / `__SLUG__` placeholders.
   `__SLUG__` must equal the filename stem (used for `aria-labelledby` IDs).
3. Replace the SVG body (keep the `<style>`, `<defs>` markers, and a11y wrapper).
4. Cite the source files in the summary cards and in [`INVENTORY.md`](INVENTORY.md).
5. Validate, then render the PNG preview:
   ```bash
   python3 /tmp/dd-skill/scripts/self_check.py <slug>.html
   node render.mjs            # writes assets/<slug>.png and assets/<slug>-dark.png
   ```

## Hard rules

- **Content is derived from the repository only.** Never invent a component or flow. Mark inferred behavior
  with an explicit assumption note in the cards / inventory.
- **Accessibility contract:** `<svg role="img" aria-labelledby="<slug>-title <slug>-desc">`, `<title>` is the
  first child of `<svg>` before `<defs>`, both `<title>` and `<desc>` are filled and prefixed.
- **Light + dark in one file.** Use the CSS custom properties; never hardcode hex in SVG attributes.
  (`color`/`fill` accept `var(--ink)` only via the classes in the scaffold's `<style>`.)
- **4px grid.** Every coordinate, font size, node size, and gap is divisible by 4.
- **Orthogonal connectors only.** `r=8` elbows; diagonal `<line>` between off-axis nodes is a hard fail.
  Straight `<line>` only when endpoints share an x or y.
- **Arrow labels** always have an opaque `mask` rect and a 6–10px visible gap above the stroke.
- **No overlapping connectors**, no shared attach points on an edge (≥12px apart), no transit behind a
  non-endpoint node.
- **Complexity budget:** ≤9 nodes, ≤12 arrows, ≤2 focal (`.n.focal`) elements.
- **Language:** Chinese-first labels; technical sublabels in English/Geist Mono. Keep both languages in the
  `<title>`/`<desc>`.

## SVG class reference (from `_scaffold.html`)

| Class | Applies to | Meaning |
|---|---|---|
| `bg` | full-page rect | paper |
| `mask` | rect under nodes / arrow labels | opaque paper (prevents bleed-through) |
| `zone`, `zone-mask` | rect + tag mask | trust/network/environment boundary |
| `n` | node rect | default component |
| `n focal` | node rect | 1–2 focal elements (solid ink) |
| `n store` | node rect | persistent store |
| `n ext` | node rect | external / third-party |
| `n input` | node rect | user / client input |
| `n async` | node rect | optional / async |
| `tag` | small rx=2 rect | type tag outline |
| `name`, `sub` | text | node name (sans) / sublabel (mono) |
| `eyebrow-svg` | text | zone + legend labels |
| `alabel` | text | arrow labels |
| `data`, `data dash`, `data accent` | path | connector stroke variants |
| `lifeline`, `act`, `frame`, `divider` | sequence primitives | lifelines, activation bars, fragments |
| `mk`, `mk-a`, `mk-open` | marker polygon/polyline | filled muted / filled accent / open async |

## Validation

- `self_check.py` verifies the accessible-SVG contract, single-file safety (no remote assets beyond Google
  Fonts), and motion basics. It must pass for every file.
- Visually inspect the rendered PNG for clipped text, crossed lines, and labels touching strokes.

## Source of truth for each diagram

See [`INVENTORY.md`](INVENTORY.md) for the per-diagram type, audience, question, source files, confidence, and
assumptions. Keep the inventory in sync when a diagram changes.
