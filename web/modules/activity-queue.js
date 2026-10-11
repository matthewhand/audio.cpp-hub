/* #121 Activity/Queue: on-demand UI; /api/tasks is the source of truth. */
import { $, Api, t as globalT } from "./dom.js";
import { showToast } from "./async-ui.js";

const AQ_LOCALES = {
  "en": {
    "aq.close": "Close",
    "aq.heading": "Activity and queue",
    "aq.stale": "Task status unavailable; displaying unverified data",
    "aq.live": "Live task events",
    "aq.polling": "Polling task status",
    "aq.unavailable": "Task data unavailable",
    "aq.empty": "No recent tasks",
    "aq.unverified": "Unverified",
    "aq.cancel": "Cancel task",
    "aq.cancelling": "Cancelling",
    "aq.cancelFailed": "Could not cancel task",
    "aq.confirmFailed": "Task update could not be verified",
    "aq.status.QUEUED": "Queued",
    "aq.status.RUNNING": "Running",
    "aq.status.DONE": "Done",
    "aq.status.FAILED": "Failed",
    "aq.status.CANCELLED": "Cancelled"
  },
  "zh": {
    "aq.close": "关闭",
    "aq.heading": "任务动态与队列",
    "aq.stale": "任务状态暂不可用，显示的是未验证的数据",
    "aq.live": "实时任务事件",
    "aq.polling": "正在轮询任务状态",
    "aq.unavailable": "任务数据不可用",
    "aq.empty": "暂无最近任务",
    "aq.unverified": "未验证",
    "aq.cancel": "取消任务",
    "aq.cancelling": "正在取消",
    "aq.cancelFailed": "取消任务失败",
    "aq.confirmFailed": "无法验证任务更新",
    "aq.status.QUEUED": "排队中",
    "aq.status.RUNNING": "执行中",
    "aq.status.DONE": "已完成",
    "aq.status.FAILED": "失败",
    "aq.status.CANCELLED": "已取消"
  }
};
function t(key) { return AQ_LOCALES[I18N.lang()]?.[key] || globalT(key); }

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
  const message = stale ? t("aq.stale") : streamLive ? t("aq.live") : t("aq.polling");
  if (status.textContent !== message) status.textContent = message;
  const state = stale ? "stale" : streamLive ? "live" : "polling";
  if (status.dataset.state !== state) status.dataset.state = state;
  const list = $("activity-queue-list");
  list.tabIndex = -1;
  const focusWithin = list.contains(document.activeElement);
  const focusedTaskId = focusWithin ? document.activeElement.dataset?.aqCancelTaskId : null;
  list.replaceChildren();
  if (!rows.length) {
    list.append(node("li", stale ? t("aq.unavailable") : t("aq.empty")));
    if (focusWithin) list.focus({ preventScroll: true });
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
      // Keep the pending control focusable; cancel() guards against duplicate clicks.
      button.setAttribute("aria-disabled", String(pending.has(task.id)));
      button.dataset.aqCancelTaskId = task.id;
      button.setAttribute("aria-label", t(pending.has(task.id) ? "aq.cancelling" : "aq.cancel"));
      button.addEventListener("click", () => void cancel(task.id));
      line.append(button);
    }
    list.append(line);
  }
  if (focusWithin) {
    const button = [...list.querySelectorAll("button")].find(
      el => el.dataset.aqCancelTaskId === focusedTaskId
    );
    (button || list).focus({ preventScroll: true });
  }
}
async function reconcile() {
  if (!opened) return;
  if (inFlight) return inFlight;
  const current = generation;
  const request = Api.list("/api/tasks").then(tasks => {
    if (opened && current === generation) {
      rows = orderActivity(tasks);
      stale = false;
    }
  }).catch(() => {
    if (opened && current === generation) stale = true;
  }).finally(() => {
    if (inFlight === request) inFlight = null;
    if (opened && current === generation) render();
  });
  inFlight = request;
  return request;
}
async function cancel(id) {
  if (!opened || stale || pending.has(id)) return;
  pending.add(id);
  render();
  try {
    await Api.del("/api/tasks/{id}", { params: { id } });
    // A GET that began before DELETE is not valid cancellation confirmation.
    const previous = inFlight;
    if (previous) await previous;
    if (!opened) return;
    await reconcile(); // must issue a new authoritative GET after DELETE
    if (stale) showToast("error", t("aq.confirmFailed"));
  } catch (error) {
    if (opened) showToast("error", t("aq.cancelFailed") + ": " + (error?.message || ""));
  } finally {
    pending.delete(id);
    render();
  }
}
function schedulePoll() {
  if (poll) clearInterval(poll);
  poll = null;
  if (!opened || document.hidden) return;
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
      {stream.addEventListener(name, eventReceived);}
    stream.onopen = () => { if (!opened || document.hidden) return; streamLive = false; schedulePoll(); render(); };
    stream.onerror = () => {
      if (!opened || document.hidden) return;
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
  inFlight = null;
  pending.clear();
  // Privacy also applies to hidden DOM, so never retain previews after close.
  $("activity-queue-list").replaceChildren();
  $("activity-queue-status").textContent = "";
  $("activity-queue-panel").classList.add("hidden");
  $("activity-queue-open").setAttribute("aria-expanded", "false");
  document.removeEventListener("click", privacyClick);
  window.removeEventListener("storage", storageChange);
  document.removeEventListener("visibilitychange", visibilityChange);
}
function relocalize() {
  if (!opened) return;
  $("activity-queue-heading").textContent = t("aq.heading");
  $("activity-queue-close").textContent = t("aq.close");
  $("activity-queue-list").setAttribute("aria-label", t("aq.heading"));
  render();
}
I18N.onChange(relocalize);

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
  relocalize();
  void reconcile();
  connectStream();
  schedulePoll();
}
