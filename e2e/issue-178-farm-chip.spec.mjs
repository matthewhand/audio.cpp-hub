/* #178: header status chip — fan-out farm summary, falling back to this hub's instances. */
/* global document */
import { test, expect } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

const inst = (id, status) => ({
  id,
  modelId: "supertonic",
  instanceName: "Box " + id,
  status,
  backend: "cpu",
  device: 0,
  port: 19000 + Number(id.replace(/\D/g, "") || 1),
  taskCount: 0
});

test.use({ viewport: { width: 1280, height: 720 } });

test("farm summary shows hubs up/total, failures and this hub's label", async ({ page }) => {
  const backend = new MockBackend({
    instances: [inst("i1", "READY")],
    farm: {
      available: true,
      hubsUp: 3,
      hubsTotal: 4,
      failures: 2,
      checkedAt: "2026-10-22T00:00:00Z",
      hubLabel: "studio-a"
    }
  });
  await openApp(page, backend, { modelId: "supertonic", lang: "en" });
  const chip = page.locator("#hub-chip");
  await expect(chip).toBeVisible();
  await expect(page.locator("#hub-chip-text")).toHaveText("Farm 3/4");
  await expect(page.locator("#hub-chip-failures")).toHaveText("2 failures");
  await expect(chip).toHaveClass(/warn/);
  await expect(chip).toHaveClass(/has-fail/);
  await expect(chip).toHaveAttribute("aria-label", "Farm status: Farm 3/4, 2 failures");
  await expect(chip).toHaveAttribute("title", /this hub: studio-a/);
});

test("unavailable farm falls back to this hub's ready/total instances", async ({ page }) => {
  const backend = new MockBackend({ instances: [inst("i1", "READY"), inst("i2", "STARTING")] });
  await openApp(page, backend, { modelId: "supertonic", lang: "en" });
  await expect(page.locator("#hub-chip")).toBeVisible();
  await expect(page.locator("#hub-chip-text")).toHaveText("Hub 1/2 ready");
  await expect(page.locator("#hub-chip")).toHaveClass(/warn/);
});

for (const width of [390, 768]) {
  test(`chip is hidden at ${width}px and never causes horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openApp(page, new MockBackend({ instances: [inst("i1", "READY")] }), {
      modelId: "supertonic",
      lang: "en"
    });
    await expect(page.locator("#hub-chip")).toBeHidden();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
