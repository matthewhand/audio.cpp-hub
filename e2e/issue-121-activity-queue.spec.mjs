/* #121 Activity/Queue: privacy leakage, task states, SSE reconnect and responsive UI. */
import { expect, test } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

const T = () => Date.now();
const ready = {
  id: "i1",
  modelId: "supertonic",
  instanceName: "Speaker 1",
  status: "READY",
  backend: "cpu",
  device: 0,
  port: 19001
};
function task(id, status, text, time = T()) {
  return {
    id,
    instanceId: "i1",
    instanceName: "Speaker 1",
    modelId: "supertonic",
    status,
    text,
    createdAt: time,
    startedAt: status === "RUNNING" ? time : null,
    finishedAt: ["DONE", "FAILED", "CANCELLED"].includes(status) ? time : null
  };
}
async function fakeSSE(page) {
  await page.addInitScript(() => {
    globalThis.__aqStreams = [];
    class FakeEventSource {
      constructor(url) {
        this.url = url;
        this.handlers = new Map();
        this.closed = false;
        globalThis.__aqStreams.push(this);
      }
      addEventListener(name, fn) {
        this.handlers.set(name, fn);
      }
      emit(name, data = {}) {
        const fn = this.handlers.get(name);
        if (fn) fn({ type: name, data: JSON.stringify(data) });
      }
      fail() {
        if (this.onerror) this.onerror({ type: "error" });
      }
      reopen() {
        if (this.onopen) this.onopen({ type: "open" });
      }
      close() {
        this.closed = true;
      }
    }
    globalThis.EventSource = FakeEventSource;
  });
}
async function openQueue(page) {
  await page.locator("#activity-queue-open").click();
  await expect(page.locator("#activity-queue-panel")).toBeVisible();
}

test("privacy toggle scrubs text from entire panel DOM, tooltip and ARIA", async ({ page }) => {
  await fakeSSE(page);
  const backend = new MockBackend({ instances: [ready], autoCompleteTasks: false });
  const secret = "SECRET <img src=x onerror=alert(123)> & 🌘";
  backend.tasks.push(task("a1", "RUNNING", secret));
  await openApp(page, backend, { modelId: "supertonic", lang: "en" });
  await openQueue(page);
  await expect(page.locator(".aq-preview")).toContainText(secret);
  expect(await page.locator("#activity-queue-panel img").count()).toBe(0);
  await page.evaluate(() => {
    globalThis.localStorage.setItem("hub-privacy", "1");
    globalThis.dispatchEvent(new globalThis.StorageEvent("storage", { key: "hub-privacy" }));
  });
  await expect(page.locator(".aq-preview")).toHaveText(
    await page.evaluate(() => globalThis.I18N.t("history.masked"))
  );
  expect(await page.locator("#activity-queue-panel").evaluate((el) => el.outerHTML)).not.toContain(
    secret
  );
  await page.evaluate(() => {
    globalThis.localStorage.setItem("hub-privacy", "0");
    globalThis.dispatchEvent(new globalThis.StorageEvent("storage", { key: "hub-privacy" }));
  });
  await expect(page.locator(".aq-preview")).toContainText(secret);
  await page.locator("#history-btn").click();
  await page.locator("#history-privacy").click();
  await expect(page.locator(".aq-preview")).toHaveText(
    await page.evaluate(() => globalThis.I18N.t("history.masked"))
  );
  expect(await page.locator("#activity-queue-panel").evaluate((el) => el.outerHTML)).not.toContain(
    secret
  );
});

test("queued, running, done, failed, cancelled reconcile on SSE and cancel", async ({ page }) => {
  await fakeSSE(page);
  const backend = new MockBackend({ instances: [ready], autoCompleteTasks: false });
  backend.tasks.push(task("t1", "QUEUED", "first", T() - 7000));
  backend.tasks.push(task("t2", "RUNNING", "second", T() - 4000));
  await openApp(page, backend, { modelId: "supertonic", lang: "en" });
  await openQueue(page);
  await expect(page.locator(".aq-row")).toHaveCount(2);
  await expect(page.locator(".aq-row").first()).toContainText("Running");
  await page.evaluate(() => globalThis.__aqStreams[0].emit("hello"));
  await expect(page.locator("#activity-queue-status")).toContainText("Live");
  backend.tasks[0].status = "RUNNING";
  backend.tasks[1].status = "DONE";
  await page.evaluate(() => globalThis.__aqStreams[0].emit("task.finished", { taskId: "t2" }));
  await expect(page.locator(".aq-row").first()).toContainText("Running");
  await expect(page.locator(".aq-row").last()).toContainText("Done");
  await page.locator(".aq-row").first().locator("button").click();
  await expect(page.locator(".aq-row").first()).toContainText(/Cancelled|Done/);
  backend.tasks.push(task("t3", "FAILED", "third", T()));
  await page.evaluate(() => globalThis.__aqStreams[0].emit("task.failed", { taskId: "t3" }));
  await expect(page.locator(".aq-row")).toHaveCount(3);
  await expect(page.locator("#activity-queue-list")).toContainText("Failed");
});

test("SSE failure/reconnect and GET 503 switch to stale-safe polling", async ({ page }) => {
  await fakeSSE(page);
  const backend = new MockBackend({ instances: [ready], autoCompleteTasks: false });
  backend.tasks.push(task("t1", "RUNNING", "hello"));
  await openApp(page, backend, { modelId: "supertonic", lang: "en" });
  await openQueue(page);
  await page.evaluate(() => globalThis.__aqStreams[0].emit("hello"));
  await expect(page.locator("#activity-queue-status")).toContainText("Live");
  await page.evaluate(() => globalThis.__aqStreams[0].fail());
  await expect(page.locator("#activity-queue-status")).toContainText("Polling");
  const fail = (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"error":"unavailable"}'
    });
  await page.route("**/api/tasks", fail);
  await page.evaluate(() => globalThis.__aqStreams[0].emit("task.queued", { taskId: "t1" }));
  await expect(page.locator("#activity-queue-status")).toContainText(/unavailable/i);
  await expect(page.locator("#activity-queue-list button")).toHaveCount(0);
  await page.unroute("**/api/tasks", fail);
  backend.tasks[0].status = "DONE";
  await page.evaluate(() => {
    const s = globalThis.__aqStreams[0];
    s.reopen();
    s.emit("hello");
  });
  await expect(page.locator("#activity-queue-status")).toContainText("Live");
  await expect(page.locator("#activity-queue-list")).toContainText("Done");
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 720 }
]) {
  test(`reopening cleans old stream and layout fits ${viewport.width}`, async ({ page }) => {
    await fakeSSE(page);
    const backend = new MockBackend({ instances: [ready], autoCompleteTasks: false });
    backend.tasks.push(task("r1", "QUEUED", "Sample task"));
    await page.setViewportSize(viewport);
    await openApp(page, backend, { modelId: "supertonic", lang: "zh" });
    await openQueue(page);
    await expect(page.locator(".aq-row")).toHaveCount(1);
    await page.locator("#activity-queue-close").click();
    await expect(page.locator("#activity-queue-panel")).toBeHidden();
    const closed = await page.evaluate(() => globalThis.__aqStreams[0].closed);
    expect(closed).toBe(true);
    await openQueue(page);
    await expect(page.locator(".aq-row")).toHaveCount(1);
    expect(await page.evaluate(() => globalThis.__aqStreams.length)).toBe(2);
    expect(
      await page.evaluate(() => globalThis.document.documentElement.scrollWidth)
    ).toBeLessThanOrEqual(viewport.width);
    await test.info().attach(`activity-queue-${viewport.width}`, {
      body: await page.screenshot({ animations: "disabled" }),
      contentType: "image/png"
    });
  });
}

test("closed or reopened queue never retains private text in hidden DOM", async ({ page }) => {
  await fakeSSE(page);
  const secret = "HIDDEN SECRET leave no DOM trace";
  const backend = new MockBackend({ instances: [ready], autoCompleteTasks: false });
  backend.tasks.push(task("secrettask", "QUEUED", secret));
  await openApp(page, backend, { modelId: "supertonic", lang: "en" });
  await openQueue(page);
  await expect(page.locator(".aq-preview")).toHaveText(secret);
  await page.locator("#activity-queue-close").click();
  expect(await page.locator("#activity-queue-panel").evaluate((el) => el.outerHTML)).not.toContain(
    secret
  );
  await page.evaluate(() => {
    globalThis.localStorage.setItem("hub-privacy", "1");
    globalThis.__aqStreams[0].fail(); // stale closed event cannot restart polling
  });
  expect(await page.locator("#activity-queue-panel").evaluate((el) => el.outerHTML)).not.toContain(
    secret
  );
  await openQueue(page);
  await expect(page.locator(".aq-preview")).toHaveText(
    await page.evaluate(() => globalThis.I18N.t("history.masked"))
  );
  expect(await page.locator("#activity-queue-panel").evaluate((el) => el.outerHTML)).not.toContain(
    secret
  );
});
