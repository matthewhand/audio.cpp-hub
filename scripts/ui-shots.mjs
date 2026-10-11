/* UI verification shots (dev-only, no product code involved).
 *
 * Walks the fixed viewport matrix from AGENTS.md "UI verification standard"
 * against a running hub (or any BASE_URL that serves web/) and records, per
 * viewport:
 *   - console errors (console.error + pageerror)
 *   - horizontal overflow (documentElement.scrollWidth vs clientWidth)
 *   - key control state: present / visible / reachable / above the fold
 *     ("above the fold" also refuses controls that a scrollable ancestor keeps
 *      out of view: the left column and the workspace scroll independently)
 * One dark screenshot per viewport, plus exactly one light screenshot on
 * LIGHT_SHOT. The run is strictly read-only: nothing is clicked, no form is
 * submitted, and every non-GET/HEAD request is aborted.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:18080 OUT_DIR=./ui-shots-out node scripts/ui-shots.mjs
 *   ONLY=mobile-360x800,laptop-1280x720 node scripts/ui-shots.mjs   (subset)
 *   ACTION=generating BASE_URL=... node scripts/ui-shots.mjs        (optional note)
 *   LABEL=mock-backend node scripts/ui-shots.mjs                    (image label;
 *       default "production" — mock shots must not pass as production results)
 *
 * One JSON document goes to stdout (a copy lands in OUT_DIR/ui-shots.json);
 * exit code is 1 when any viewport fails its pass criteria. Fold failures are
 * reported separately and never flip the verdict on their own.
 *
 * The pure helpers (VIEWPORTS / LIGHT_SHOT / KEY_CONTROLS / SIDEBAR_CONTROL_IDS /
 * DRAWER_MAX_WIDTH / shouldOpenDrawer / resolveShotLabel / evaluateOverflow /
 * buildReport) are exported so test/unit/ui-shots.test.mjs can pin them
 * without launching a browser. main() only runs when executed directly.
 *
 * Narrow viewports (<= DRAWER_MAX_WIDTH) put the models / instances / activity
 * column in an off-canvas drawer: those runs click the hamburger (#menu-toggle)
 * AFTER the closed-state dark shot and BEFORE measuring instance-list /
 * activity-panel / models-panel, so reachability is judged with the drawer
 * actually open. A second shot `<name>-drawer-open-dark.png` records that state,
 * and horizontal overflow is measured both closed and drawer-open. */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** Viewport matrix every UI change is verified at. */
export const VIEWPORTS = [
  { name: "mobile-360x800", width: 360, height: 800 },
  { name: "mobile-390x844", width: 390, height: 844 },
  { name: "tablet-768x1024", width: 768, height: 1024 },
  { name: "laptop-1280x720", width: 1280, height: 720 },
  { name: "desktop-1920x1080", width: 1920, height: 1080 }
];

/** The one viewport that gets the single light-theme shot (all others are dark). */
export const LIGHT_SHOT = "laptop-1280x720";

/** Report key -> real selector (ids verified against web/index.html + web/README.md). */
export const KEY_CONTROLS = {
  "tts-submit": "#tts-submit", // Synthesize button
  "instance-list": "#instance-list .card", // instance cards
  "activity-panel": "#activity-panel", // recent activity panel
  "models-panel": "#model-panel", // models <details> (same drawer as the two above)
  "voices-btn": "#voices-btn",
  "history-btn": "#history-btn",
  "downloads-btn": "#downloads-btn",
  "stats-btn": "#stats-btn",
  "lang-toggle": "#lang-toggle",
  "settings-btn": "#settings-btn",
  "theme-toggle": "#theme-toggle"
};

/**
 * Controls that live inside the hamburger drawer (#left, opened by #menu-toggle).
 * On viewports at or below DRAWER_MAX_WIDTH the runner opens the drawer before
 * measuring these; everything else is measured in the closed state.
 */
export const SIDEBAR_CONTROL_IDS = ["instance-list", "activity-panel", "models-panel"];

/**
 * Viewport width at or below which the left column is an off-canvas drawer.
 * Mirrors the AGENTS.md "UI verification standard" line: on these viewports the
 * hamburger is clicked before the sidebar controls are evaluated.
 */
export const DRAWER_MAX_WIDTH = 900;

/** True when a viewport of this width needs the hamburger opened first. */
export function shouldOpenDrawer(width) {
  const w = Number(width);
  return Number.isFinite(w) && w > 0 && w <= DRAWER_MAX_WIDTH;
}

/**
 * How the header action buttons were evaluated. "closed" = every icon button was
 * visible in the page header itself (this UI keeps a compact wrapping row instead
 * of an overflow menu, so there is no second phase to measure).
 */
export const HEADER_BUTTONS_PHASES = ["closed", "overflow-open"];

/** Allowed image labels (AGENTS.md "UI verification standard"). */
export const SHOT_LABELS = ["production", "mock-backend"];

/**
 * Label attached to every screenshot of the run: LABEL=mock-backend when the
 * shots were taken against the e2e mock, otherwise (empty / unset) production.
 * Unknown values throw instead of silently publishing a mislabelled image.
 */
export function resolveShotLabel(value) {
  const label = value == null || String(value).trim() === "" ? "production" : String(value).trim();
  if (!SHOT_LABELS.includes(label)) {
    throw new Error(`LABEL must be one of ${SHOT_LABELS.join(" / ")}: ${label}`);
  }
  return label;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:4173";
const DEFAULT_OUT_DIR = "./ui-shots-out";
const SETTLE_MS = 4000; // let the 2s pollers settle before measuring / shooting
const DRAWER_SETTLE_MS = 600; // drawer slide-in transition (var(--dur-3)) + a frame
const CONSOLE_ERROR_CAP = 50; // keep the JSON sane; a non-empty list still fails
const READ_ONLY_METHODS = new Set(["GET", "HEAD"]);
/* The storage key web/boot.js reads synchronously in <head> (before first paint)
   to restore the theme. Seeding it via addInitScript avoids a theme flash. */
const THEME_STORAGE_KEY = "hub-theme";

/* ---------- pure helpers (unit-tested without a browser) ---------- */

/** Horizontal overflow verdict from {scrollWidth, clientWidth}. */
export function evaluateOverflow(metrics) {
  if (!metrics) return { pass: false, scrollWidth: 0, clientWidth: 0 };
  const scrollWidth = Number(metrics.scrollWidth) || 0;
  const clientWidth = Number(metrics.clientWidth) || 0;
  return { pass: scrollWidth <= clientWidth, scrollWidth, clientWidth };
}

/**
 * Finalize raw per-viewport results into the printed report.
 * A viewport passes when there are no console errors, no horizontal overflow and
 * every key control is reachable. Fold is reported on its own and never gates
 * the verdict.
 *
 * Added (additive-only) fields:
 *   drawerOpened   - the hamburger drawer was opened before the sidebar controls
 *                    were measured (only on viewports <= DRAWER_MAX_WIDTH)
 *   headerButtons  - which phase the header action buttons were measured in
 *   overflowDrawerOpen - overflow measured with the drawer open (null when the
 *                    drawer never opened)
 *   shotsLabelled  - every screenshot of the viewport mapped to its image label
 */
export function buildReport(results, meta = {}) {
  const shotLabel = resolveShotLabel(meta.label);
  const viewports = (results || []).map((raw) => {
    const controls = {};
    let allReachable = true;
    for (const [id, control] of Object.entries(raw.controls || {})) {
      controls[id] = {
        present: !!control.present,
        visible: !!control.visible,
        reachable: !!control.reachable,
        aboveFold: !!control.aboveFold
      };
      if (!control.reachable) allReachable = false;
    }
    const failing = Object.keys(controls).filter((id) => !controls[id].aboveFold);
    const consoleErrors = Array.isArray(raw.consoleErrors) ? raw.consoleErrors.slice() : [];
    const overflow = evaluateOverflow(raw.overflow);
    const drawerOpen = raw.overflowDrawerOpen;
    const overflowDrawerOpen = drawerOpen == null ? null : evaluateOverflow(drawerOpen);
    const shots = Array.isArray(raw.shots) ? raw.shots.slice() : [];
    return {
      name: raw.name,
      width: raw.width,
      height: raw.height,
      consoleErrors,
      overflow,
      controls,
      fold: { pass: failing.length === 0, failing },
      drawerOpened: !!raw.drawerOpened,
      headerButtons: raw.headerButtons || "closed",
      overflowDrawerOpen,
      shotsLabelled: Object.fromEntries(shots.map((shot) => [shot, shotLabel])),
      pass: consoleErrors.length === 0 && overflow.pass && allReachable,
      shots
    };
  });
  return {
    baseUrl: meta.baseUrl == null ? null : meta.baseUrl,
    generatedAt: meta.generatedAt || new Date().toISOString(),
    viewports,
    overall: viewports.every((v) => v.pass)
  };
}

/* ---------- browser-side measurement (serialized into page.evaluate) ---------- */

function readOverflowMetrics() {
  return {
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  };
}

/** True when the hamburger button is actually rendered (drawer mode). */
function hamburgerVisible() {
  const btn = document.querySelector("#menu-toggle");
  return !!btn && getComputedStyle(btn).display !== "none" && btn.offsetParent !== null;
}

/**
 * State of one key control. Reachable means present, visible, and either inside
 * the viewport or reachable by scrolling its own scroll container(s): every
 * scrollable ancestor is snapshotted, scrollIntoView runs, then the snapshot is
 * restored so the screenshot still shows the natural scroll position.
 * aboveFold is measured at that natural position and kept as a separate result.
 * "Above the fold" refuses controls a scrollable ancestor keeps out of view: the
 * left column and the workspace are independent scrollers, so a control parked
 * below the fold inside them is not above the fold (reaching it needs a scroll).
 * page.evaluate serializes only this function, so the clipping walk is inlined
 * here on purpose — a module-level helper would not cross into the browser.
 */
function measureControl(selector) {
  const root = document.documentElement;
  const vw = root.clientWidth;
  const vh = root.clientHeight;
  const el = document.querySelector(selector);
  if (!el) return { present: false, visible: false, reachable: false, aboveFold: false };
  const style = getComputedStyle(el);
  const box = el.getBoundingClientRect();
  const meetsViewport = (r) =>
    r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  const visible =
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    Number(style.opacity) > 0 &&
    box.width > 0 &&
    box.height > 0;
  let clipped = false;
  for (let node = el.parentElement; node && !clipped; node = node.parentElement) {
    const s = getComputedStyle(node);
    const scrollsY =
      /auto|scroll|overlay/.test(s.overflowY) && node.scrollHeight > node.clientHeight;
    const scrollsX = /auto|scroll|overlay/.test(s.overflowX) && node.scrollWidth > node.clientWidth;
    if (!scrollsY && !scrollsX) continue;
    const r = node.getBoundingClientRect();
    const visH = Math.min(box.bottom, r.bottom) - Math.max(box.top, r.top);
    const visW = Math.min(box.right, r.right) - Math.max(box.left, r.left);
    if (visH < Math.min(box.height, 4) || visW < Math.min(box.width, 4)) clipped = true;
  }
  const aboveFold = visible && meetsViewport(box) && !clipped;
  let reachable = aboveFold;
  if (!reachable) {
    const snapshots = [];
    for (let node = el.parentElement; node; node = node.parentElement) {
      const s = getComputedStyle(node);
      const scrollsY =
        /auto|scroll|overlay/.test(s.overflowY) && node.scrollHeight > node.clientHeight;
      const scrollsX =
        /auto|scroll|overlay/.test(s.overflowX) && node.scrollWidth > node.clientWidth;
      if (scrollsY || scrollsX) snapshots.push([node, node.scrollTop, node.scrollLeft]);
    }
    const winScroll = [window.scrollX, window.scrollY];
    try {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch {
      /* older engine: keep the geometric verdict */
    }
    reachable = visible && meetsViewport(el.getBoundingClientRect());
    for (const [node, top, left] of snapshots) {
      node.scrollTop = top;
      node.scrollLeft = left;
    }
    window.scrollTo(winScroll[0], winScroll[1]);
  }
  return { present: true, visible, reachable, aboveFold };
}

/* ---------- run ---------- */

function bustCache(baseUrl) {
  const url = new URL(baseUrl);
  url.searchParams.set("cb", String(Date.now()));
  return url.toString();
}

function selectViewports(only) {
  const names = String(only || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!names.length) return VIEWPORTS;
  const unknown = names.filter((n) => !VIEWPORTS.some((v) => v.name === n));
  if (unknown.length) {
    process.stderr.write(`ui-shots: unknown viewport(s) ignored: ${unknown.join(", ")}\n`);
  }
  const wanted = new Set(names);
  const selected = VIEWPORTS.filter((v) => wanted.has(v.name));
  if (!selected.length) throw new Error(`ONLY matched no viewport: ${only}`);
  return selected;
}

/** One context + page: load, settle, screenshot, then measure.
 *
 * Order of operations for the dark run:
 *   1. closed-state screenshot + closed-state overflow + header / synthesize
 *      controls (the hamburger is only *rendered*, never clicked);
 *   2. on viewports <= DRAWER_MAX_WIDTH (shouldOpenDrawer): click the
 *      hamburger, screenshot `<name>-drawer-open-dark.png`, re-measure overflow
 *      and the sidebar controls with the drawer actually open, close it again.
 * Only the hamburger is ever clicked: it toggles a CSS class, submits nothing
 * and issues no request, so the run stays read-only in substance. */
async function shootViewport(browser, viewport, theme, opts) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: theme
  });
  await context.addInitScript(
    (args) => {
      const [key, value] = args;
      try {
        localStorage.setItem(key, value);
      } catch {
        /* privacy mode / about:blank: colorScheme still applies */
      }
    },
    [THEME_STORAGE_KEY, theme]
  );
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && consoleErrors.length < CONSOLE_ERROR_CAP) {
      consoleErrors.push(`console.error: ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    if (consoleErrors.length < CONSOLE_ERROR_CAP) {
      consoleErrors.push(`pageerror: ${err && err.message ? err.message : String(err)}`);
    }
  });
  // Read-only guard: GET/HEAD fall through to the network, anything else aborts.
  await page.route("**/*", (route) => {
    if (READ_ONLY_METHODS.has(route.request().method())) route.fallback();
    else route.abort();
  });
  try {
    await page.goto(bustCache(opts.baseUrl), { waitUntil: "load" });
    await page.waitForTimeout(SETTLE_MS);
    const shots = [`${viewport.name}-${theme}.png`];
    await page.screenshot({
      path: path.join(opts.outDir, shots[0]),
      animations: "disabled"
    });
    if (!opts.checks) {
      return { ...viewport, consoleErrors, overflow: null, controls: null, shots };
    }
    // Closed state: page overflow + everything that is not inside the drawer.
    const overflow = await page.evaluate(readOverflowMetrics);
    const controls = {};
    for (const [id, selector] of Object.entries(KEY_CONTROLS)) {
      if (SIDEBAR_CONTROL_IDS.includes(id)) continue;
      controls[id] = await page.evaluate(measureControl, selector);
    }
    let drawerOpened = false;
    let overflowDrawerOpen = null;
    const wantsDrawer = shouldOpenDrawer(viewport.width);
    const hasHamburger = await page.evaluate(hamburgerVisible);
    if (wantsDrawer && hasHamburger) {
      drawerOpened = true;
      await page.click("#menu-toggle");
      await page.waitForSelector("#left.open", { state: "attached" });
      await page.waitForTimeout(DRAWER_SETTLE_MS);
      const drawerShot = `${viewport.name}-drawer-open-dark.png`;
      await page.screenshot({
        path: path.join(opts.outDir, drawerShot),
        animations: "disabled"
      });
      shots.push(drawerShot);
      overflowDrawerOpen = await page.evaluate(readOverflowMetrics);
      for (const id of SIDEBAR_CONTROL_IDS) {
        controls[id] = await page.evaluate(measureControl, KEY_CONTROLS[id]);
      }
      await page.evaluate(() => document.querySelector("#drawer-overlay").click());
      await page.waitForSelector("#left.open", { state: "detached" });
    } else {
      // No drawer at this width (laptop / desktop): the sidebar is part of the
      // page itself, so measure it in place. A viewport that should have had a
      // drawer but has no hamburger still reports unreachable, loudly.
      for (const id of SIDEBAR_CONTROL_IDS) {
        controls[id] = await page.evaluate(measureControl, KEY_CONTROLS[id]);
      }
      if (wantsDrawer) consoleErrors.push("drawer: #menu-toggle not rendered at this viewport");
    }
    return {
      ...viewport,
      consoleErrors,
      overflow,
      controls,
      drawerOpened,
      headerButtons: "closed",
      overflowDrawerOpen,
      shots
    };
  } finally {
    await context.close();
  }
}

/** Raw result for a viewport that could not be measured at all. */
function failedViewport(viewport, err) {
  const message = err && err.message ? err.message : String(err);
  return {
    ...viewport,
    consoleErrors: [`unreachable: ${message}`],
    overflow: null,
    controls: Object.fromEntries(
      Object.keys(KEY_CONTROLS).map((id) => [
        id,
        { present: false, visible: false, reachable: false, aboveFold: false }
      ])
    ),
    drawerOpened: false,
    headerButtons: "closed",
    overflowDrawerOpen: null,
    shots: []
  };
}

async function main() {
  const action = process.env.ACTION;
  if (action) process.stderr.write(`ui-shots: ACTION=${action} (informational only)\n`);
  const baseUrl = process.env.BASE_URL || DEFAULT_BASE_URL;
  const outDir = path.resolve(process.env.OUT_DIR || DEFAULT_OUT_DIR);
  const label = resolveShotLabel(process.env.LABEL); // throws on an unknown label
  const selected = selectViewports(process.env.ONLY);
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const raw = [];
  try {
    for (const viewport of selected) {
      let dark;
      try {
        dark = await shootViewport(browser, viewport, "dark", { baseUrl, outDir, checks: true });
      } catch (err) {
        dark = failedViewport(viewport, err);
      }
      if (viewport.name === LIGHT_SHOT) {
        try {
          const light = await shootViewport(browser, viewport, "light", {
            baseUrl,
            outDir,
            checks: false
          });
          dark.shots.push(...light.shots);
        } catch (err) {
          dark.consoleErrors.push(`light shot failed: ${err && err.message ? err.message : err}`);
        }
      }
      raw.push(dark);
    }
  } finally {
    await browser.close();
  }

  const report = buildReport(raw, {
    baseUrl,
    generatedAt: new Date().toISOString(),
    label
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(json);
  fs.writeFileSync(path.join(outDir, "ui-shots.json"), json);
  for (const vp of report.viewports) {
    if (!vp.pass) {
      const reasons = [];
      if (vp.consoleErrors.length) reasons.push(`${vp.consoleErrors.length} console error(s)`);
      if (!vp.overflow.pass) {
        const o = vp.overflow;
        reasons.push(`overflow ${o.scrollWidth}>${o.clientWidth}`);
      }
      const unreachable = Object.keys(vp.controls).filter((id) => !vp.controls[id].reachable);
      if (unreachable.length) reasons.push(`unreachable: ${unreachable.join(", ")}`);
      process.stderr.write(`ui-shots: ${vp.name} FAILED (${reasons.join("; ")})\n`);
    }
    if (!vp.fold.pass) {
      process.stderr.write(`ui-shots: ${vp.name} fold gaps: ${vp.fold.failing.join(", ")}\n`);
    }
  }
  process.exitCode = report.overall ? 0 : 1;
}

const isMain =
  !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`ui-shots: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 2;
  });
}
