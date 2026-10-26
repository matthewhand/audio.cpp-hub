/* web/modules/requests-lazy.js — lazy facade for the #/requests panel (#198); same contract as stats-lazy.js.
 * Keeps close/reload synchronous no-ops until requests.js is loaded. */

let mod = null; // resolved requests.js module namespace, null until first open
let inflight = null; // in-flight dynamic import, so concurrent opens share one

export function wireRequestsButton(goPanel) {
  const btn = document.getElementById("requests-btn");
  if (btn) btn.onclick = () => goPanel("requests");
}

function ensure() {
  if (mod) return Promise.resolve(mod);
  if (!inflight) {
    inflight = import("./requests.js").then(
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

export async function openRequestsPanel() {
  const panel = document.getElementById("requests-panel");
  if (panel && panel.classList.contains("hidden")) {
    panel.classList.remove("hidden");
  }
  try {
    const m = await ensure();
    m.openRequestsPanel();
  } catch (e) {
    // Surface the failure instead of leaving an empty panel open forever.
    console.error("requests: failed to load observability module", e);
    if (panel) panel.classList.add("hidden");
  }
}

export function closeRequestsPanel() {
  const panel = document.getElementById("requests-panel");
  if (!panel || panel.classList.contains("hidden")) return;
  if (mod) {
    mod.closeRequestsPanel();
    return;
  }
  // Never loaded: nothing to restore focus for, just hide the shell we showed.
  panel.classList.add("hidden");
}

export function reloadRequests() {
  if (mod) mod.loadRequests();
}
