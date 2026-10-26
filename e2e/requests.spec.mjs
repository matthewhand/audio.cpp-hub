/* #198 e2e: the #/requests panel (request log & latency).
 *
 * Pins the contract the stutter investigation relies on:
 *  1. requests.js and requests.css are NOT fetched on first load, only on open;
 *  2. opening shows per-instance state cards and the newest-first request list
 *     with cold-load / gap / error flags;
 *  3. expanding a streamed request fetches /api/metrics/requests/{id} and draws
 *     the chunk timeline with slow (>100 ms) gaps marked;
 *  4. while open the panel polls; Esc closes it and polling stops. */
import { test, expect } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

test("requests panel: lazy load, instance status, flags, chunk timeline, polling", async ({
  page
}) => {
  const backend = new MockBackend();
  await openApp(page, backend);

  const lazy = [];
  let summaryCalls = 0;
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("/modules/requests.js") || u.endsWith("/requests.css")) lazy.push(u);
    if (u.includes("/api/metrics/summary")) summaryCalls++;
  });

  await expect(page.locator("#requests-panel")).toHaveClass(/hidden/);
  expect(lazy.length).toBe(0);

  await page.locator("#requests-btn").click();
  await expect(page.locator("#requests-panel")).toBeVisible();
  await expect(page).toHaveURL(/#\/requests$/);
  await expect(page.locator("#requests-panel-title")).toHaveText("Requests & latency");
  expect(lazy.length).toBe(2);

  // per-instance status cards
  const moss = page.locator(".obs-instance", { hasText: "moss-tts" });
  await expect(moss.locator(".obs-state")).toHaveText("Loaded");
  await expect(moss).toContainText("vulkan:1");
  await expect(
    page.locator(".obs-instance", { hasText: "whisper" }).locator(".obs-state")
  ).toHaveText("Cold");

  // newest-first request list with flags
  const rows = page.locator(".obs-req");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("reachy");
  await expect(rows.nth(0)).toContainText("1 gaps >100ms");
  await expect(rows.nth(1).locator(".obs-chip.warn", { hasText: "cold load" })).toBeVisible();
  await expect(rows.nth(2)).toHaveClass(/err/);
  await expect(rows.nth(2)).toContainText("Model not found");

  // chunk timeline on expand
  await rows.nth(0).locator(".obs-req-head").click();
  await expect(page.locator(".obs-track .obs-mark")).toHaveCount(4);
  await expect(page.locator(".obs-track .obs-mark.slow")).toHaveCount(3);
  await expect(page.locator(".obs-segments li")).toHaveCount(4);

  // live polling while open
  const before = summaryCalls;
  await expect.poll(() => summaryCalls, { timeout: 6000 }).toBeGreaterThan(before);

  // Esc closes and stops polling
  await page.keyboard.press("Escape");
  await expect(page.locator("#requests-panel")).toHaveClass(/hidden/);
  const after = summaryCalls;
  await page.waitForTimeout(2600);
  expect(summaryCalls).toBe(after);
});
