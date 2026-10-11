/* #142: Privacy mode must not serialize private history/task scripts to DOM. */
/* global document, window, StorageEvent */
import { expect, test } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

const secret = "PRIVATE_SCRIPT_NEVER_IN_DOM_142";

test("history privacy hides script in visible content and all DOM attributes", async ({ page }) => {
  const backend = new MockBackend({
    instances: [
      {
        id: "i1",
        modelId: "supertonic",
        instanceName: "supertonic",
        status: "READY",
        backend: "cpu",
        device: 0,
        port: 19001,
        taskCount: 0
      }
    ],
    history: {
      supertonic: [
        {
          taskId: "secret-142",
          time: Date.now(),
          text: secret,
          ok: true,
          result: { durationSec: 1.2, size: 48044 },
          instanceName: "supertonic",
          groupId: null
        }
      ]
    },
    groups: { supertonic: [] }
  });
  await openApp(page, backend, { modelId: "supertonic", lang: "en" });
  await page.locator("#history-btn").click();
  const list = page.locator("#history-list");
  await expect(list).toContainText(secret);

  await page.locator("#history-privacy").click();
  await expect(list).not.toContainText(secret);
  expect(await page.evaluate((value) => document.body.outerHTML.includes(value), secret)).toBe(
    false
  );
  expect(
    await page.evaluate(
      (value) =>
        [...document.querySelectorAll("[data-real-text], [title], [aria-label]")].some((node) =>
          [...node.attributes].some((attr) => attr.value.includes(value))
        ),
      secret
    )
  ).toBe(false);

  await page.locator("#history-privacy").click();
  await expect(list).toContainText(secret);

  // A privacy change in another tab must immediately refresh cached rows.
  await page.evaluate(() => {
    localStorage.setItem("hub-privacy", "1");
    window.dispatchEvent(new StorageEvent("storage", { key: "hub-privacy" }));
  });
  await expect(list).not.toContainText(secret);
  expect(await page.evaluate((value) => document.body.outerHTML.includes(value), secret)).toBe(
    false
  );
});
