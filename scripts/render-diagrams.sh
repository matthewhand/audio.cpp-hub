#!/usr/bin/env bash
# Render / validate the diagram set.
#
# Diagrams are authored as self-contained HTML (inline SVG) and are the
# editable source of truth. This script validates them and optionally exports
# PNG/SVG previews.
#
# Usage:
#   scripts/render-diagrams.sh validate     # run the skill's self-check + geometry check
#   scripts/render-diagrams.sh png          # export every diagram to previews/*.png
#   scripts/render-diagrams.sh svg          # export every diagram to previews/*.svg
#   scripts/render-diagrams.sh serve        # serve docs/diagrams over HTTP for review
#
# Dependencies for `png`/`svg`: a headless Chromium (via `chromium`,
# `google-chrome`, or `npx playwright`) for rasterising, and `curl` for serve.
# Validation only needs Python 3.
set -euo pipefail

DIAGRAM_DIR="docs/diagrams"
PREVIEW_DIR="${DIAGRAM_DIR}/previews"
SKILL_SCRIPTS="${DIAGRAM_DESIGN_SCRIPTS:-$HOME/.pi/agent/git/github.com/cathrynlavery/diagram-design/scripts}"

cmd="${1:-validate}"
mkdir -p "$PREVIEW_DIR"

validate() {
  echo "== self_check =="
  for f in "$DIAGRAM_DIR"/*.html; do
    printf "%-48s " "$f"
    python3 "$SKILL_SCRIPTS/../scripts/self_check.py" "$f" 2>/dev/null \
      || python3 "$HOME/.config/opencode/skills/diagram-design/scripts/self_check.py" "$f"
  done
  echo "== verify-geometry =="
  if [[ -f "$SKILL_SCRIPTS/verify-geometry.py" ]]; then
    for f in "$DIAGRAM_DIR"/*.html; do
      printf "%-48s " "$f"
      python3 "$SKILL_SCRIPTS/verify-geometry.py" "$f" | tail -1
    done
  else
    echo "verify-geometry.py not found at $SKILL_SCRIPTS — skipping (set DIAGRAM_DESIGN_SCRIPTS)"
  fi
}

# Extract the inline <svg>…</svg> block and wrap it in a bare document so the
# export contains the diagram only (no editorial chrome), per the skill.
extract_svg() {
  awk '/<svg /{p=1} p{print} /<\/svg>/{if(p){exit}}' "$1"
}

export_one() {
  local src="$1" out="$2" fmt="$3" tmp
  tmp="$(mktemp --suffix=.html)"
  { echo '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0}svg{display:block}</style></head><body>';
    extract_svg "$src"; echo '</body></html>'; } > "$tmp"
  if [[ "$fmt" == "svg" ]]; then
    python3 - "$tmp" "$out" <<'PY'
import sys, re
html = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r"<svg.*?</svg>", html, re.S)
open(sys.argv[2], "w", encoding="utf-8").write(m.group(0) if m else html)
PY
  else
    if command -v chromium >/dev/null; then chromium --headless --disable-gpu \
        --screenshot="$out" --window-size="${WIDTH:-1400},${HEIGHT:-900}" "$tmp" 2>/dev/null
    elif command -v google-chrome >/dev/null; then google-chrome --headless --disable-gpu \
        --screenshot="$out" --window-size="${WIDTH:-1400},${HEIGHT:-900}" "$tmp" 2>/dev/null
    else echo "no chromium/google-chrome found for PNG export" >&2; rm -f "$tmp"; return 1; fi
  fi
  rm -f "$tmp"
}

export() {
  local fmt="$1"
  for f in "$DIAGRAM_DIR"/*.html; do
    base="$(basename "$f" .html)"
    printf "%-48s -> %s/%s.%s\n" "$f" "$PREVIEW_DIR" "$base" "$fmt"
    export_one "$f" "$PREVIEW_DIR/$base.$fmt" "$fmt"
  done
}

serve() {
  ( cd "$DIAGRAM_DIR" && python3 -m http.server "${PORT:-8099}" )
}

case "$cmd" in
  validate) validate ;;
  png|svg)  export "$cmd" ;;
  serve)    serve ;;
  *) echo "unknown command: $cmd (validate|png|svg|serve)" >&2; exit 2 ;;
esac
