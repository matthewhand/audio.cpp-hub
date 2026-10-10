/* Issue #124: reproducible source-based before/after UI screenshots.
   The baseline restores only this issue's CSS changes; both renders use
   the real frontend and deterministic API mocks, never the live GPU service. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { openApp } from "./helpers.mjs";
import { MockBackend } from "./mock-backend.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const changedCss = fs.readFileSync(path.resolve(here, "../web/style.css"), "utf8");

function baselineCss(css) {
  let result = css;
  const undo = (updated, original) => {
    if (!result.includes(updated)) throw new Error("Issue #124 CSS anchor changed");
    result = result.replace(updated, original);
  };
  undo("#workspace { max-width: 960px; margin: 0 auto; }", "#workspace { max-width: 860px; margin: 0 auto; }");
  undo("#instance-bar {\n  display: flex;\n  flex-wrap: wrap;", "#instance-bar {\n  display: flex;");
  undo("  border: 1px solid var(--card-border);\n  border-left: 3px solid var(--accent);\n  border-radius: 12px;\n  box-shadow: var(--shadow);\n  backdrop-filter: blur(10px);\n  -webkit-backdrop-filter: blur(10px);\n}\n.bar-label", "  border: 1px solid var(--card-border);\n  border-radius: 12px;\n  box-shadow: var(--shadow);\n  backdrop-filter: blur(10px);\n  -webkit-backdrop-filter: blur(10px);\n}\n.bar-label");
  undo("#instance-select { min-width: 0; flex: 1 1 210px; margin-top: 0; }", "#instance-select { flex: 1; margin-top: 0; }");
  undo(`#panel-tts{padding:var(--space-6)}
#panel-tts>h2{margin-top:0;font-size:var(--text-xl)}
#tts-text{min-height:176px;padding:var(--space-4);font-size:15px;line-height:1.7}
@media(max-width:720px){
  #panel-tts{padding:var(--space-4)}
  #tts-text{min-height:160px}
  #tts-submit{width:100%}
}
`, "");
  return result;
}

test("issue #124: baseline vs improved TTS workspace (desktop and mobile)", async ({ browser }, testInfo) => {
  for (const layout of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 }
  ]) {
    for (const variant of ["before", "after"]) {
      const context = await browser.newContext({
        viewport: { width: layout.width, height: layout.height },
        deviceScaleFactor: 1,
        serviceWorkers: "block"
      });
      const page = await context.newPage();
      if (variant === "before") {
        await page.route("**/style.css", (route) =>
          route.fulfill({ status: 200, contentType: "text/css; charset=utf-8", body: baselineCss(changedCss) })
        );
      }
      const backend = new MockBackend({
        instances: [
          { id: "breeze1", instanceName: "Breeze TTS 2", modelId: "breeze-tts", status: "READY", backend: "vulkan", device: 0, port: 18090, taskCount: 0 },
          { id: "sano1", instanceName: "SanoTTS", modelId: "sanotts", status: "READY", backend: "vulkan", device: 0, port: 18091, taskCount: 0 }
        ]
      });
      await openApp(page, backend, { modelId: "breeze-tts", lang: "en", theme: "light" });
      await expect(page.locator("#panel-tts")).toBeVisible();
      await expect(page.locator("#instance-pill")).toHaveClass(/ok/);
      await page.locator("#tts-text").fill(
        "The morning light enters quietly through the window. Each word finds its own rhythm, and the voice follows."
      );
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      await testInfo.attach(`issue124-${variant}-${layout.name}.png`, {
        body: await page.screenshot({ animations: "disabled", fullPage: true }),
        contentType: "image/png"
      });
      await context.close();
    }
  }
});
