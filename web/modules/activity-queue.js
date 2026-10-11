/* #121 Activity/Queue: on-demand UI; /api/tasks is the source of truth. */
import { $, Api, t } from "./dom.js";

const MAX_ROWS = 12;
const POLL_MS = 5000;
const LIVE_POLL_MS = 15000;
const ACTIVE = new Set(["RUNNING", "QUEUED"]);
const ORDER = { RUNNING: 0, QUEUED: 1, DONE: 2, FAILED: 2, CANCELLED: 2 };

let opened = false, rows = [], stale = true, streamLive = false;
let poll = null, stream = null, inFlight = null, generation = 0;
const pending = new Set();

export function orderActivity(items) {
  return (Array.isArray(items) ? items : [])
    .filter(v => v && typeof v.id === "string" && Object.hasOwn(ORDER, v.status))
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] ||
      (ORDER[a.status] < 2
        ? (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0)
        : (Number(b.finishedAt || b.createdAt) || 0) -
          (Number(a.finishedAt || a.createdAt) || 0)) ||
      a.id.localeCompare(b.id)).slice(0, MAX_ROWS);
}
function privacyOn() {
  return localStorage.getItem("hub-privacy") === "1";
}
function node(tag, value, cls) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.textContent = value;
  return el;
}
function render() {
  if (!opened) return;
  const status = $("activity-queue-status");
  status.textContent = stale ? t("aq.stale") : streamLive ? t("aq.live") : t("aq.polling");
  status.dataset.state = stale ? "stale" : streamLive ? "live" : "polling";
  const list = $("activity-queue-list");
  list.replaceChildren();
  if (!rows.length) {
    list.append(node("li", stale ? t("aq.unavailable") : t("aq.empty")));
    return;
  }
  const privacy = privacyOn();
  for (const task of orderActivity(rows)) {
    const line = node("li", "", "aq-row");
    const statusLabel = t("aq.status." + task.status);
    const instance = String(task.instanceName || task.modelId || task.instanceId || "");
    const preview = privacy ? t("history.masked") : String(task.text || "");
    line.append(node("span", statusLabel, "aq-status"),
      node("span", instance, "aq-instance"),
      node("span", preview, "aq-preview"));
    if (stale) {
      line.append(node("span", t("aq.unverified"), "aq-status"));
    } else if (ACTIVE.has(task.status)) {
      const button = node("button", pending.has(task.id) ? t("aq.cancelling") : t("aq.cancel"), "btn-ghost");
      button.type = "button";
      button.disabled = pending.has(task.id);
      button.setAttribute("aria-label", t("aq.cancel"));
      button.addEventListener("click", () => void cancel(task.id));
      line.append(button);
    }
    list.append(line);
  }
}
async function reconcile() {
  if (!opened) return;
  if (inFlight) return inFlight;
  const current = generation;
  inFlight = Api.list("/api/tasks").then(tasks => {
    if (opened && current === generation) {
      rows = orderActivity(tasks);
      stale = false;
    }
  }).catch(() => {
    if (opened && current === generation) stale = true;
  }).finally(() => {
    inFlight = null;
    if (opened && current === generation) render();
  });
  return inFlight;
}
async function cancel(id) {
  if (!opened || stale || pending.has(id)) return;
  pending.add(id);
  render();
  try {
    await Api.del("/api/tasks/{id}", { params: { id } });
    await reconcile(); // API confirmation, not an optimistic CANCELLED label
  } catch {
    stale = true;
  } finally {
    pending.delete(id);
    render();
  }
}
function schedulePoll() {
  if (poll) clearInterval(poll);
  poll = setInterval(() => {
    if (!document.hidden) void reconcile();
  }, streamLive ? LIVE_POLL_MS : POLL_MS);
}
function eventReceived(event) {
  if (!opened) return;
  if (event.type !== "hello") {
    try { JSON.parse(event.data); } catch { return; }
  }
  streamLive = true;
  schedulePoll();
  void reconcile();
}
function connectStream() {
  if (typeof EventSource === "undefined" || document.hidden) return;
  try {
    stream = new EventSource("/api/events/stream");
    for (const name of ["hello", "task.queued", "task.started", "task.finished", "task.failed", "task.cancelled"])
      stream.addEventListener(name, eventReceived);
    stream.onopen = () => { streamLive = false; schedulePoll(); render(); };
    stream.onerror = () => {
      streamLive = false;
      schedulePoll(); // 404/503/disconnect/reconnect use authoritative polling
      void reconcile();
    };
  } catch {
    streamLive = false;
    schedulePoll();
  }
}
function privacyClick(event) {
  // Existing History onclick writes localStorage before this document bubble handler.
  if (event.target.closest("#history-privacy")) render();
}
function storageChange(event) {
  if (!event.key || event.key === "hub-privacy") render();
}
function visibilityChange() {
  if (document.hidden) {
    if (poll) clearInterval(poll);
    poll = null;
    if (stream) stream.close();
    stream = null;
    streamLive = false;
  } else if (opened) {
    void reconcile();
    connectStream();
    schedulePoll();
  }
}
function close() {
  opened = false;
  generation++;
  if (poll) clearInterval(poll);
  poll = null;
  if (stream) stream.close();
  stream = null;
  streamLive = false;
  stale = true;
  rows = [];
  pending.clear();
  $("activity-queue-panel").classList.add("hidden");
  $("activity-queue-open").setAttribute("aria-expanded", "false");
  document.removeEventListener("click", privacyClick);
  window.removeEventListener("storage", storageChange);
  document.removeEventListener("visibilitychange", visibilityChange);
}
export function toggleActivityQueue() {
  if (opened) { close(); return; }
  opened = true;
  generation++;
  stale = true;
  rows = [];
  $("activity-queue-panel").classList.remove("hidden");
  $("activity-queue-open").setAttribute("aria-expanded", "true");
  $("activity-queue-close").onclick = close;
  document.addEventListener("click", privacyClick);
  window.addEventListener("storage", storageChange);
  document.addEventListener("visibilitychange", visibilityChange);
  if (!$("activity-queue-css")) {
    const stylesheet = document.createElement("link");
    stylesheet.id = "activity-queue-css";
    stylesheet.rel = "stylesheet";
    stylesheet.href = "/activity-queue.css";
    document.head.append(stylesheet);
  }
  render();
  void reconcile();
  connectStream();
  schedulePoll();
}