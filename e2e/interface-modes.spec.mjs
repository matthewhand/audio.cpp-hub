/* global document, location */
/* Source-only three-mode UX contracts: fake backend, no inference or production access. */
import { expect, test } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

// Mock-only mode tests must intercept lazy chunks before PWA precaching.
test.use({ serviceWorkers: "block" });

const ready = {
  id: "synthetic-ready",
  modelId: "supertonic",
  instanceName: "Synthetic local",
  status: "READY",
  backend: "cpu",
  device: 0,
  port: 19001,
  taskCount: 1
};
async function setup(page, lang = "en") {
  const backend = new MockBackend({ instances: [ready] });
  await page.route("**/*", (route) => {
    const origin = new URL(route.request().url()).origin;
    return origin === (process.env.AUDIO_HUB_TEST_ORIGIN || "http://127.0.0.1:4173")
      ? route.continue()
      : route.abort();
  });
  await openApp(page, backend, { modelId: "supertonic", lang, theme: "light" });
  return backend;
}

for (const width of [320, 390, 768, 1024, 1366, 1920]) {
  test("three layouts, shared draft and touch controls at " + width + "px", async ({ page }) => {
    await page.setViewportSize({ width, height: width < 400 ? 844 : 900 });
    const backend = await setup(page);
    await expect(page.locator("#workspace")).toHaveAttribute("data-interface-mode", "classic");
    await expect(page.locator("#studio-create")).toHaveAttribute("aria-pressed", "true");
    await page.locator("#tts-text").fill("Private synthetic unsent draft");
    const initial = await page.evaluate(() => ({
      lang: localStorage.getItem("hub-lang"),
      theme: localStorage.getItem("hub-theme"),
      model: localStorage.getItem("hub-model")
    }));
    await page.locator("#studio-flow").click();
    await expect(page.locator("#flow-workspace")).toBeVisible();
    await expect(page.locator("#panel-tts")).toBeVisible();
    await page.locator("#flow-tts").click();
    await expect(page.locator("#tts-text")).toHaveValue("Private synthetic unsent draft");
    await page.locator("#studio-operate").click();
    await expect(page.locator("#operator-workspace")).toBeVisible();
    await expect(page.locator("#panel-tts")).toBeHidden();
    await expect(page.locator("#operator-routing-heading")).toHaveText("Farm routing and failover");
    await expect(page.locator("#operator-ready-value")).toHaveText("1");
    await page.locator("#studio-create").click();
    await expect(page.locator("#tts-text")).toHaveValue("Private synthetic unsent draft");
    await expect(page.locator("#flow-workspace")).toBeHidden();
    await expect(page.locator("#workspace")).toHaveAttribute("data-interface-mode", "classic");
    const state = await page.evaluate(() => ({
      scrollWidth: globalThis.document.documentElement.scrollWidth,
      saved: localStorage.getItem("hub-interface-mode"),
      lang: localStorage.getItem("hub-lang"),
      theme: localStorage.getItem("hub-theme"),
      model: localStorage.getItem("hub-model"),
      sizes: [...globalThis.document.querySelectorAll(".studio-mode-button")].map((el) => {
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height, left: r.left, right: r.right };
      })
    }));
    expect(state.saved).toBe("classic");
    expect({ lang: state.lang, theme: state.theme, model: state.model }).toEqual(initial);
    expect(state.scrollWidth).toBeLessThanOrEqual(width + 1);
    for (const r of state.sizes) {
      expect(r.w).toBeGreaterThanOrEqual(44);
      expect(r.h).toBeGreaterThanOrEqual(44);
      expect(r.left).toBeGreaterThanOrEqual(-1);
      expect(r.right).toBeLessThanOrEqual(width + 1);
    }
    expect(backend.requests.every((r) => r.path.startsWith("/api/"))).toBe(true);
  });
}

test("Flow uses real model routes, empty category is explained, no inference", async ({ page }) => {
  const backend = await setup(page);
  // Only the second ASR catalog entry is configured. Flow must skip the first.
  await page.evaluate(async () => {
    const { setExecutables, setProfiles } = await import("/modules/state.js");
    setExecutables([{ id: "synthetic-executable", exists: true }]);
    setProfiles([
      { modelId: "higgs_audio_stt", weightsPath: "/synthetic/higgs", weightsExists: true }
    ]);
  });
  await page.locator("#studio-flow").click();
  await page.locator("#flow-asr").click();
  await expect(page).toHaveURL(/#\/model\/higgs_audio_stt$/);
  await expect(page.locator("#panel-asr")).toBeVisible();
  await expect(page.locator("#asr-title")).toBeFocused();
  // Choosing the same configured route again must also leave focus in the editor.
  await page.locator("#flow-asr").click();
  await expect(page.locator("#asr-title")).toBeFocused();
  await expect(page.locator("#workspace")).toHaveAttribute("data-interface-mode", "flow");
  expect(await page.locator("#flow-feedback").textContent()).toContain("Selected model");
  await page.locator("#flow-voices").click();
  await expect(page.locator("#voices-panel")).toBeVisible();
  await page.locator("#voices-close").click();
  await page.evaluate(async () => {
    const { models, setModels } = await import("/modules/state.js");
    setModels(models.filter((model) => model.category !== "asr"));
  });
  await page.locator("#flow-asr").click();
  await expect(page.locator("#flow-feedback")).toContainText("No locally available model");
  expect(backend.requests.some((r) => r.path.includes("/tasks") && r.method === "POST")).toBe(
    false
  );
});

test("saved mode resumes independently of theme and locale, invalid mode falls back", async ({
  page
}) => {
  const backend = new MockBackend({ instances: [ready] });
  await page.route("**/*", (route) => {
    const origin = new URL(route.request().url()).origin;
    return origin === (process.env.AUDIO_HUB_TEST_ORIGIN || "http://127.0.0.1:4173")
      ? route.continue()
      : route.abort();
  });
  backend.install(page);
  // Unlike the general fixture, this one does not clear persisted preferences
  // on reload: prove the actual browser storage lifecycle.
  await page.addInitScript(() => {
    if (sessionStorage.getItem("mode-fixture-init")) return;
    localStorage.setItem("hub-model", "supertonic");
    localStorage.setItem("hub-theme", "light");
    localStorage.setItem("hub-lang", "zh");
    localStorage.setItem("hub-interface-mode", "cockpit");
    sessionStorage.setItem("mode-fixture-init", "1");
  });
  await page.goto("/");
  await expect(page.locator("#model-list .card-title").first()).toBeVisible();
  await expect(page.locator("#workspace")).toHaveAttribute("data-interface-mode", "cockpit");
  await expect(page.locator("#studio-operate")).toHaveText("驾驶舱");
  await expect(page.locator("#operator-routing-heading")).toHaveText("集群路由与故障切换");
  await page.locator("#studio-flow").click();
  await expect(page.locator("#flow-heading")).toContainText("您想完成什么");
  await page.locator("#lang-toggle").click();
  await expect(page.locator("#studio-flow")).toHaveText("Flow");
  await expect(page.locator("#workspace")).toHaveAttribute("data-interface-mode", "flow");
  await page.reload();
  await expect(page.locator("#workspace")).toHaveAttribute("data-interface-mode", "flow");
  await page.evaluate(() => localStorage.setItem("hub-interface-mode", "untrusted-mode"));
  await page.reload();
  await expect(page.locator("#workspace")).toHaveAttribute("data-interface-mode", "classic");
});

test("keyboard switch retains focus and editor state", async ({ page }) => {
  await setup(page);
  await page.locator("#tts-text").fill("Keyboard draft");
  await page.locator("#studio-flow").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#workspace")).toHaveAttribute("data-interface-mode", "flow");
  await expect(page.locator("#studio-flow")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#studio-flow")).toBeFocused();
  await page.locator("#studio-operate").focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#workspace")).toHaveAttribute("data-interface-mode", "cockpit");
  await page.locator("#studio-create").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#tts-text")).toHaveValue("Keyboard draft");
  await expect(page.locator("#studio-create")).toBeFocused();
});

test("Flow rejects catalog-only models without changing the current model", async ({ page }) => {
  const backend = await setup(page);
  const original = await page.evaluate(() => ({
    hash: globalThis.location.hash,
    model: localStorage.getItem("hub-model")
  }));
  await page.locator("#studio-flow").click();
  await page.locator("#flow-asr").click();
  await expect(page.locator("#flow-feedback")).toContainText("No ready or configured local model");
  expect(await page.evaluate(() => globalThis.location.hash)).toBe(original.hash);
  expect(await page.evaluate(() => localStorage.getItem("hub-model"))).toBe(original.model);
  expect(backend.requests.some((r) => r.method === "POST" && r.path.includes("/tasks"))).toBe(
    false
  );
});

test("Flow model drawer transfers and restores keyboard focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.locator("#studio-flow").click();
  await page.locator("#flow-models").click();
  await expect(page.locator("#left")).toHaveClass(/open/);
  await expect(page.locator("#model-list")).toBeFocused();
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() =>
      globalThis.document.querySelector("#left").contains(globalThis.document.activeElement)
    )
  ).toBe(true);
  const endpoints = await page.evaluate(() => {
    const controls = [
      ...globalThis.document
        .querySelector("#left")
        .querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]'
        )
    ].filter(
      (el) => el.getClientRects().length && globalThis.getComputedStyle(el).visibility !== "hidden"
    );
    controls.at(-1).focus();
    return { first: controls[0].id, last: controls.at(-1).id };
  });
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => globalThis.document.activeElement.id)).toBe(endpoints.first);
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => globalThis.document.activeElement.id)).toBe(endpoints.last);
  await page.keyboard.press("Escape");
  await expect(page.locator("#left")).not.toHaveClass(/open/);
  await expect(page.locator("#flow-models")).toBeFocused();
});

test("Cockpit import failure is bilingual, recoverable and retains the draft", async ({ page }) => {
  const moduleRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/operator-studio.js")) {
      moduleRequests.push(request.url());
    }
  });
  await setup(page);
  await page.locator("#tts-text").fill("Keep this unsent draft");
  await page.route("**/modules/operator-studio.js", (route) => route.abort());
  await page.locator("#studio-operate").click();
  await expect(page.locator("#operator-load-error")).toBeVisible();
  await expect(page.locator("#operator-load-error")).toHaveAttribute("role", "alert");
  await expect(page.locator(".operator-metrics")).toBeHidden();
  await page.locator("#lang-toggle").click();
  await expect(page.locator("#operator-retry")).toHaveText("重试驾驶舱");
  await page.unroute("**/modules/operator-studio.js");
  await page.locator("#operator-retry").click();
  await expect(page.locator("#operator-load-error")).toHaveCount(0);
  await expect(page.locator("#operator-feed-value")).toHaveText("已更新");
  const recoveredRequests = [...moduleRequests];
  await page.locator("#studio-create").click();
  await expect(page.locator("#tts-text")).toHaveValue("Keep this unsent draft");
  await page.locator("#studio-operate").click();
  await expect(page.locator("#operator-feed-value")).toHaveText("已更新");
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))
      )
  );
  await expect(page.locator("#operator-load-error")).toHaveCount(0);
  expect(moduleRequests).toEqual(recoveredRequests);
  await page.locator("#studio-create").click();
  await page.locator("#studio-operate").click();
  await expect(page.locator("#operator-feed-value")).toHaveText("已更新");
});

test("Cockpit timeline updates on local task changes without exposing prompt text", async ({
  page
}) => {
  const backend = await setup(page);
  await page.locator("#studio-operate").click();
  await expect(page.locator("#operator-feed-value")).toHaveText("Current");
  await page.evaluate(async () => {
    const { trackTask } = await import("/modules/tasks.js");
    trackTask({
      id: "synthetic-timeline",
      modelId: "supertonic",
      category: "tts",
      status: "DONE",
      createdAt: Date.now(),
      text: "SECRET_SYNTHETIC_DRAFT"
    });
  });
  await expect(page.locator("#operator-task-list")).toContainText("Speech");
  await expect(page.locator("#operator-task-list")).toContainText("Done");
  await page.evaluate(async () => {
    const { trackTask } = await import("/modules/tasks.js");
    trackTask({
      id: "synthetic-timeline",
      modelId: "supertonic",
      category: "tts",
      status: "FAILED",
      createdAt: Date.now(),
      text: "SECRET_SYNTHETIC_DRAFT"
    });
  });
  await expect(page.locator("#operator-task-list")).toContainText("Failed");
  await expect(page.locator("#operator-task-list")).not.toContainText("SECRET_SYNTHETIC_DRAFT");
  expect(backend.requests.some((r) => r.method === "POST" && r.path.includes("/tasks"))).toBe(
    false
  );
});

test("Flow rejects stale READY instances, then accepts a verified recovery", async ({ page }) => {
  await setup(page);
  await page.evaluate(async () => {
    const { onInstancesError } = await import("/modules/instances.js");
    onInstancesError(new Error("Synthetic instance feed interrupted"));
  });
  await page.locator("#studio-flow").click();
  const initial = await page.evaluate(() => ({
    route: globalThis.location.hash,
    model: localStorage.getItem("hub-model")
  }));
  await page.locator("#flow-tts").click();
  await expect(page.locator("#flow-feedback")).toContainText("No ready or configured local model");
  expect(await page.evaluate(() => globalThis.location.hash)).toBe(initial.route);
  expect(await page.evaluate(() => localStorage.getItem("hub-model"))).toBe(initial.model);
  await page.evaluate(async () => {
    const { applyInstances } = await import("/modules/instances.js");
    applyInstances([
      {
        id: "recovered",
        modelId: "supertonic",
        status: "READY",
        instanceName: "Synthetic recovered",
        backend: "cpu",
        device: 0,
        port: 19001
      }
    ]);
  });
  await page.locator("#flow-tts").click();
  await expect(page.locator("#flow-feedback")).toContainText("Selected model");
  await expect(page.locator("#tts-title")).toBeFocused();
});

test("native model selection supports keyboard, assistive labels and independent actions", async ({
  page
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const backend = await setup(page);
  const selected = page.locator('#model-list .model-select-target[aria-current="true"]');
  await expect(selected).toHaveCount(1);
  await expect(selected).toHaveAttribute("aria-label", /Select model.*Supertonic/);
  const asr = page.locator("#model-list .card", { hasText: "Citrinet ASR" });
  const pick = asr.locator(".model-select-target");
  await expect(pick).toHaveAttribute("aria-label", /Select model.*Citrinet ASR.*No profile/);
  expect(await page.locator("#model-list button button").count()).toBe(0);
  await asr.locator(".dl-link").click();
  await expect(page.locator("#model-dl-modal")).toBeVisible();
  await expect(page).not.toHaveURL(/citrinet_asr/);
  await page.locator("#model-dl-modal-close").click();
  await expect(page.locator("#model-dl-modal")).toBeHidden();
  await page.locator("#model-list .hf-link").first().click();
  await expect(page.locator("#hf-menu")).toHaveClass(/open/);
  await page.evaluate(() => document.dispatchEvent(new Event("scroll")));
  await expect(page.locator("#hf-menu")).toHaveClass(/open/);
  await expect(page).not.toHaveURL(/citrinet_asr/);
  await page.keyboard.press("Escape");
  await pick.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/model\/citrinet_asr$/);
  await expect(
    page.locator('#model-list .model-select-target[aria-current="true"]')
  ).toHaveAttribute("data-model-id", "citrinet_asr");
  await expect(
    page.locator('#model-list .model-select-target[data-model-id="citrinet_asr"]')
  ).toBeFocused();
  await page.locator('#model-list .model-select-target[data-model-id="supertonic"]').focus();
  await page.keyboard.press("Space");
  await expect(page).toHaveURL(/#\/model\/supertonic$/);
  await expect(
    page.locator('#model-list .model-select-target[data-model-id="supertonic"]')
  ).toBeFocused();
  await expect(page.locator("#tts-text")).toBeVisible();
  expect(backend.requests.some((r) => r.method === "POST" && r.path.includes("/tasks"))).toBe(
    false
  );
  await page.locator("#lang-toggle").click();
  await expect(
    page.locator('#model-list .model-select-target[data-model-id="supertonic"]')
  ).toHaveAttribute("aria-label", /选择模型.*Supertonic/);
});

test("Flow-opened model drawer supports keyboard selection and focus recovery", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const backend = await setup(page);
  await page.locator("#studio-flow").click();
  await page.locator("#flow-models").click();
  await expect(page.locator("#model-list")).toBeFocused();
  const controls = page.locator(
    '#left :is(a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]):visible'
  );
  await page.keyboard.press("Shift+Tab");
  await expect(controls.last()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(controls.first()).toBeFocused();
  const asr = page.locator('#model-list .model-select-target[data-model-id="citrinet_asr"]');
  await asr.focus();
  await page.keyboard.press("Space");
  await expect(page).toHaveURL(/#\/model\/citrinet_asr$/);
  await expect(page.locator("#left")).not.toHaveClass(/open/);
  await expect(page.locator("#flow-models")).toBeFocused();
  await page.locator("#flow-models").click();
  await page.locator('#model-list .model-select-target[data-model-id="citrinet_asr"]').focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#left")).not.toHaveClass(/open/);
  await expect(page.locator("#flow-models")).toBeFocused();
  expect(backend.requests.some((r) => r.method === "POST")).toBe(false);
});

test("closed mobile drawer is absent from tab order and accessibility tree", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const backend = await setup(page);
  const left = page.locator("#left");
  await expect(left).not.toHaveClass(/open/);
  await expect(left).toHaveAttribute("aria-hidden", "true");
  await expect(left).toHaveCSS("visibility", "hidden");
  expect(await left.evaluate((el) => el.inert)).toBe(true);
  await expect(page.locator("#menu-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("complementary", { name: /Models & instances/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Select model: Citrinet ASR/ })).toHaveCount(0);

  await page.locator("#menu-toggle").focus();
  for (let i = 0; i < 24; i++) {
    await page.keyboard.press("Tab");
    expect(await left.evaluate((el) => el.contains(document.activeElement))).toBe(false);
  }
  await page.locator("#menu-toggle").focus();
  await page.keyboard.press("Shift+Tab");
  expect(await left.evaluate((el) => el.contains(document.activeElement))).toBe(false);

  // A scripted attempt to focus the hidden control must not enable Enter activation.
  const before = await page.evaluate(() => ({
    hash: location.hash,
    model: localStorage.getItem("hub-model")
  }));
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
    document
      .querySelector('#model-list .model-select-target[data-model-id="citrinet_asr"]')
      .focus();
  });
  expect(await left.evaluate((el) => el.contains(document.activeElement))).toBe(false);
  await page.keyboard.press("Enter");
  expect(
    await page.evaluate(() => ({ hash: location.hash, model: localStorage.getItem("hub-model") }))
  ).toEqual(before);
  await expect(left).not.toHaveClass(/open/);
  expect(backend.requests.some((r) => r.method === "POST")).toBe(false);
});

test("Classic mobile drawer restores focus on Escape, overlay and model selection", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const backend = await setup(page);
  const left = page.locator("#left"),
    toggle = page.locator("#menu-toggle");
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(left).toHaveClass(/open/);
  expect(await left.evaluate((el) => el.inert)).toBe(false);
  await expect(left).not.toHaveAttribute("aria-hidden");
  await expect(page.getByRole("button", { name: /Select model: Citrinet ASR/ })).toHaveCount(1);
  expect(await left.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Tab");
  expect(await left.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(left).not.toHaveClass(/open/);
  await expect(toggle).toBeFocused();

  await toggle.click();
  await page.locator("#drawer-overlay").click({ position: { x: 385, y: 400 } });
  await expect(left).not.toHaveClass(/open/);
  await expect(toggle).toBeFocused();

  await toggle.click();
  const asr = page.locator('#model-list .model-select-target[data-model-id="citrinet_asr"]');
  await asr.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/model\/citrinet_asr$/);
  await expect(left).not.toHaveClass(/open/);
  await expect(toggle).toBeFocused();
  expect(backend.requests.some((r) => r.method === "POST")).toBe(false);
});

test("drawer isolation follows the exact 1100/1101px breakpoint and focused resizes", async ({
  page
}) => {
  await page.setViewportSize({ width: 1101, height: 844 });
  const backend = await setup(page);
  const left = page.locator("#left"),
    toggle = page.locator("#menu-toggle");
  expect(await left.evaluate((el) => el.inert)).toBe(false);
  await expect(left).not.toHaveAttribute("aria-hidden");
  await page.locator('#model-list .model-select-target[data-model-id="supertonic"]').focus();
  await page.setViewportSize({ width: 1100, height: 844 });
  await expect(left).toHaveAttribute("aria-hidden", "true");
  expect(await left.evaluate((el) => el.inert)).toBe(true);
  await expect(toggle).toBeFocused();

  await toggle.click();
  await expect(left).toHaveClass(/open/);
  expect(await left.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.setViewportSize({ width: 1101, height: 844 });
  await expect(left).not.toHaveClass(/open/);
  await expect(left).not.toHaveAttribute("aria-hidden");
  expect(await left.evaluate((el) => el.inert)).toBe(false);
  await expect(left).toHaveCSS("visibility", "visible");
  await expect(page.locator("#drawer-overlay")).toHaveClass(/hidden/);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.locator('#model-list .model-select-target[data-model-id="supertonic"]').focus();
  await page.setViewportSize({ width: 1100, height: 844 });
  await expect(toggle).toBeFocused();
  await page.setViewportSize({ width: 1101, height: 844 });
  await expect(left).not.toHaveAttribute("aria-hidden");
  expect(await left.evaluate((el) => el.inert)).toBe(false);
  await expect.poll(() => left.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  expect(backend.requests.some((r) => r.method === "POST")).toBe(false);
});

test("closed mobile sidebar is CSS-hidden even when the application module is blocked", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/*", (route) => {
    return new URL(route.request().url()).origin ===
      (process.env.AUDIO_HUB_TEST_ORIGIN || "http://127.0.0.1:4173")
      ? route.continue()
      : route.abort();
  });
  await page.route("**/app.js", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator("#left")).toHaveCSS("visibility", "hidden");
  await page.evaluate(() => {
    const b = document.createElement("button");
    b.id = "synthetic-unbooted-model";
    b.textContent = "Unbooted fixture";
    document.getElementById("left").append(b);
    b.focus();
  });
  expect(await page.evaluate(() => document.activeElement.id)).not.toBe("synthetic-unbooted-model");
  await expect(page.getByRole("button", { name: "Unbooted fixture" })).toHaveCount(0);
});

test("active mode labels retain immediate and next-frame contrast in both themes and locales", async ({
  page
}) => {
  for (const lang of ["en", "zh"]) {
    await setup(page, lang);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      for (const [mode, id] of [
        ["flow", "studio-flow"],
        ["cockpit", "studio-operate"],
        ["classic", "studio-create"]
      ]) {
        const frames = await page.evaluate(
          async ({ mode, id }) => {
            const modes = await import("/modules/interface-modes.js");
            modes.initInterfaceModes();
            modes.setInterfaceMode(mode);
            const sample = () => {
              const button = document.getElementById(id),
                style = globalThis.getComputedStyle(button);
              const luminance = (color) => {
                const rgb = color
                  .match(/[0-9.]+/g)
                  .slice(0, 3)
                  .map(Number)
                  .map((v) => v / 255);
                const linear = rgb.map((v) =>
                  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
                );
                return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
              };
              const a = luminance(style.color),
                b = luminance(style.backgroundColor);
              return {
                text: button.textContent.trim(),
                ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
              };
            };
            const initial = sample();
            await new Promise(globalThis.requestAnimationFrame);
            return [initial, sample()];
          },
          { mode, id }
        );
        for (const frame of frames) {
          expect(frame.text.length).toBeGreaterThan(0);
          expect(frame.ratio, theme + "/" + lang + "/" + mode).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  }
});

for (const saved of [false, true]) {
  test(
    "interface chunk failure retains Classic and can retry (saved=" + saved + ")",
    async ({ page }) => {
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const backend = new MockBackend({ instances: [ready] });
      backend.install(page);
      await page.addInitScript((restore) => {
        localStorage.clear();
        localStorage.setItem("hub-model", "supertonic");
        localStorage.setItem("hub-lang", "en");
        if (restore) localStorage.setItem("hub-interface-mode", "cockpit");
      }, saved);
      await page.route("**/modules/interface-modes.js", (route) => route.abort());
      await page.goto("/");
      await expect(page.locator("#model-list .card-title").first()).toBeAttached();
      await page.locator("#tts-text").fill("Retain the unsent draft");
      if (!saved) await page.locator("#studio-operate").click();
      await expect(page.locator("#toast-root [role=alert]")).toContainText("Failed to load");
      await expect(page.locator("#workspace")).toHaveAttribute("data-interface-mode", "classic");
      await page.unroute("**/modules/interface-modes.js");
      await page.locator("#studio-operate").click();
      await expect(page.locator("#workspace")).toHaveAttribute("data-interface-mode", "cockpit");
      await expect(page.locator("#operator-feed-value")).toHaveText("Current");
      await page.locator("#studio-create").click();
      await expect(page.locator("#tts-text")).toHaveValue("Retain the unsent draft");
      expect(errors).toEqual([]);
    }
  );
}

test("failed interface styles preserve visibility and retry on next mode change", async ({
  page
}) => {
  await setup(page);
  await page.locator("#tts-text").fill("Retain the styled draft");
  await page.route("**/interface-modes.css", (route) => route.abort());
  await page.locator("#studio-operate").click();
  await expect(page.locator("#operator-feed-value")).toHaveText("Current");
  await expect(page.locator("#panel-tts")).toBeHidden();
  await expect(page.locator("#toast-root [role=alert]")).toContainText("Failed to load");
  await expect(page.locator("#interface-mode-styles")).toHaveCount(0);
  await page.unroute("**/interface-modes.css");
  await page.locator("#studio-create").click();
  await page.locator("#studio-flow").click();
  await expect
    .poll(() => page.locator("#interface-mode-styles").evaluate((link) => Boolean(link.sheet)))
    .toBe(true);
  await expect(page.locator("#tts-text")).toHaveValue("Retain the styled draft");
});
