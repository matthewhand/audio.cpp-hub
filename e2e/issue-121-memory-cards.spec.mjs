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

test("memory card shows current/peak/average without fabricating unknown VRAM", async ({
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
  await expect(card).toContainText("RAM · Current / peak / avg: 10.0 MiB / 20.0 MiB / 15.0 MiB");
  await expect(card).toContainText("VRAM · Current / peak / avg: — / 8.0 MiB / 4.0 MiB");
  await expect(card).toContainText("Generating");
});

test("older hubs without memory payload do not show fictitious metrics", async ({ page }) => {
  await openApp(page, new MockBackend({ instances: [instance(null)] }), {
    modelId: "supertonic",
    lang: "en"
  });
  const card = page.locator("#instance-list .card").first();
  await expect(card).not.toContainText("Current / peak / avg");
});
