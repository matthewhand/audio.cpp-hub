/* Direction C: synthetic-only browser contracts (no live model calls). */
import { expect, test } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

const ready = {
  id: "op-ready",
  modelId: "supertonic",
  instanceName: "Synthetic speaker",
  status: "READY",
  backend: "cpu",
  device: 0,
  port: 19001,
  taskCount: 2
};
const starting = {
  id: "op-starting",
  modelId: "index_tts2",
  instanceName: "Synthetic starting",
  status: "STARTING",
  backend: "cpu",
  device: 0,
  port: 19002,
  taskCount: 0
};

async function setup(page, lang = "en") {
  const backend = new MockBackend({ instances: [ready, starting] });
  // All API traffic uses MockBackend, and no cross-origin requests are permitted.
  await page.route("**/*", (route) => {
    const origin = new URL(route.request().url()).origin;
    return origin === (process.env.AUDIO_HUB_TEST_ORIGIN || "http://127.0.0.1:4173")
      ? route.continue()
      : route.abort();
  });
  await openApp(page, backend, { modelId: "supertonic", lang, theme: "dark" });
  await expect(page.locator("#instance-list .badge.ready")).toHaveCount(1);
  return backend;
}

for (const width of [320, 390, 768, 1024, 1366, 1440]) {
  test(
    "operator overview fits at " + width + "px and preserves creator draft",
    async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width <= 390 ? 844 : 900 });
      const backend = await setup(page);
      await page.locator("#tts-text").fill("My unsent local draft");
      await page.locator("#studio-operate").click();
      await expect(page.locator("#operator-workspace")).toBeVisible();
      await expect(page.locator("#operator-styles")).toHaveAttribute(
        "href",
        "/operator-studio.css"
      );
      await expect
        .poll(() => page.locator("#operator-styles").evaluate((node) => Boolean(node.sheet)))
        .toBe(true);
      expect(
        await page
          .locator("#studio-operate")
          .evaluate((node) => node.getBoundingClientRect().height)
      ).toBeGreaterThanOrEqual(44);
      if (width === 390 || width === 1440) {
        await page.screenshot({
          path: testInfo.outputPath("operator-" + width + ".png"),
          animations: "disabled"
        });
      }
      await expect(page.locator("#studio-operate")).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("#studio-create")).toHaveAttribute("aria-pressed", "false");
      await expect(page.locator("#operator-feed-value")).toHaveText("Current");
      await expect(page.locator("#operator-ready-value")).toHaveText("1");
      await expect(page.locator("#operator-model-value")).toHaveText("1");
      await expect(page.locator("#operator-tasks-value")).toHaveText("2");
      await expect(page.locator("#operator-instance-list .operator-row")).toHaveCount(2);
      await expect(page.locator("#operator-instance-overview")).toHaveText(
        "2 instances in current feed"
      );
      await expect(page.locator("#operator-task-summary")).toHaveText(
        "0 local tasks · 0 in progress"
      );
      expect(await page.locator("#operator-instance-details").evaluate((el) => el.open)).toBe(
        width < 1101
      );
      await expect(page.locator("#operator-routing-heading")).toHaveText(
        "Farm routing and failover"
      );
      expect(await page.locator("#panel-tts").evaluate((el) => el.inert)).toBe(true);
      expect(
        await page.evaluate(() => globalThis.document.documentElement.scrollWidth)
      ).toBeLessThanOrEqual(width + 1);
      await page.locator("#operator-activity-open").click();
      await expect(page.locator("#activity-queue-panel")).toBeVisible();
      await page.locator("#studio-create").click();
      await expect(page.locator("#panel-tts")).toBeVisible();
      await expect(page.locator("#tts-text")).toHaveValue("My unsent local draft");
      await expect(page.locator("#operator-workspace")).toBeHidden();
      if (width <= 390) {
        await page.locator("#menu-toggle").click();
        await expect(page.locator("#left")).toHaveClass(/open/);
        const download = page.locator("#model-list .dl-link").first();
        const repository = page.locator("#model-list .hf-link").first();
        for (const control of [download, repository]) {
          const rect = await control.boundingBox();
          expect(Math.round(rect.width)).toBeGreaterThanOrEqual(44);
          expect(Math.round(rect.height)).toBeGreaterThanOrEqual(44);
        }
        await expect(download).toHaveAttribute("aria-label", "Download weights");
        await expect(repository).toHaveAttribute("aria-label", "Model repositories");
      }
      expect(await page.locator("#panel-tts").evaluate((el) => el.inert)).toBe(false);
      expect(backend.requests.every((request) => request.path.startsWith("/api/"))).toBe(true);
    }
  );
}

test("operator bilingual labels and privacy-safe local task timeline", async ({ page }) => {
  await setup(page);
  await page.locator("#studio-operate").click();
  await page.evaluate(async () => {
    const { trackTask } = await import("/modules/tasks.js");
    trackTask({
      id: "session-private",
      category: "tts",
      modelId: "supertonic",
      status: "DONE",
      createdAt: Date.now(),
      text: "SECRET_SYNTHETIC_PROMPT"
    });
  });
  // Re-enter to snapshot task metadata without additional network polling.
  await page.locator("#studio-create").click();
  await page.locator("#studio-operate").click();
  await expect(page.locator("#operator-task-list")).toContainText("Speech");
  await expect(page.locator("#operator-workspace")).not.toContainText("SECRET_SYNTHETIC_PROMPT");
  await page.locator("#lang-toggle").click();
  await expect(page.locator("#operator-heading")).toHaveText("实例与任务动态");
  await expect(page.locator("#studio-operate")).toHaveText("驾驶舱");
  await expect(page.locator("#operator-task-list")).toContainText("语音合成");
});

test("stale instance feed is unverified, never presented as zero ready", async ({ page }) => {
  await setup(page);
  await page.locator("#studio-operate").click();
  await expect(page.locator("#operator-feed-value")).toHaveText("Current");
  await page.route("**/api/instances", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Synthetic connection interruption" })
    })
  );
  await expect(page.locator("#operator-feed-value")).toContainText("Unverified", { timeout: 8000 });
  await expect(page.locator("#operator-ready-value")).toHaveText("—");
  await expect(page.locator("#operator-model-value")).toHaveText("—");
  await expect(page.locator("#operator-instance-list")).toContainText("unavailable");
});

test("Cockpit shows localized chronology and completed elapsed time without task payloads", async ({
  page
}) => {
  await setup(page);
  await page.locator("#studio-operate").click();
  const base = Date.UTC(2026, 9, 13, 1, 0, 0);
  await page.evaluate(async (ms) => {
    const { trackTask } = await import("/modules/tasks.js");
    trackTask({
      id: "synthetic-older",
      category: "tts",
      modelId: "supertonic",
      status: "DONE",
      createdAt: ms,
      startedAt: ms,
      finishedAt: ms + 2200,
      text: "SECRET_SYNTHETIC_TASK_CONTENT"
    });
    trackTask({
      id: "synthetic-newer",
      category: "asr",
      modelId: "citrinet_asr",
      status: "DONE",
      createdAt: ms + 60000,
      startedAt: ms + 60500,
      finishedAt: ms + 62700
    });
  }, base);
  const rows = page.locator("#operator-task-list .operator-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Transcription");
  await expect(rows.first()).toContainText("Created:");
  await expect(rows.first()).toContainText("Elapsed: 2.2s");
  await expect(page.locator("#operator-task-list")).not.toContainText(
    "SECRET_SYNTHETIC_TASK_CONTENT"
  );

  await page.locator("#lang-toggle").click();
  await expect(rows.first()).toContainText("创建:");
  await expect(rows.first()).toContainText("历时: 2.2s");

  await page.evaluate(async (ms) => {
    const { trackTask } = await import("/modules/tasks.js");
    trackTask({
      id: "synthetic-newer",
      category: "asr",
      modelId: "citrinet_asr",
      status: "DONE",
      createdAt: ms + 60000,
      startedAt: ms + 60500
    });
  }, base);
  await expect(rows.first()).not.toContainText("历时:");
});

test("same-minute tasks show distinct seconds without revealing private content", async ({
  page
}) => {
  const backend = await setup(page);
  await page.locator("#studio-operate").click();
  const base = Date.UTC(2026, 9, 13, 1, 2, 0);
  await page.evaluate(async (ms) => {
    const { trackTask } = await import("/modules/tasks.js");
    for (const offset of [0, 9000]) {
      trackTask({
        id: `synthetic-second-${offset}`,
        category: "tts",
        modelId: "supertonic",
        status: "DONE",
        createdAt: ms + offset,
        startedAt: ms + offset,
        finishedAt: ms + offset + 3000,
        text: "SECRET_SYNTHETIC_TIMELINE_PAYLOAD"
      });
    }
  }, base);
  const rows = page.locator("#operator-task-list .operator-row");
  await expect(rows).toHaveCount(2);
  const newer = await rows.first().textContent();
  const older = await rows.nth(1).textContent();
  expect(newer).not.toBe(older);
  expect(newer).toMatch(/:09\b/);
  expect(older).toMatch(/:00\b/);
  await expect(rows.first()).toContainText("Elapsed: 3.0s");
  await expect(page.locator("#operator-task-list")).not.toContainText(
    "SECRET_SYNTHETIC_TIMELINE_PAYLOAD"
  );
  await page.locator("#lang-toggle").click();
  await expect(rows.first()).toContainText("创建:");
  await expect(rows.first()).toContainText("历时: 3.0s");
  expect(await rows.first().textContent()).toMatch(/:09\b/);
  backend.autoCompleteTasks = false;
  backend.tasks.push({
    id: "synthetic-ongoing",
    category: "tts",
    modelId: "supertonic",
    status: "RUNNING",
    createdAt: Date.UTC(2026, 9, 13, 1, 3, 0),
    startedAt: Date.UTC(2026, 9, 13, 1, 3, 1)
  });
  await page.evaluate(async () => {
    const { trackTask } = await import("/modules/tasks.js");
    trackTask({
      id: "synthetic-invalid-time",
      category: "tts",
      modelId: "supertonic",
      status: "DONE",
      createdAt: "not-a-date",
      text: "PRIVATE"
    });
    trackTask({
      id: "synthetic-ongoing",
      category: "tts",
      modelId: "supertonic",
      status: "RUNNING",
      createdAt: Date.UTC(2026, 9, 13, 1, 3, 0),
      startedAt: Date.UTC(2026, 9, 13, 1, 3, 1)
    });
  });
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText("运行中");
  const ongoing = await rows.first().textContent();
  expect(ongoing).not.toContain("历时:");
  const invalid = await rows.last().textContent();
  expect(invalid).not.toContain("创建:");
  expect(invalid).not.toContain("历时:");
  expect(backend.requests.some((r) => r.method === "POST" && r.path.includes("/tasks"))).toBe(
    false
  );
});
