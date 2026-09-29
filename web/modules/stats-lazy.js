/* web/modules/stats-lazy.js — lazy facade for the #/stats dashboard.
 *
 * The dashboard is a click-to-open view that most sessions never open, so it is
 * NOT part of the first-load module graph. routing.js imports this small facade
 * eagerly (it costs a few hundred bytes) and pulls the real module in on demand:
 *
 *     import("./stats.js").then(m => m.openStatsPanel())
 *
 * Why a facade instead of inlining import() at each call site: closeStatsPanel()
 * is called *synchronously* from applyRoute() and from the Esc handler, including
 * when the module has never been loaded. This facade keeps that path synchronous
 * and side-effect free (a no-op if the panel was never opened) while the async
 * open path awaits the chunk.
 *
 * Once loaded, stats.js binds its own DOM handlers, so the header button works
 * through the route and needs no wiring here. */

let mod = null; // resolved stats.js module namespace, null until first open
let inflight = null; // in-flight dynamic import, so concurrent opens share one

/* The header button must work before the chunk loads, so it is wired here rather
   than in stats.js. goPanel is passed in by routing.js to avoid a module cycle
   (stats.js -> routing.js -> stats-lazy.js). */
export function wireStatsButton(goPanel) {
  const btn = document.getElementById("stats-btn");
  if (btn) btn.onclick = () => goPanel("stats");
}

/* Load the real module (idempotent, de-duplicated). */
function ensure() {
  if (mod) return Promise.resolve(mod);
  if (!inflight) {
    inflight = import("./stats.js").then(
      m => (mod = m),
      e => {
        // Allow a later attempt to retry rather than caching the failure forever.
        inflight = null;
        throw e;
      }
    );
  }
  return inflight;
}

/* Open the dashboard: show the panel shell immediately, then swap in the real
   behaviour once the chunk arrives. Showing the shell first keeps the click
 * feeling instant even though the module is still on the wire. */
export async function openStatsPanel() {
  const panel = document.getElementById("stats-panel");
  if (panel && panel.classList.contains("hidden")) {
    panel.classList.remove("hidden");
  }
  try {
    const m = await ensure();
    m.openStatsPanel();
  } catch (e) {
    // Surface the failure instead of leaving an empty panel open forever.
    console.error("stats: failed to load dashboard module", e);
    if (panel) panel.classList.add("hidden");
  }
}

/* Synchronous close: safe to call even when the module was never loaded. */
export function closeStatsPanel() {
  const panel = document.getElementById("stats-panel");
  if (!panel || panel.classList.contains("hidden")) return;
  if (mod) {
    mod.closeStatsPanel();
    return;
  }
  // Never loaded: nothing to restore focus for, just hide the shell we showed.
  panel.classList.add("hidden");
}

/* Synchronous re-render hook used by app.js rerenderAll() on language switch.
 * No-op until the module is loaded; once loaded it re-renders in place. */
export function reloadStats() {
  if (mod) mod.loadStats();
}
