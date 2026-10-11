# Issue #139 — responsive header QA evidence

These are **actual headless Chromium captures**, not generated design mockups.
The "after" captures come from a **local isolated static-server source preview
with a mocked backend**; they do not prove a production rollout. The History
dialog screenshot was taken after its opening opacity transition settled.

| Screenshot | Provenance | Viewport |
| --- | --- | --- |
| [Live Qwen3 before](live-qwen-before-390.png) | Running ubuntu-max :18081, read-only | 390 × 844 |
| [Source before](source-before-320.png) | Clean main at b5d8157, mocked API | 320 × 720 |
| [Patch after](patch-after-320.png) | Issue #139 isolated source, mocked API | 320 × 720 |
| [Patch after 390](patch-after-390.png) | Issue #139 isolated source, mocked API | 390 × 844 |
| [History modal after](patch-history-after-320.png) | Issue #139 isolated source, modal open | 320 × 720 |
| [Desktop after](patch-after-1366.png) | Issue #139 isolated source, mocked API | 1366 × 768 |

At 320 px, clean main reached document scrollWidth=343; the patched source
reached scrollWidth=320. The live Qwen3 deployment previously reached 496px
at a 390px viewport, while the isolated patched source reached 390px.
This live/source comparison includes deployment drift; do not attribute
the entire 390px improvement to the new 320px-only source rule.

## Reproduce

Run PORT=4173 npm run test:e2e with the repository's dev dependencies and
Playwright Chromium browser installed. e2e/issue-139-header-overflow.spec.mjs
exercises 320/359/360/390/768/1366/1920 px and the header, History, Stats, theme,
language and mobile drawer, plus mocked 320/390 px TTS and playback. Tests use MockBackend and do not synthesize audio,
restart containers or mutate deployed services.

The full set of 12 initial four-host deployment screenshots and additional
local regression screenshots/metrics remain archived on teamstinky under
/home/chatgpt/audio-hub-ui-evidence-20261012/.
