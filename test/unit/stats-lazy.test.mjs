/* Unit tests for the lazy dashboard facade (web/modules/stats-lazy.js).
 *
 * The facade exists so the #/stats view can be pulled in with a dynamic import()
 * without landing in the first-load module graph. Its contract:
 *   - openStatsPanel() shows the panel shell immediately, then loads the module;
 *   - closeStatsPanel() is SYNCHRONOUS and must be a safe no-op when the module
 *     was never loaded (applyRoute() and the Esc handler call it that way);
 *   - reloadStats() likewise no-ops until loaded;
 *   - concurrent opens share a single in-flight import;
 *   - a failed import hides the panel again and logs, rather than leaving it empty.
 *
 * It uses document.getElementById directly (not the $ helper) so it can run
 * against a minimal fake DOM in a vm realm, like the other module tests. */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const SRC = fs.readFileSync(path.join(REPO, "web/modules/stats-lazy.js"), "utf8");

function makePanel({ hidden = true } = {}) {
  return {
    classList: {
      _hidden: hidden,
      contains(c) {
        return c === "hidden" ? this._hidden : false;
      },
      add(c) {
        if (c === "hidden") this._hidden = true;
      },
      remove(c) {
        if (c === "hidden") this._hidden = false;
      }
    }
  };
}

/* Minimal stand-in for the real stats.js module namespace. */
function fakeModule(log) {
  return {
    openStatsPanel() {
      log.push(["mod.openStatsPanel"]);
    },
    closeStatsPanel() {
      log.push(["mod.closeStatsPanel"]);
    },
    loadStats() {
      log.push(["mod.loadStats"]);
    }
  };
}

/*
 * Load the facade in a vm realm. It is ESM, so we reuse the same technique as
 * routing.test.mjs: strip import/export, then hand it a controllable
 * `__loadStats()` in place of the real `import("./stats.js")`.
 */
function makeLazy({ panel = makePanel(), importImpl } = {}) {
  const btn = { onclick: null };
  const log = [];
  const body = SRC.replace(/^import\s[\s\S]*?from\s*["'][^"']*["'];?[ \t]*$/gm, "")
    .replace(/^export\s+(?=(?:async\s+)?(?:const|let|var|function|class)\b)/gm, "")
    // Redirect the real dynamic import to the sandbox loader. Anchored on
    // `inflight = ` so we rewrite the executable call, not the identical text
    // in the header comment.
    .replace(/inflight = import\("\.\/stats\.js"\)/, "inflight = __loadStats()");
  const mod = importImpl ? null : fakeModule(log);
  const sandbox = {
    console: { error: (...a) => log.push(["error", ...a]) },
    document: {
      getElementById(id) {
        if (id === "stats-panel") return panel;
        if (id === "stats-btn") return btn;
        return null;
      }
    },
    __loadStats: () => (importImpl ? importImpl() : Promise.resolve(mod))
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  new vm.Script(
    `${body}\n;globalThis.__module = { openStatsPanel, closeStatsPanel, reloadStats, wireStatsButton };`,
    { filename: "stats-lazy.js" }
  ).runInContext(ctx);
  return { api: sandbox.__module, sandbox, btn, panel, log };
}

test("stats-lazy: closeStatsPanel 在模块未加载且面板已隐藏时是安全空操作", () => {
  const { api, panel } = makeLazy();
  api.closeStatsPanel(); // never loaded, never opened → no throw
  assert.equal(panel.classList.contains("hidden"), true);
});

test("stats-lazy: closeStatsPanel 在未加载但面板已显示时只隐藏自身，不调真实模块", () => {
  const panel = makePanel({ hidden: false });
  const { api, log } = makeLazy({ panel });
  api.closeStatsPanel();
  assert.equal(panel.classList.contains("hidden"), true);
  assert.equal(
    log.some(([k]) => k === "mod.closeStatsPanel"),
    false,
    "未加载时不应调用真实模块"
  );
});

test("stats-lazy: openStatsPanel 先同步显示面板，加载后交给真实模块", async () => {
  const panel = makePanel({ hidden: true });
  const { api, log } = makeLazy({ panel });
  const p = api.openStatsPanel();
  // Shell visible synchronously, before the chunk resolves.
  assert.equal(panel.classList.contains("hidden"), false);
  await p;
  assert.ok(
    log.some(([k]) => k === "mod.openStatsPanel"),
    "模块加载后应调用真实 openStatsPanel"
  );
  assert.equal(panel.classList.contains("hidden"), false);
});

test("stats-lazy: 并发 open 共享同一次动态 import（只加载一次）", async () => {
  const panel = makePanel({ hidden: true });
  let loads = 0;
  const { api } = makeLazy({
    panel,
    importImpl: () => {
      loads++;
      return Promise.resolve(fakeModule([]));
    }
  });
  await Promise.all([api.openStatsPanel(), api.openStatsPanel(), api.openStatsPanel()]);
  assert.equal(loads, 1, "并发打开只应触发一次动态 import");
});

test("stats-lazy: import 失败时收回面板并记录错误", async () => {
  const panel = makePanel({ hidden: true });
  const { api, log } = makeLazy({
    panel,
    importImpl: () => Promise.reject(new Error("network"))
  });
  await api.openStatsPanel();
  assert.equal(panel.classList.contains("hidden"), true, "加载失败应把面板收回去");
  assert.ok(
    log.some(([k]) => k === "error"),
    "加载失败应记录 console.error"
  );
});

test("stats-lazy: reloadStats 未加载时静默，加载后转发到真实模块", async () => {
  const panel = makePanel({ hidden: true });
  const { api, log } = makeLazy({ panel });
  api.reloadStats(); // not loaded yet → no-op, no throw
  await api.openStatsPanel();
  log.length = 0;
  api.reloadStats();
  assert.ok(
    log.some(([k]) => k === "mod.loadStats"),
    "加载后 reload 应转发"
  );
});

test("stats-lazy: wireStatsButton 把页头按钮接到 goPanel", () => {
  const { api, btn } = makeLazy();
  let route = null;
  api.wireStatsButton((r) => {
    route = r;
  });
  assert.equal(typeof btn.onclick, "function", "wire 后按钮应有 click 处理器");
  btn.onclick();
  assert.equal(route, "stats", "点击应调用传入的 goPanel，并传入当前路由");
});
