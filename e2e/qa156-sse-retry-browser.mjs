// Manual native Chromium regression for PR #156; needs QA121 loopback Go harness.
// Runs only synthetic API data; the second EventSource connects to the real Go SSE handler.
/* global document */
import { chromium } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";

const base = "http://127.0.0.1:4194";
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const check = (ok, msg) => {
  if (!ok) throw new Error(msg);
};
async function setup(firstOnly) {
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
  let attempts = 0;
  const statuses = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/events/stream") statuses.push(response.status());
  });
  await page.route(
    (url) => url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/"),
    (route) => {
      if (new URL(route.request().url()).pathname === "/api/events/stream") {
        attempts++;
        if (firstOnly && attempts > 1) return route.continue();
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"code":"EVENTS_BUSY"}'
        });
      }
      return backend.handle(route);
    }
  );
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("hub-model", "supertonic");
    localStorage.setItem("hub-lang", "en");
  });
  await page.goto(base);
  await page.locator("#model-list .card-title").first().waitFor({ timeout: 10000 });
  await page.locator("#activity-queue-open").click();
  await page.waitForFunction(
    () => document.querySelector("#activity-queue-status")?.dataset.state === "polling",
    null,
    { timeout: 7000 }
  );
  return {
    context,
    page,
    statuses,
    get attempts() {
      return attempts;
    }
  };
}
try {
  const recover = await setup(true);
  check(recover.statuses.includes(503), "Missing initial native HTTP 503");
  console.log("PASS initial SSE 503 -> Activity polling");
  await recover.page.waitForFunction(
    () => document.querySelector("#activity-queue-status")?.dataset.state === "live",
    null,
    { timeout: 9000 }
  );
  check(
    recover.attempts >= 2 && recover.statuses.includes(200),
    "No successful real-Go SSE recovery after terminal 503"
  );
  console.log(
    "PASS terminal EventSource 503 -> bounded retry -> real Go SSE hello -> Live",
    recover.statuses
  );
  await recover.page.locator("#activity-queue-close").click();
  await recover.context.close();

  const closed = await setup(false);
  check(closed.attempts === 1, "Unexpected immediate retry after 503");
  await closed.page.locator("#activity-queue-close").click();
  await closed.page.waitForTimeout(2400);
  check(closed.attempts === 1, "Activity close leaked SSE retry timer");
  console.log("PASS close cancels scheduled SSE retry", closed.statuses);
  await closed.context.close();
  console.log("RESULT 3/3 PR #156 native Chromium recovery checks passed");
} finally {
  await browser.close();
  await fetch(base + "/qa/stop", { method: "POST" }).catch(() => {});
}
