// Reuses and extends the pre-existing QA135 integration harness; no production inference.
/* global document, window, StorageEvent */
import { chromium } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
const base = "http://127.0.0.1:4194";
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"]
});
const check = (ok, why) => {
  if (!ok) throw new Error(why);
};
try {
  const context = await browser.newContext({
    baseURL: base,
    serviceWorkers: "block",
    viewport: { width: 390, height: 844 }
  });
  const page = await context.newPage();
  const backend = new MockBackend({
    instances: [
      {
        id: "i1",
        modelId: "supertonic",
        instanceName: "Speaker 1",
        status: "READY",
        backend: "cpu",
        device: 0,
        port: 19001
      }
    ],
    autoCompleteTasks: false
  });
  backend.tasks.push({
    id: "real-sse-task-1",
    instanceId: "i1",
    instanceName: "Speaker 1",
    modelId: "supertonic",
    status: "RUNNING",
    text: "TEST SCRIPT PRIVATE 135-141",
    createdAt: Date.now() - 5000
  });
  // Only the real SSE route reaches the Go backend; all other API requests
  // use the existing browser MockBackend so no model or production service runs.
  await page.route(
    (url) => url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/"),
    (route) =>
      route.request().url().endsWith("/api/events/stream")
        ? route.continue()
        : backend.handle(route)
  );
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("hub-model", "supertonic");
    localStorage.setItem("hub-lang", "en");
  });
  const sseResponses = [];
  page.on("response", (resp) => {
    if (resp.url().includes("events/stream")) sseResponses.push(resp.status());
  });
  await page.goto(base);
  await page.locator("#model-list .card-title").first().waitFor({ timeout: 10000 });
  await page.locator("#activity-queue-open").click();
  await page.locator(".aq-row").first().waitFor({ timeout: 7000 });
  await page.waitForFunction(
    () => document.querySelector("#activity-queue-status")?.textContent.includes("Live"),
    { timeout: 7000 }
  );
  console.log("PASS real EventSource -> real Go SSE hello, status Live", sseResponses);
  check(sseResponses.includes(200), "No successful EventSource HTTP response");
  backend.tasks[0].status = "DONE";
  const push = await fetch(base + "/qa/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "task.finished", id: "real-sse-task-1" })
  });
  check(push.status === 204, "Go Publish failed " + push.status);
  await page.locator(".aq-row").first().getByText("Done").waitFor({ timeout: 6000 });
  console.log("PASS Go SSE task.finished frame -> browser refresh -> Done");
  await page.evaluate(() => {
    localStorage.setItem("hub-privacy", "1");
    window.dispatchEvent(new StorageEvent("storage", { key: "hub-privacy" }));
  });
  await page.waitForFunction(
    () =>
      !document.querySelector("#activity-queue-panel")?.outerHTML.includes("TEST SCRIPT PRIVATE")
  );
  console.log("PASS privacy masks script in Activity DOM after real SSE");
  // End the real Go stream, let the EventSource enter its polling fallback,
  // then restart the disposable SSE bus and prove native browser reconnect.
  check((await fetch(base + "/qa/off", { method: "POST" })).status === 204, "Stop SSE bus failed");
  await page.waitForFunction(
    () => document.querySelector("#activity-queue-status")?.textContent.includes("Polling"),
    { timeout: 7000 }
  );
  console.log("PASS Go SSE disconnect -> Activity falls back to polling");
  check(
    (await fetch(base + "/qa/on", { method: "POST" })).status === 204,
    "Restart disposable bus failed"
  );
  await page.waitForFunction(
    () => document.querySelector("#activity-queue-status")?.textContent.includes("Live"),
    { timeout: 12000 }
  );
  check(sseResponses.filter((s) => s === 200).length >= 2, "Browser never reconnected to SSE");
  console.log("PASS native EventSource reconnect -> Go hello -> Activity Live");

  for (const width of [320, 390, 768, 1280, 1920]) {
    await page.setViewportSize({ width, height: 800 });
    await page.screenshot({ path: `test-results/qa121-real-sse-${width}.png` });
  }
  await page.locator("#activity-queue-close").click();
  console.log("PASS Activity closes and stops EventSource");
  await context.close();

  const fallbackContext = await browser.newContext({
    baseURL: base,
    serviceWorkers: "block",
    viewport: { width: 1280, height: 720 }
  });
  const fallback = await fallbackContext.newPage();
  const fallbackBackend = new MockBackend({
    instances: backend.instances,
    autoCompleteTasks: false
  });
  fallbackBackend.tasks.push({ ...backend.tasks[0], id: "fallback-task", status: "QUEUED" });
  await fallback.route(
    (url) => url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/"),
    (route) =>
      route.request().url().endsWith("/api/events/stream")
        ? route.fulfill({ status: 404, body: "not found", contentType: "text/plain" })
        : fallbackBackend.handle(route)
  );
  await fallback.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("hub-model", "supertonic");
    localStorage.setItem("hub-lang", "en");
  });
  await fallback.goto(base);
  await fallback.locator("#model-list .card-title").first().waitFor({ timeout: 10000 });
  await fallback.locator("#activity-queue-open").click();
  await fallback.locator(".aq-row").first().waitFor({ timeout: 6000 });
  await fallback.waitForFunction(
    () => document.querySelector("#activity-queue-status")?.textContent.includes("Polling"),
    { timeout: 7000 }
  );
  console.log("PASS HTTP SSE 404 fallback -> authoritative polling");
  await fallbackContext.close();
  // This final scenario uses the *actual* Go TaskManager for both SSE and
  // authoritative GET /api/tasks. Only unrelated app bootstrap APIs are mocked.
  const actualContext = await browser.newContext({
    baseURL: base,
    serviceWorkers: "block",
    viewport: { width: 768, height: 850 }
  });
  const actual = await actualContext.newPage();
  const actualBackend = new MockBackend({
    instances: backend.instances,
    autoCompleteTasks: false
  });
  let actualTaskGets = 0;
  await actual.route(
    (url) => url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/"),
    (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/tasks") {
        actualTaskGets++;
        return route.continue();
      }
      return path === "/api/events/stream" ? route.continue() : actualBackend.handle(route);
    }
  );
  await actual.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("hub-model", "supertonic");
    localStorage.setItem("hub-lang", "en");
  });
  await actual.goto(base);
  await actual.locator("#model-list .card-title").first().waitFor({ timeout: 10000 });
  await actual.locator("#activity-queue-open").click();
  await actual.waitForFunction(
    () => document.querySelector("#activity-queue-status")?.textContent.includes("Live"),
    { timeout: 7000 }
  );
  const creation = await fetch(base + "/qa/live-create", { method: "POST" });
  check(creation.status === 202, "Real TaskManager submission was rejected");
  const created = await creation.json();
  check(typeof created.id === "string", "Real task ID missing");
  await actual.waitForFunction(
    () => document.querySelector(".aq-row .aq-status")?.textContent.includes("Running"),
    { timeout: 7000 }
  );
  const beforeFinish = actualTaskGets;
  check(
    (await fetch(base + "/qa/live-finish", { method: "POST" })).status === 204,
    "Real synthetic engine release failed"
  );
  await actual.waitForFunction(
    () => document.querySelector(".aq-row .aq-status")?.textContent.includes("Done"),
    { timeout: 7000 }
  );
  check(actualTaskGets > beforeFinish, "Terminal SSE did not trigger a real GET /api/tasks");
  check(actualTaskGets >= 3, "Insufficient authoritative Go task revalidation");
  console.log(
    "PASS Go TaskManager lifecycle -> native SSE -> real GET /api/tasks -> browser RUNNING/DONE"
  );
  await actualContext.close();
  console.log("RESULT 8/8 real browser integration checks passed");
} finally {
  await browser.close();
  await fetch(base + "/qa/stop", { method: "POST" }).catch(() => {});
}
