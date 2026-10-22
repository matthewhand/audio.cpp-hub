/* Issue #121: truthful optional memory readings and live working status. */
import { expect, test } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

function instance(memory, taskCount = 0) {
  return {
    id: "i1",
    modelId: "supertonic",
    instanceName: "Synthetic instance",
    status: "READY",
    backend: "cpu",
    device: 0,
    port: 19001,
    taskCount,
    ...(memory ? { memory } : {})
  };
}

test("memory card shows current/peak/average bars without fabricating unknown VRAM", async ({
  page
}) => {
  await openApp(
    page,
    new MockBackend({
      instances: [
        instance(
          {
            ramBytes: 10485760,
            ramPeakBytes: 20971520,
            ramAvgBytes: 15728640,
            vramPeakBytes: 8388608,
            vramAvgBytes: 4194304
          },
          1
        )
      ]
    }),
    { modelId: "supertonic", lang: "en" }
  );
  const card = page.locator("#instance-list .card").first();
  // #174: RAM renders as a bar with peak/avg markers; VRAM has no current reading, so no row.
  const ram = card.locator(".mem .mem-row").first();
  await expect(ram.locator(".mem-l .v")).toHaveText("10 MiB");
  await expect(ram.locator(".stats3")).toHaveText("Peak 20 · Avg 15 MiB");
  await expect(ram.locator('[role="meter"]')).toHaveAttribute(
    "aria-label",
    "RAM 10 MiB now, peak 20, average 15 MiB"
  );
  await expect(card.locator(".mem .mem-row")).toHaveCount(1);
  await expect(card.locator(".fill.vram")).toHaveCount(0);
  // Bar geometry is applied via CSSOM (CSP blocks inline style): fill 10/(20*1.25) = 40%.
  expect(await ram.locator(".fill.ram").evaluate((el) => el.style.width)).toBe("40%");
  await expect(card).toContainText("Generating");
});

test("older hubs without memory payload do not show fictitious metrics", async ({ page }) => {
  await openApp(page, new MockBackend({ instances: [instance(null)] }), {
    modelId: "supertonic",
    lang: "en"
  });
  const card = page.locator("#instance-list .card").first();
  await expect(card.locator(".mem")).toHaveCount(0);
  await expect(card).not.toContainText("Peak");
});

test("cards keep a stable order across polls regardless of selection (#174)", async ({ page }) => {
  const base = { modelId: "supertonic", status: "READY", backend: "cpu", device: 0, taskCount: 0 };
  await openApp(
    page,
    new MockBackend({
      instances: [
        { ...base, id: "b", instanceName: "Beta", port: 19002, createdAt: "2026-01-01T00:00:02Z" },
        { ...base, id: "a", instanceName: "Alpha", port: 19001, createdAt: "2026-01-01T00:00:01Z" },
        { ...base, id: "c", instanceName: "Gamma", port: 19003, createdAt: "2026-01-01T00:00:03Z" }
      ]
    }),
    { modelId: "supertonic", lang: "en" }
  );
  const titles = page.locator("#instance-list .card .card-title");
  await expect(titles).toHaveCount(3);
  const first = await titles.allInnerTexts();
  expect(first.map((t) => t.split(/\s+/)[0])).toEqual(["Alpha", "Beta", "Gamma"]);
  await page.selectOption("#instance-select", "c");
  await expect(page.locator("#instance-list .card.selected .card-title")).toContainText("Gamma");
  const after = await titles.allInnerTexts();
  expect(after.map((t) => t.split(/\s+/)[0])).toEqual(["Alpha", "Beta", "Gamma"]);
});
