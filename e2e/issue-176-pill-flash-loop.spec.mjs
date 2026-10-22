/* #176: once the instance pill settles, motion.js must not keep rewriting its class
   (state-flip feeding its own MutationObserver). Real Chromium, real MutationObserver. */
import { test, expect } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

const READY = {
  id: "i1",
  modelId: "supertonic",
  instanceName: "Studio box",
  status: "READY",
  backend: "cpu",
  device: 0,
  port: 19001,
  taskCount: 0
};

test("instance pill stops flashing after a status change", async ({ page }) => {
  await openApp(page, new MockBackend({ instances: [READY] }), {
    modelId: "supertonic",
    lang: "en"
  });
  const pill = page.locator("#instance-pill");
  await expect(pill).toHaveClass(/ok/);
  await page.waitForTimeout(1500);
  const flips = await pill.evaluate(
    (el) =>
      new Promise((resolve) => {
        let n = 0;
        const ob = new globalThis.MutationObserver((recs) => {
          for (const r of recs) if (r.attributeName === "class") n++;
        });
        ob.observe(el, { attributes: true, attributeFilter: ["class"] });
        globalThis.setTimeout(() => {
          ob.disconnect();
          resolve({ n, flip: el.classList.contains("state-flip") });
        }, 3000);
      })
  );
  expect(flips.flip).toBe(false);
  expect(flips.n).toBeLessThanOrEqual(6);
});
