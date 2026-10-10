/* web/modules/activity.js — 左栏「最近活动」
 *
 * <details> 放在实例列表和模型列表之间。可见列表在滤掉测试任务之后最多 20 条，
 * 新的在上，按完整时间戳而不是钟点字符串。直播走 task-events.js 广播的
 * hub-task-event（不互相 import 成环）。首屏用 GET /api/tasks 播种；
 * SSE 没连上且面板打开时，约 5s 再拉一次。
 * 顶部一条最近 1 小时的横条：每个真实实例一条泳道，每 10 分钟一个刻度。
 * 这一小时没有真实任务时，改成最近 10 条均匀铺开；一条都没有就不画横条。 */

import { $, Api, esc, t } from "./dom.js";
import { instances, syncBusyTimer } from "./instances.js";
import { isJunkActivityRow } from "./junk.js";
import { models, noteIdleFallback } from "./state.js";
import { isTaskStreamLive } from "./task-events.js";

const OPEN_KEY = "hub-activity-open";
const JUNK_KEY = "hub-activity-show-junk";
const SEED_POLL_MS = 5000;
const STRIP_TICK_MS = 5000;
const STORE_CAP = 100;
const VISIBLE_CAP = 20;
const HOUR_MS = 60 * 60 * 1000;
export const STRIP_PLOT_X = 36;
export const STRIP_PLOT_W = 120;
export const STRIP_MIN_W = 2;

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

/** Local HH:MM. Kept for callers that only want the clock. */
export function formatClock(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes());
}

function activeLocale() {
  if (typeof I18N !== "undefined" && I18N && typeof I18N.locale === "function") {
    const loc = I18N.locale();
    if (loc) return loc;
  }
  return "en";
}

function hourMinute(ms, locale) {
  const parts = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(ms));
  const h = (parts.find(p => p.type === "hour") || {}).value || "";
  const m = (parts.find(p => p.type === "minute") || {}).value || "";
  return h + ":" + m;
}

function monthDay(ms, locale) {
  const parts = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).formatToParts(new Date(ms));
  const month = (parts.find(p => p.type === "month") || {}).value || "";
  const day = (parts.find(p => p.type === "day") || {}).value || "";
  if (/[\u4e00-\u9fff]/.test(month + day) || /月/.test(month)) return month + day;
  return month + " " + day;
}

function sameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * Today is HH:MM. Yesterday is the i18n prefix plus HH:MM.
 * Older is month + day + HH:MM in the active language ("Oct 9 18:55").
 */
export function formatActivityWhen(ms, nowMs) {
  const n = Number(ms);
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  if (!Number.isFinite(n) || n <= 0) return "";
  const locale = activeLocale();
  const time = hourMinute(n, locale);
  const day = new Date(n);
  const today = new Date(now);
  if (sameLocalDay(day, today)) return time;
  const yest = new Date(now);
  yest.setDate(yest.getDate() - 1);
  if (sameLocalDay(day, yest)) return t("activity.yesterday", { t: time });
  return monthDay(n, locale) + " " + time;
}

const HEX32 = /^[0-9a-f]{32}$/i;

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

/** Newest first by full epoch ms. Store cap is applied after the sort. */
export function sortActivity(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(r => r && r.taskId);
  list.sort((a, b) => {
    const dt = activitySortAt(b) - activitySortAt(a);
    if (dt) return dt;
    return String(a.taskId).localeCompare(String(b.taskId));
  });
  return list.slice(0, STORE_CAP);
}

function currentInstances() {
  if (typeof instances === "undefined" || !Array.isArray(instances)) return [];
  return instances;
}

function activityCtx(extra) {
  const fromExtra = extra && Object.prototype.hasOwnProperty.call(extra, "instances") ? extra.instances : null;
  const instList = Array.isArray(fromExtra) ? fromExtra : currentInstances();
  let catalog = extra && Object.prototype.hasOwnProperty.call(extra, "models") ? extra.models : null;
  if (catalog == null) {
    catalog = typeof models !== "undefined" && Array.isArray(models) && models.length ? models : null;
  }
  return { instances: instList, models: catalog };
}

/**
 * Filter test jobs, then cap at 20. hiddenCount is every junk row in the
 * store, not only those that would have fit in the window.
 */
export function visibleActivity(rows, opts) {
  const show = !!(opts && opts.showJunk);
  const ctx = activityCtx(opts);
  const sorted = sortActivity(rows);
  const junk = [];
  const real = [];
  for (const row of sorted) {
    if (isJunkActivityRow(row, ctx)) junk.push(row);
    else real.push(row);
  }
  const pool = show ? sorted : real;
  return { visible: pool.slice(0, VISIBLE_CAP), hiddenCount: junk.length, junk };
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
 * Insert or replace one event by taskId. Newest first.
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
  let out = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const status = task && TASK_STATUS[task.status];
    if (!status || !task.id) continue;
    out = upsertEvent(out, {
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
  return sortActivity(out);
}

/** User-unit x/width. Short tasks stay at least STRIP_MIN_W so they stay visible. */
export function stripBar(left, width) {
  const x = Math.round((STRIP_PLOT_X + left * STRIP_PLOT_W) * 10) / 10;
  const w = Math.max(STRIP_MIN_W, Math.round(Math.max(0, width) * STRIP_PLOT_W * 10) / 10);
  return { x, w };
}

/**
 * Last-hour strip. left/width are fractions of the hour.
 * Running rows extend to now. Tasks that end before the window are omitted.
 * A row with no start time is omitted (queued-only).
 */
export function stripRects(rows, nowMs) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const start = now - HOUR_MS;
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
    if (b < a) continue;
    // 同一毫秒结束的任务也要留一个点，画的时候再保证至少 2px。
    const span = Math.max(b - a, 1);
    const id = String(row.instanceId || row.instanceName || "?");
    if (!byInst.has(id)) byInst.set(id, { instanceName: "", rects: [] });
    const bucket = byInst.get(id);
    const label = row.instanceName && !isHex32(row.instanceName) ? String(row.instanceName).trim() : "";
    if (label) bucket.instanceName = label;
    bucket.rects.push({
      taskId: row.taskId || "",
      status: row.status || "queued",
      left: (a - start) / HOUR_MS,
      width: Math.min(1, span / HOUR_MS),
      tip: row.taskId || ""
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
  return { lanes, windowMs: HOUR_MS };
}

/** Last 10 real tasks, oldest on the left, equal slots. Used when the hour is empty. */
export function stripFallback(rows) {
  const timed = sortActivity(rows).filter(r => activitySortAt(r) > 0).slice(0, 10).reverse();
  const n = timed.length;
  const byInst = new Map();
  timed.forEach((row, i) => {
    const slot = 1 / n;
    const left = i * slot + slot * 0.12;
    const width = Math.min(slot * 0.76, 0.2);
    const id = String(row.instanceId || row.instanceName || "?");
    if (!byInst.has(id)) byInst.set(id, { instanceName: "", rects: [] });
    const bucket = byInst.get(id);
    const label = row.instanceName && !isHex32(row.instanceName) ? String(row.instanceName).trim() : "";
    if (label) bucket.instanceName = label;
    const at = activitySortAt(row);
    bucket.rects.push({
      taskId: row.taskId || "",
      status: row.status || "queued",
      left,
      width,
      at,
      tip: row.taskId || ""
    });
  });
  const lanes = [...byInst.keys()].sort().map(instanceId => {
    const bucket = byInst.get(instanceId);
    return {
      instanceId,
      instanceName: bucket.instanceName || String(instanceId).slice(0, 6),
      rects: bucket.rects
    };
  });
  return { lanes };
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

function junkShown() {
  try {
    if (typeof localStorage !== "undefined") return localStorage.getItem(JUNK_KEY) === "1";
  } catch { /* private mode */ }
  return false;
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

function toneClass(status) {
  if (status === "done") return "done ok";
  if (status === "failed") return "failed err";
  return status || "queued";
}

function rowHtml(row, now, dim) {
  const status = row.status || "queued";
  const at = activitySortAt(row);
  const when = formatActivityWhen(at, now);
  const iso = at ? new Date(at).toISOString() : "";
  const name = activityInstanceName(row, currentInstances());
  const statusText = t("activity.status." + status);
  const tip = t("activity.rowTip", {
    id: String(row.taskId || "").slice(0, 8),
    category: row.category || "",
    model: row.modelId || ""
  });
  const junk = dim ? " junk" : "";
  return `<div class="act-row">
    <span class="act-time num${junk}" title="${esc(iso)}">${esc(when)}</span>
    <span class="act-name${junk}" title="${esc(tip)}">${esc(name)}</span>
    <span class="act-status ${esc(status)}${junk}"><i class="act-dot" aria-hidden="true"></i><span class="act-status-text">${esc(statusText)}</span></span>
    <span class="act-dur${junk}">${rowDurationHtml(row, now)}</span>
  </div>`;
}

function laneName(lane) {
  return lane.instanceName && !isHex32(lane.instanceName)
    ? lane.instanceName
    : String(lane.instanceId || "").slice(0, 6);
}

function rectSvg(r, y) {
  const bar = stripBar(r.left, r.width);
  const tip = r.tip || r.taskId || "";
  return `<rect class="act-rect ${toneClass(r.status)}" x="${bar.x}" y="${y}" width="${bar.w}" height="5" rx="1"><title>${esc(tip)}</title></rect>`;
}

function namedRows(list) {
  return list.map(r => {
    const instanceName = activityInstanceName(r, currentInstances());
    return instanceName ? { ...r, instanceName } : r;
  });
}

function stripHtml(real, now) {
  const named = namedRows(real);
  const hour = stripRects(named, now);
  const hourHas = hour.lanes.some(l => l.rects.length);
  if (!hourHas) {
    const fb = stripFallback(named);
    if (!fb.lanes.length) return "";
    return paintStrip(fb.lanes, now, "fallback");
  }
  return paintStrip(hour.lanes, now, "hour");
}

function paintStrip(lanes, now, mode) {
  const captionKey = mode === "hour" ? "activity.stripCaption" : "activity.stripFallback";
  const caption = `<p class="act-strip-caption">${esc(t(captionKey))}</p>`;
  const n = lanes.reduce((sum, lane) => sum + lane.rects.length, 0);
  const label = t("activity.stripAria", { n, lanes: lanes.length });
  const axisH = 10;
  const laneH = 10;
  const H = axisH + 4 + lanes.length * laneH;
  const W = STRIP_PLOT_X + STRIP_PLOT_W;
  let body = "";
  if (mode === "hour") {
    body += `<text class="act-axis" x="${STRIP_PLOT_X}" y="7">${esc(t("activity.axisStart"))}</text>`;
    body += `<text class="act-axis act-axis-end" x="${W}" y="7">${esc(t("activity.axisNow"))}</text>`;
    for (let i = 0; i <= 6; i++) {
      const x = Math.round((STRIP_PLOT_X + (i / 6) * STRIP_PLOT_W) * 10) / 10;
      body += `<line class="act-tick" x1="${x}" y1="9" x2="${x}" y2="${H - 1}"></line>`;
    }
  }
  lanes.forEach((lane, i) => {
    const y = axisH + 2 + i * laneH;
    const name = laneName(lane);
    body += `<g class="act-lane" aria-label="${esc(name)}">`;
    body += `<text class="act-lane-label" x="1" y="${y + 4}">${esc(name)}</text>`;
    body += `<rect class="act-lane-bg" x="${STRIP_PLOT_X}" y="${y}" width="${STRIP_PLOT_W}" height="5" rx="1"></rect>`;
    for (const r of lane.rects) {
      body += rectSvg(r, y);
      if (mode === "fallback" && r.at) {
        const bar = stripBar(r.left, r.width);
        body += `<text class="act-fallback-time" x="${bar.x}" y="${y + 9}">${esc(formatActivityWhen(r.at, now))}</text>`;
      }
    }
    body += `</g>`;
  });
  const modeClass = mode === "fallback" ? " act-strip-fallback" : " act-strip-hour";
  return caption + `<svg class="act-strip${modeClass}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" focusable="false">${body}</svg>`;
}

function realRows(part) {
  const junkIds = new Set(part.junk.map(r => r.taskId));
  return sortActivity(rows).filter(r => !junkIds.has(r.taskId));
}

export function renderActivity(nowMs) {
  const list = $("activity-list");
  const empty = $("activity-empty");
  const strip = $("activity-strip");
  if (!list && !strip) return;
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  rows = sortActivity(rows);
  const part = visibleActivity(rows, { showJunk: junkShown() });
  const junkIds = new Set(part.junk.map(r => r.taskId));
  if (strip) strip.innerHTML = stripHtml(realRows(part), now);
  if (list) {
    list.innerHTML = part.visible.map(r => rowHtml(r, now, junkIds.has(r.taskId))).join("");
  }
  if (empty && empty.classList) {
    const none = part.visible.length === 0;
    empty.classList.toggle("hidden", !none);
    if (none) {
      empty.textContent = part.hiddenCount > 0
        ? t("activity.emptyHidden", { n: part.hiddenCount })
        : t("activity.empty");
    }
  }
  const btn = $("activity-junk-toggle");
  if (btn) {
    const show = junkShown();
    const on = part.hiddenCount > 0 || show;
    btn.classList.toggle("hidden", !on);
    btn.textContent = show ? t("activity.hideJunk") : t("activity.showJunk", { n: part.hiddenCount });
    btn.onclick = () => {
      const next = !junkShown();
      try {
        if (typeof localStorage !== "undefined") localStorage.setItem(JUNK_KEY, next ? "1" : "0");
      } catch { /* ignore */ }
      renderActivity();
    };
  }
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
