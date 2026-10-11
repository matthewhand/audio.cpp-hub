# Issue #146 — mobile modal Close touch-target regression

Actual headless Chromium screenshots of a local **isolated source preview**
with a mocked API. They are not generated designs and **not screenshots of
a production deployment**. The "before" cases use the original clean
GitHub main CSS at **b5d8157**; the "after" cases use the isolated #146
mobile CSS patch with the same source scripts.

| Case | Real Chromium screenshot | Measured Close target |
| --- | --- | --- |
| Settings before, 320px, EN | [Before](settings-before-320-en.png) | 19.69 x 20px |
| Settings after, 320px, EN | [After](settings-after-320-en.png) | 44 x 44px |
| Downloads before, 390px, EN | [Before](downloads-before-390-en.png) | 19.69 x 20px |
| Downloads after, 390px, EN | [After](downloads-after-390-en.png) | 44 x 44px |
| Settings after, 390px, ZH | [After](settings-after-390-zh.png) | 44 x 44px |
| Downloads after, 720px, ZH | [After](downloads-after-720-zh.png) | 44 x 44px |

[Raw screenshot measurements](capture-metrics.json) include bounding-box sizes,
language, source provenance and viewport containment.

The regression spec
[e2e/issue-146-modal-close-targets.spec.mjs](../../../e2e/issue-146-modal-close-targets.spec.mjs)
exercises Settings and Downloads close control dimensions, glyph centering,
and mouse click/close behavior at **320, 359, 360, 390 and 720px** in both
English and Chinese. There are ten focused test cases. It intentionally
uses MockBackend, without running any real TTS, touching model weights or
writing to production history.

Note: #143 separately fixes the unrelated narrow-page header overflow. This
branch is based on clean main and is not dependent on #143; no claims are made
that these screenshots fix #139 or that any live server has been redeployed.
