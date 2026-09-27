#!/usr/bin/env python3
"""Validate the accessible-SVG contract of docs/diagrams/*.html.

Stdlib only (no third-party deps) so it can run in CI on a bare runner. It is a
focused subset of the diagram-design skill's self_check: it enforces the
contract a reader/assistive technology depends on.

For every `docs/diagrams/*.html` (excluding files that start with `_`, e.g. the
scaffold) it checks:
  1. the root <svg> carries role="img" and an aria-labelledby
  2. aria-labelledby resolves to a <title> and a <desc> that both exist
  3. <title> is the first child of <svg> (before <defs>)
  4. the title/desc ids are prefixed with the file slug (no bare `title`/`desc`)
  5. the only remote reference is the approved Google Fonts stylesheet
  6. no <script> tags (static single-file diagrams)

Usage:  python3 scripts/check-diagrams.py [dir]      (default: docs/diagrams)
Exit 0 when every diagram passes, 1 otherwise.
"""

from __future__ import annotations

import re
import sys
from html.parser import HTMLParser
from pathlib import Path

APPROVED_REMOTE = "https://fonts.googleapis.com/css2"
REMOTE_RE = re.compile(r"(?:https?:)?//[^\"')\s]+", re.IGNORECASE)


class SvgParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.svg_role: str | None = None
        self.svg_labelledby: str | None = None
        self.svg_tag_pos: int = -1
        self.title_id: str | None = None
        self.desc_id: str | None = None
        self.first_svg_child: str | None = None
        self.saw_title_before_defs: bool | None = None
        self.scripts: int = 0
        self.remotes: list[str] = []
        self._inside_svg = False
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "script":
            self.scripts += 1
        for key in ("href", "src"):
            val = a.get(key)
            if val and REMOTE_RE.search(val):
                self.remotes.append(val)
        if tag == "svg":
            self._inside_svg = True
            self.svg_tag_pos = self.getpos()
            self.svg_role = a.get("role")
            self.svg_labelledby = a.get("aria-labelledby")
        elif self._inside_svg and self.first_svg_child is None:
            self.first_svg_child = tag
            if tag == "title":
                self.title_id = a.get("id")
                self._in_title = True
                self.saw_title_before_defs = True
        elif self._inside_svg and tag == "defs" and self.saw_title_before_defs is None:
            self.saw_title_before_defs = False
        elif self._inside_svg and tag == "desc":
            self.desc_id = a.get("id")

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if tag == "svg":
            self._inside_svg = False


def check_file(path: Path) -> list[str]:
    p = SvgParser()
    try:
        p.feed(path.read_text(encoding="utf-8"))
        p.close()
    except Exception as exc:  # noqa: BLE001
        return [f"parse error: {exc}"]

    slug = path.stem
    errs: list[str] = []

    if p.svg_role != "img":
        errs.append('root <svg> must carry role="img"')
    if not p.svg_labelledby:
        errs.append("root <svg> must carry aria-labelledby")

    ids = (p.svg_labelledby or "").split()
    if len(ids) < 2:
        errs.append("aria-labelledby must reference both a <title> and a <desc>")
    else:
        t_id, d_id = ids[0], ids[1]
        if p.title_id != t_id:
            errs.append(f'aria-labelledby title ref "{t_id}" not found as <title id>')
        if p.desc_id != d_id:
            errs.append(f'aria-labelledby desc ref "{d_id}" not found as <desc id>')
        for ident in (p.title_id, p.desc_id):
            if ident in (None, "", "title", "desc"):
                errs.append(f"bare/empty id {ident!r} (must be prefixed with the slug)")
            elif not ident.startswith(slug + "-"):
                errs.append(f"id {ident!r} is not prefixed with the slug {slug}-")

    if p.first_svg_child != "title":
        errs.append("<title> must be the first child of <svg> (before <defs>)")
    if p.saw_title_before_defs is False:
        errs.append("<defs> appears before <title>")

    for ref in p.remotes:
        if not ref.startswith(APPROVED_REMOTE):
            errs.append(f"disallowed remote reference: {ref}")

    if p.scripts:
        errs.append("diagrams must be static (no <script>)")

    return errs


def main() -> int:
    d = Path(sys.argv[1] if len(sys.argv) > 1 else "docs/diagrams")
    files = sorted(f for f in d.glob("*.html") if not f.name.startswith("_"))
    if not files:
        print(f"no diagram html files under {d}")
        return 1
    failed = 0
    for f in files:
        errs = check_file(f)
        if errs:
            failed += 1
            print(f"FAIL {f.name}")
            for e in errs:
                print(f"  - {e}")
        else:
            print(f"OK   {f.name}")
    print(f"\n{len(files) - failed}/{len(files)} diagrams passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
