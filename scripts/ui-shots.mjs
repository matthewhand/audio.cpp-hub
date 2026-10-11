/* UI verification shots (dev-only, no product code involved).
 *
 * Walks the fixed viewport matrix from AGENTS.md "UI verification standard"
 * against a running hub (or any BASE_URL that serves web/) and records, per
 * viewport:
 *   - console errors (console.error + pageerror)
 *   - horizontal overflow (documentElement.scrollWidth vs clientWidth)
 *   - key control state: present / visible / reachable / above the fold
 * One dark screenshot per viewport, plus exactly one light screenshot on
 * LIGHT_SHOT. The run is strictly read-only: nothing is clicked, no form is
 * submitted, and every non-GET/HEAD request is aborted.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:18080 OUT_DIR=./ui-shots-out node scripts/ui-shots.mjs
 *   ONLY=mobile-360x800,laptop-1280x720 node scripts/ui-shots.mjs   (subset)
 *   ACTION=generating BASE_URL=... node scripts/ui-shots.mjs        (optional note)
 *
 * One JSON document goes to stdout (a copy lands in OUT_DIR/ui-shots.json);
 * exit code is 1 when any viewport fails its pass criteria. Fold failures are
 * reported separately and never flip the verdict on their own.
 *
 * The pure helpers (VIEWPORTS / LIGHT_SHOT / KEY_CONTROLS / evaluateOverflow /
 * buildReport) are exported so test/unit/ui-shots.test.mjs can pin them
 * without launching a browser. main() only runs when executed directly. */
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
  "voices-btn": "#voices-btn",
  "history-btn": "#history-btn",
  "downloads-btn": "#downloads-btn",
  "lang-toggle": "#lang-toggle",
  "settings-btn": "#settings-btn",
  "theme-toggle": "#theme-toggle"
};

const DEFAULT_BASE_URL = "http://127.0.0.1:4173";
const DEFAULT_OUT_DIR = "./ui-shots-out";
const SETTLE_MS = 4000; // let the 2s pollers settle before measuring / shooting
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
 */
export function buildReport(results, meta = {}) {
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
    return {
      name: raw.name,
      width: raw.width,
      height: raw.height,
      consoleErrors,
      overflow,
      controls,
      fold: { pass: failing.length === 0, failing },
      pass: consoleErrors.length === 0 && overflow.pass && allReachable,
      shots: Array.isArray(raw.shots) ? raw.shots.slice() : []
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

/**
 * State of one key control. Reachable means present, visible, and either inside
 * the viewport or reachable by scrolling its own scroll container(s): every
 * scrollable ancestor is snapshotted, scrollIntoView runs, then the snapshot is
 * restored so the screenshot still shows the natural scroll position.
 * aboveFold is measured at that natural position and kept as a separate result.
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
  const aboveFold = visible && meetsViewport(box);
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

/** One context + page: load, settle, screenshot, then measure. */
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
    const shot = `${viewport.name}-${theme}.png`;
    await page.screenshot({
      path: path.join(opts.outDir, shot),
      animations: "disabled"
    });
    let overflow = null;
    let controls = null;
    if (opts.checks) {
      overflow = await page.evaluate(readOverflowMetrics);
      controls = {};
      for (const [id, selector] of Object.entries(KEY_CONTROLS)) {
        controls[id] = await page.evaluate(measureControl, selector);
      }
    }
    return { ...viewport, consoleErrors, overflow, controls, shots: [shot] };
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
    shots: []
  };
}

async function main() {
  const action = process.env.ACTION;
  if (action) process.stderr.write(`ui-shots: ACTION=${action} (informational only)\n`);
  const baseUrl = process.env.BASE_URL || DEFAULT_BASE_URL;
  const outDir = path.resolve(process.env.OUT_DIR || DEFAULT_OUT_DIR);
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

  const report = buildReport(raw, { baseUrl, generatedAt: new Date().toISOString() });
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
