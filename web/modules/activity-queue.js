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
const STREAM_RETRY_INITIAL_MS = 2000;
const STREAM_RETRY_MAX_MS = 60000;
const ACTIVE = new Set(["RUNNING", "QUEUED"]);
const ORDER = { RUNNING: 0, QUEUED: 1, DONE: 2, FAILED: 2, CANCELLED: 2 };

let opened = false, rows = [], stale = true, streamLive = false;
let poll = null, stream = null, inFlight = null, generation = 0;
let streamRetry = null, streamRetryDelay = STREAM_RETRY_INITIAL_MS;
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
function updateText(el, value) {
  if (el.textContent !== value) el.textContent = value;
}
function render() {
  if (!opened) return;
  const status = $("activity-queue-status");
  const message = stale ? t("aq.stale") : streamLive ? t("aq.live") : t("aq.polling");
  updateText(status, message); // avoid repeat aria-live announcements
  const state = stale ? "stale" : streamLive ? "live" : "polling";
  if (status.dataset.state !== state) status.dataset.state = state;
  const list = $("activity-queue-list");
  list.tabIndex = -1; // focus fallback if a task becomes terminal
  const focusWithin = list.contains(document.activeElement);
  const priorFocus = focusWithin ? document.activeElement : null;
  const existing = new Map([...list.querySelectorAll(".aq-row")].map(el => [el.dataset.aqTaskId, el]));
  const ordered = [];
  for (const task of orderActivity(rows)) {
    let line = existing.get(task.id);
    if (!line) {
      line = node("li", "", "aq-row");
      line.dataset.aqTaskId = task.id; // id only, never the task text
      line.append(node("span", "", "aq-status"), node("span", "", "aq-instance"),
        node("span", "", "aq-preview"));
    }
    updateText(line.querySelector(".aq-status"), t("aq.status." + task.status));
    updateText(line.querySelector(".aq-instance"),
      String(task.instanceName || task.modelId || task.instanceId || ""));
    updateText(line.querySelector(".aq-preview"),
      privacyOn() ? t("history.masked") : String(task.text || ""));
    let unverified = line.querySelector(".aq-unverified");
    let button = line.querySelector("button");
    if (stale) {
      if (button) button.remove();
      if (!unverified) {
        unverified = node("span", "", "aq-status aq-unverified");
        line.append(unverified);
      }
      updateText(unverified, t("aq.unverified"));
    } else if (ACTIVE.has(task.status)) {
      if (unverified) unverified.remove();
      if (!button) {
        button = node("button", "", "btn-ghost");
        button.type = "button";
        button.dataset.aqCancelTaskId = task.id;
        button.addEventListener("click", () => void cancel(task.id));
        line.append(button);
      }
      const cancelling = pending.has(task.id);
      button.setAttribute("aria-disabled", String(cancelling));
      updateText(button, t(cancelling ? "aq.cancelling" : "aq.cancel"));
      button.setAttribute("aria-label", t(cancelling ? "aq.cancelling" : "aq.cancel"));
    } else {
      if (button) button.remove();
      if (unverified) unverified.remove();
    }
    ordered.push(line);
  }
  if (!ordered.length) {
    if (list.children.length !== 1 || !list.firstElementChild.classList.contains("aq-empty")) {
      list.replaceChildren(node("li", "", "aq-empty"));
    }
    updateText(list.firstElementChild, stale ? t("aq.unavailable") : t("aq.empty"));
  } else {
    // Move only out-of-order rows, never remount a row that remains in position.
    let cursor = list.firstChild;
    for (const row of ordered) {
      if (row === cursor) cursor = cursor.nextSibling;
      else list.insertBefore(row, cursor);
    }
    while (cursor) {
      const next = cursor.nextSibling;
      cursor.remove();
      cursor = next;
    }
  }
  if (focusWithin && !list.contains(document.activeElement)) {
    const target = priorFocus?.isConnected && list.contains(priorFocus) ? priorFocus : list;
    target.focus({ preventScroll: true });
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
  const current = generation;
  pending.add(id);
  render();
  try {
    await Api.del("/api/tasks/{id}", { params: { id } });
    // A GET that began before DELETE is not valid cancellation confirmation.
    const previous = inFlight;
    if (previous) await previous;
    if (!opened || generation !== current) return;
    await reconcile(); // must issue a new authoritative GET after DELETE
    if (stale) showToast("error", t("aq.confirmFailed"));
  } catch (error) {
    if (opened && generation === current) {
      showToast("error", t("aq.cancelFailed") + ": " + (error?.message || ""));
    }
  } finally {
    if (opened && generation === current) {
      pending.delete(id);
      render();
    }
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
  } else {
    // A valid handshake, not merely TCP open, resets exponential retry.
    streamRetryDelay = STREAM_RETRY_INITIAL_MS;
  }
  streamLive = true;
  schedulePoll();
  void reconcile();
}
function cancelStreamRetry() {
  if (streamRetry !== null) clearTimeout(streamRetry);
  streamRetry = null;
}
function scheduleStreamRetry() {
  if (!opened || document.hidden || streamRetry !== null) return;
  const delay = streamRetryDelay;
  streamRetryDelay = Math.min(STREAM_RETRY_MAX_MS, delay * 2);
  streamRetry = setTimeout(() => {
    streamRetry = null;
    if (!opened || document.hidden) return;
    // Native EventSource does NOT reconnect after fatal HTTP 503/404.
    // A synchronous constructor/setup failure leaves stream null.
    if (!stream || stream.readyState === EventSource.CLOSED) {
      stream?.close();
      stream = null;
      connectStream();
    }
  }, delay);
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
      // CONNECTING means native retry; CLOSED needs bounded manual retry.
      if (stream?.readyState === EventSource.CLOSED) scheduleStreamRetry();
    };
  } catch {
    // Constructor and listener-registration exceptions leave no usable stream.
    // Keep authoritative polling active, but rearm bounded SSE recovery.
    stream?.close();
    stream = null;
    streamLive = false;
    schedulePoll();
    scheduleStreamRetry();
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
    cancelStreamRetry();
    streamRetryDelay = STREAM_RETRY_INITIAL_MS;
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
  cancelStreamRetry();
  streamRetryDelay = STREAM_RETRY_INITIAL_MS;
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
