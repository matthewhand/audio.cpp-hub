/* web/modules/activity.js — 左栏「最近活动」
 *
 * <details> 放在实例列表和模型列表之间。最近约 20 条任务，新的在上。
 * 直播走 task-events.js 广播的 hub-task-event（不互相 import 成环）。
 * 首屏用 GET /api/tasks 播种；SSE 没连上且面板打开时，约 5s 再拉一次。
 * 顶部一条 10 分钟的横条：每个实例一条泳道。 */

import { $, Api, esc, t } from "./dom.js";
import { instances, syncBusyTimer } from "./instances.js";
import { noteIdleFallback } from "./state.js";
import { isTaskStreamLive } from "./task-events.js";

const OPEN_KEY = "hub-activity-open";
const SEED_POLL_MS = 5000;
const STRIP_TICK_MS = 4000;

const EVENT_STATUS = {
  "task.queued": "queued",
  "task.started": "running",
  "task.finished": "done",
  "task.failed": "failed",
  "task.cancelled": "cancelled"
};

const TASK_STATUS = {
  QUEUED: "queued",
  RUNNING: "running",
  DONE: "done",
  FAILED: "failed",
  CANCELLED: "cancelled"
};

/** 5.1s / 1m 05s. Matches the generating-badge clock. */
export function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "";
  const sec = Math.round((n / 1000) * 10) / 10;
  if (sec < 60) return sec.toFixed(1) + "s";
  return Math.floor(sec / 60) + "m " + String(Math.floor(sec % 60)).padStart(2, "0") + "s";
}

/** Local HH:MM. The row clock column is 5.5ch, which fits this and not seconds. */
export function formatClock(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes());
}

const HEX32 = /^[0-9a-f]{32}$/i;
const ACTIVITY_CAP = 20;

function posTime(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isHex32(v) {
  return HEX32.test(String(v || "").trim());
}

/** Newest moment on the row: max(finishedAt, startedAt, createdAt). queuedAt aliases createdAt. */
export function activitySortAt(row) {
  if (!row) return 0;
  return Math.max(
    posTime(row.finishedAt),
    posTime(row.startedAt),
    posTime(row.createdAt),
    posTime(row.queuedAt)
  );
}

/** Newest first. Equal times break by taskId. Cap after the sort, never before. */
export function sortActivity(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(r => r && r.taskId);
  list.sort((a, b) => {
    const dt = activitySortAt(b) - activitySortAt(a);
    if (dt) return dt;
    return String(a.taskId).localeCompare(String(b.taskId));
  });
  return list.slice(0, ACTIVITY_CAP);
}

function currentInstances() {
  if (typeof instances === "undefined" || !Array.isArray(instances)) return [];
  return instances;
}

/**
 * Visible instance label. Never a 32-hex id.
 * instances list, then payload/task instanceName, then the first 6 chars.
 */
export function activityInstanceName(row, list) {
  const id = row && row.instanceId ? String(row.instanceId) : "";
  const items = Array.isArray(list) ? list : [];
  const hit = id ? items.find(i => i && String(i.id) === id) : null;
  const fromList = hit ? String(hit.instanceName || hit.name || "").trim() : "";
  if (fromList && !isHex32(fromList)) return fromList;
  const named = row && typeof row.instanceName === "string" ? row.instanceName.trim() : "";
  if (named && !isHex32(named)) return named;
  const raw = id || named;
  return raw ? raw.slice(0, 6) : "";
}

function mergeActivity(prev, ev) {
  const next = { ...(prev || {}) };
  next.taskId = ev.taskId;
  if (ev.instanceId) next.instanceId = ev.instanceId;
  if (ev.instanceName && !isHex32(ev.instanceName)) next.instanceName = String(ev.instanceName).trim();
  if (ev.modelId) next.modelId = ev.modelId;
  if (ev.category) next.category = ev.category;
  if (ev.status) next.status = ev.status;
  const started = posTime(ev.startedAt);
  if (started) next.startedAt = started;
  const created = posTime(ev.createdAt) || posTime(ev.queuedAt);
  if (created) {
    if (!posTime(next.createdAt)) next.createdAt = created;
    if (!posTime(next.queuedAt)) next.queuedAt = created;
  }
  const ts = posTime(ev.ts);
  if (ev.status === "queued" && ts && !posTime(next.queuedAt)) {
    next.queuedAt = ts;
    if (!posTime(next.createdAt)) next.createdAt = ts;
  }
  if (ev.status === "running" && !posTime(next.startedAt) && ts) next.startedAt = ts;
  const terminal = ev.status === "done" || ev.status === "failed" || ev.status === "cancelled";
  if (terminal) {
    const fin = posTime(ev.finishedAt);
    const dur = Number(ev.durationMs);
    if (fin) next.finishedAt = fin;
    else if (!posTime(next.finishedAt) && posTime(next.startedAt) && Number.isFinite(dur) && dur >= 0) {
      next.finishedAt = posTime(next.startedAt) + dur;
    } else if (!posTime(next.finishedAt) && ts) next.finishedAt = ts;
  }
  return next;
}

/**
 * Insert or replace one event by taskId. Newest first, capped at 20.
 * Fields the new event omits are kept from the previous row.
 */
export function upsertEvent(rows, ev) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (!ev || !ev.taskId || !ev.status) return list;
  const i = list.findIndex(r => r && r.taskId === ev.taskId);
  const merged = mergeActivity(i >= 0 ? list[i] : null, ev);
  if (i >= 0) list[i] = merged;
  else list.push(merged);
  return sortActivity(list);
}

/** Map GET /api/tasks entries into activity rows (unknown statuses dropped). */
export function rowsFromTasks(tasks) {
  let rows = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const status = task && TASK_STATUS[task.status];
    if (!status || !task.id) continue;
    rows = upsertEvent(rows, {
      taskId: task.id,
      instanceId: task.instanceId,
      instanceName: task.instanceName,
      modelId: task.modelId,
      category: task.category,
      status,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      createdAt: task.createdAt,
      queuedAt: task.createdAt,
      ts: task.createdAt
    });
  }
  return sortActivity(rows);
}

/**
 * Last-10-minute strip. left/width are fractions of the window.
 * Running rows extend to now. Tasks that end before the window are omitted.
 * A row with no start time is omitted (queued-only).
 */
export function stripRects(rows, nowMs) {
  const windowMs = 10 * 60 * 1000;
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const start = now - windowMs;
  const byInst = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const began = Number(row.startedAt);
    if (!Number.isFinite(began) || began <= 0) continue;
    let end = Number(row.finishedAt);
    if (row.status === "running" || row.status === "queued") end = now;
    else if (!Number.isFinite(end) || end <= 0) end = began;
    if (end < start || began > now) continue;
    const a = Math.max(began, start);
    const b = Math.min(Math.max(end, a), now);
    if (b <= a && row.status !== "running") continue;
    const width = Math.max(b - a, row.status === "running" ? 1 : 0);
    if (width <= 0) continue;
    const id = String(row.instanceId || row.instanceName || "?");
    if (!byInst.has(id)) byInst.set(id, { instanceName: "", rects: [] });
    const bucket = byInst.get(id);
    const label = row.instanceName && !isHex32(row.instanceName) ? String(row.instanceName).trim() : "";
    if (label) bucket.instanceName = label;
    bucket.rects.push({
      taskId: row.taskId || "",
      status: row.status || "queued",
      left: (a - start) / windowMs,
      width: Math.min(1, width / windowMs)
    });
  }
  const lanes = [...byInst.keys()].sort().map(instanceId => {
    const bucket = byInst.get(instanceId);
    return {
      instanceId,
      instanceName: bucket.instanceName || String(instanceId).slice(0, 6),
      rects: bucket.rects
    };
  });
  return { lanes, windowMs };
}

let rows = [];
let pollTimer = null;
let stripTimer = null;

function panelEl() { return $("activity-panel"); }

function panelOpen() {
  const p = panelEl();
  if (!p) return true;
  if (p.open === false) return false;
  if (p.open === true) return true;
  return typeof p.hasAttribute === "function" ? p.hasAttribute("open") : true;
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function stopStrip() {
  if (stripTimer) { clearInterval(stripTimer); stripTimer = null; }
}

function rowDurationHtml(row, now) {
  if (row.status === "running") {
    const start = posTime(row.startedAt);
    if (!start) return "";
    const elapsed = Math.max(0, now - start);
    return `<span class="badge-elapsed num" data-start="${start}">${esc(formatDuration(elapsed))}</span>`;
  }
  const began = posTime(row.startedAt) || posTime(row.createdAt) || posTime(row.queuedAt);
  const end = posTime(row.finishedAt);
  if (!began || !end || end < began) return "";
  return `<span class="num">${esc(formatDuration(end - began))}</span>`;
}

function rowHtml(row, now) {
  const status = row.status || "queued";
  const when = formatClock(activitySortAt(row));
  const name = activityInstanceName(row, currentInstances());
  const statusText = t("activity.status." + status);
  const tip = t("activity.rowTip", {
    id: String(row.taskId || "").slice(0, 8),
    category: row.category || "",
    model: row.modelId || ""
  });
  return `<div class="act-row">
    <span class="act-time num">${esc(when)}</span>
    <span class="act-name" title="${esc(tip)}">${esc(name)}</span>
    <span class="act-status ${esc(status)}"><i class="act-dot" aria-hidden="true"></i><span class="act-status-text">${esc(statusText)}</span></span>
    <span class="act-dur">${rowDurationHtml(row, now)}</span>
  </div>`;
}

function stripHtml(now) {
  const named = rows.map(r => {
    const instanceName = activityInstanceName(r, currentInstances());
    return instanceName ? { ...r, instanceName } : r;
  });
  const { lanes } = stripRects(named, now);
  const caption = `<p class="act-strip-caption">${esc(t("activity.stripCaption"))}</p>`;
  if (!lanes.length) return caption;
  const n = lanes.reduce((sum, lane) => sum + lane.rects.length, 0);
  const label = t("activity.stripAria", { n, lanes: lanes.length });
  const W = 160;
  const H = Math.max(14, lanes.length * 8 + 4);
  let body = "";
  lanes.forEach((lane, i) => {
    const y = 2 + i * 8;
    const laneName = lane.instanceName && !isHex32(lane.instanceName)
      ? lane.instanceName
      : String(lane.instanceId || "").slice(0, 6);
    body += `<g class="act-lane" aria-label="${esc(laneName)}">`;
    body += `<text class="act-lane-label" x="1" y="${y + 4}">${esc(laneName)}</text>`;
    body += `<rect class="act-lane-bg" x="0" y="${y}" width="${W}" height="5" rx="1"></rect>`;
    for (const r of lane.rects) {
      const x = Math.round(r.left * W * 10) / 10;
      const w = Math.max(1.5, Math.round(r.width * W * 10) / 10);
      body += `<rect class="act-rect ${esc(r.status)}" x="${x}" y="${y}" width="${w}" height="5" rx="1"><title>${esc(r.taskId)}</title></rect>`;
    }
    body += `</g>`;
  });
  return caption + `<svg class="act-strip" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${esc(label)}" focusable="false">${body}</svg>`;
}

export function renderActivity(nowMs) {
  const list = $("activity-list");
  const empty = $("activity-empty");
  const strip = $("activity-strip");
  if (!list && !strip) return;
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  rows = sortActivity(rows);
  if (strip) strip.innerHTML = stripHtml(now);
  if (list) list.innerHTML = rows.map(r => rowHtml(r, now)).join("");
  if (empty && empty.classList) empty.classList.toggle("hidden", rows.length > 0);
  if (typeof syncBusyTimer === "function") syncBusyTimer();
}

function rememberIdle(instanceId, ts) {
  if (typeof noteIdleFallback === "function") noteIdleFallback(instanceId, ts);
}

export function seedActivity(tasks) {
  let next = rows.slice();
  for (const row of rowsFromTasks(tasks)) next = upsertEvent(next, row);
  rows = sortActivity(next);
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || !task.instanceId || !task.finishedAt) continue;
    if (task.status === "QUEUED" || task.status === "RUNNING") continue;
    rememberIdle(task.instanceId, task.finishedAt);
  }
  if (panelOpen()) renderActivity();
}

function onTaskEvent(ev) {
  const detail = ev && ev.detail || {};
  const status = EVENT_STATUS[detail.name];
  const data = detail.data || {};
  if (!status || !data.taskId) return;
  rows = upsertEvent(rows, {
    taskId: data.taskId,
    instanceId: data.instanceId,
    instanceName: data.instanceName,
    modelId: data.modelId,
    category: data.category,
    status,
    ts: data.ts,
    durationMs: data.durationMs,
    finishedAt: data.finishedAt
  });
  if (status === "done" || status === "failed" || status === "cancelled") {
    rememberIdle(data.instanceId, data.ts);
  }
  if (panelOpen()) renderActivity();
}

function pullTasks() {
  if (!Api || typeof Api.get !== "function") return;
  Api.get("/api/tasks").then((data) => {
    seedActivity(Array.isArray(data) ? data.slice(0, 40) : []);
  }).catch(() => {});
}

function ensurePoll() {
  if (pollTimer || !panelOpen()) return;
  if (typeof isTaskStreamLive === "function" && isTaskStreamLive()) return;
  pollTimer = setInterval(() => {
    if (!panelOpen() || (typeof isTaskStreamLive === "function" && isTaskStreamLive())) {
      stopPoll();
      return;
    }
    pullTasks();
  }, SEED_POLL_MS);
}

function ensureStrip() {
  if (stripTimer || !panelOpen()) return;
  stripTimer = setInterval(() => {
    if (!panelOpen()) { stopStrip(); return; }
    renderActivity();
  }, STRIP_TICK_MS);
}

export function startActivity() {
  const panel = panelEl();
  if (panel) {
    try {
      if (typeof localStorage !== "undefined" && localStorage.getItem(OPEN_KEY) === "0") panel.open = false;
    } catch { /* private mode */ }
    if (panel.addEventListener) {
      panel.addEventListener("toggle", () => {
        try {
          if (typeof localStorage !== "undefined") localStorage.setItem(OPEN_KEY, panel.open ? "1" : "0");
        } catch { /* ignore */ }
        if (panelOpen()) { ensurePoll(); ensureStrip(); pullTasks(); renderActivity(); }
        else { stopPoll(); stopStrip(); }
      });
    }
  }
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("hub-task-event", onTaskEvent);
    window.addEventListener("hub-instances-updated", () => {
      if (panelOpen()) renderActivity();
    });
    window.addEventListener("hub-task-stream", () => {
      if (typeof isTaskStreamLive === "function" && isTaskStreamLive()) stopPoll();
      else ensurePoll();
    });
  }
  pullTasks();
  ensurePoll();
  ensureStrip();
  renderActivity();
}

/** Test-only reset. */
export function resetActivity() {
  rows = [];
  stopPoll();
  stopStrip();
}
