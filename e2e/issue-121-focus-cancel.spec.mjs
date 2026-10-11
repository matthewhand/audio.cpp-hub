/* #121 focused QA: keyboard stability and authoritative cancel confirmation. */
import { expect, test } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

const ready = {
  id: "i1",
  modelId: "supertonic",
  instanceName: "breeze",
  status: "READY",
  backend: "cpu",
  device: 0,
  port: 19001
};
function task(id, status = "RUNNING") {
  return {
    id,
    modelId: "supertonic",
    category: "tts",
    instanceId: "i1",
    instanceName: "breeze",
    text: "An example prompt",
    status,
    createdAt: Date.now() - 7000,
    startedAt: Date.now() - 5000,
    finishedAt: null
  };
}
async function fakeSSE(page) {
  await page.addInitScript(() => {
    globalThis.__focusStream = [];
    globalThis.EventSource = class {
      constructor() {
        this.handlers = new Map();
        globalThis.__focusStream.push(this);
      }
      addEventListener(name, fn) {
        this.handlers.set(name, fn);
      }
      emit(name) {
        this.handlers.get(name)?.({ type: name, data: "{}" });
      }
      close() {
        this.closed = true;
      }
    };
  });
}
async function setup(page, backend) {
  await fakeSSE(page);
  await openApp(page, backend, { modelId: "supertonic", lang: "en" });
  await page.locator("#activity-queue-open").click();
  await expect(page.locator(".aq-row")).toHaveCount(1);
}
test("focused Cancel survives SSE and periodic authoritative polling", async ({ page }) => {
  const backend = new MockBackend({ instances: [ready], autoCompleteTasks: false });
  backend.tasks.push(task("focus1"));
  await setup(page, backend);
  const button = page.locator("#activity-queue-list button").first();
  await button.focus();
  await expect(button).toBeFocused();
  await page.evaluate(() => globalThis.__focusStream[0].emit("task.started"));
  await expect(button).toBeFocused();
  await page.waitForTimeout(5200);
  await expect(button).toBeFocused();
});
test("unchanged live status is not announced again on repeated task events", async ({ page }) => {
  const backend = new MockBackend({ instances: [ready], autoCompleteTasks: false });
  backend.tasks.push(task("announcements"));
  await setup(page, backend);
  await page.evaluate(() => globalThis.__focusStream[0].emit("hello"));
  await expect(page.locator("#activity-queue-status")).toContainText("Live");
  await page.evaluate(() => {
    const node = globalThis.document.querySelector("#activity-queue-status");
    globalThis.__aqStatusChanges = 0;
    const watcher = new globalThis.MutationObserver((records) => {
      globalThis.__aqStatusChanges += records.length;
    });
    watcher.observe(node, { childList: true, characterData: true, subtree: true });
    globalThis.__aqWatcher = watcher;
  });
  await page.evaluate(() => globalThis.__focusStream[0].emit("task.started"));
  await expect.poll(() => page.evaluate(() => globalThis.__aqStatusChanges)).toBe(0);
});
test("failed DELETE shows error and leaves confirmed data available for retry", async ({
  page
}) => {
  const backend = new MockBackend({ instances: [ready], autoCompleteTasks: false });
  backend.tasks.push(task("badcancel"));
  await setup(page, backend);
  await page.route("**/api/tasks/badcancel", (route) => {
    if (route.request().method() === "DELETE") {
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "unable to cancel" })
      });
    }
    return backend.handle(route);
  });
  await page.locator("#activity-queue-list button").click();
  await expect(page.locator("#toast-root")).toContainText(/cancel|unable|error/i);
  await expect(page.locator("#activity-queue-status")).not.toContainText("unavailable");
  await expect(page.locator(".aq-row button")).toBeEnabled();
  expect(backend.tasks[0].status).toBe("RUNNING");
});
test("cancel awaits old poll then performs a new post-DELETE GET", async ({ page }) => {
  const backend = new MockBackend({ instances: [ready], autoCompleteTasks: false });
  backend.tasks.push(task("race1"));
  await setup(page, backend);
  let release, reached;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const intercepted = new Promise((resolve) => {
    reached = resolve;
  });
  let firstHeld = false;
  let afterDeleteGets = 0;
  await page.route("**/api/tasks", async (route) => {
    if (!firstHeld) {
      firstHeld = true;
      const snapshot = structuredClone(backend.tasks);
      reached();
      await held;
      return backend.json(route, snapshot);
    }
    if (backend.tasks[0].status === "CANCELLED") afterDeleteGets++;
    return backend.handle(route);
  });
  await page.evaluate(() => globalThis.__focusStream[0].emit("task.started"));
  await intercepted;
  await page.locator(".aq-row button").click();
  await expect.poll(() => backend.tasks[0].status).toBe("CANCELLED");
  release();
  await expect.poll(() => afterDeleteGets, { timeout: 3500 }).toBeGreaterThan(0);
  await expect(page.locator(".aq-row")).toContainText("Cancelled");
});
