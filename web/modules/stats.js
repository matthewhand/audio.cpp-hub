/* web/modules/stats.js — usage & performance dashboard (#/stats)
 *
 * Data comes from GET /api/stats (see stats.go at the repo root): usage figures
 * are derived from the never-evicted history index, performance figures from
 * in-memory task timestamps plus result.durationSec. This module only fetches,
 * renders, and opens/closes the panel; it holds no cross-module state. Refreshing
 * follows the header button, same as the history panel.
 *
 * Rendering follows the existing conventions: tri-state primitives
 * (showSkeleton / renderEmptyState / renderStateError), escaping via esc(), and
 * I18N formatters for numbers / percentages / byte sizes. */

import { $, el, t, Api } from "./dom.js";
import {
  showSkeleton,
  renderEmptyState,
  renderStateError,
  focusDialog,
  restoreDialogFocus
} from "./async-ui.js";

let lastStats = null;

/* ---------- open / close ---------- */
// Called by stats-lazy.js after the chunk loads. openStatsPanel assumes the
// panel shell is already visible (the facade shows it immediately for a snappy
// click) and adds focus + data on top.
export function openStatsPanel() {
  const wasHidden = $("stats-panel").classList.contains("hidden");
  $("stats-panel").classList.remove("hidden");
  if (wasHidden) {
    focusDialog($("stats-panel"));
  }
  loadStats();
}

export function closeStatsPanel() {
  $("stats-panel").classList.add("hidden");
  restoreDialogFocus();
}

export async function loadStats() {
  const body = $("stats-body");
  if (!lastStats) showSkeleton(body, 3);
  try {
    lastStats = await Api.get("/api/stats");
    renderStats(lastStats);
  } catch (e) {
    renderStateError(body, e, () => loadStats());
  }
}

/* ---------- rendering ---------- */
function isJunkStatsModel(m) {
  const id = String(m && m.modelId || "");
  // Hide synthetic / probe junk that pollutes the dashboard (#119).
  if (!id || id === "nonexistent_model") return true;
  if (/^nonexistent/i.test(id) || /^test[_-]?model/i.test(id)) return true;
  return false;
}

function renderStats(data) {
  const body = $("stats-body");
  body.innerHTML = "";
  const raw = Array.isArray(data && data.models) ? data.models : [];
  const models = raw.filter(m => !isJunkStatsModel(m));
  if (!models.length) {
    renderEmptyState(body, t("stats.empty"));
    return;
  }

  body.appendChild(renderTotals(data.totals || {}, models.length));
  if (Array.isArray(data.perDay) && data.perDay.length) {
    body.appendChild(renderPerDay(data.perDay));
  }
  const list = el(`<div class="stats-models"></div>`);
  for (const m of models) list.appendChild(renderModelCard(m));
  body.appendChild(list);
}

/* 最近 14 天生成量：迷你条形图（旧→新），条高按窗口内峰值归一化 */
function renderPerDay(days) {
  const wrap = el(`<div class="stats-perday card"></div>`);
  const title = el(`<div class="detail-label"></div>`);
  title.textContent = t("stats.perDayTitle");
  wrap.appendChild(title);
  const max = Math.max(1, ...days.map(d => d.count));
  const bars = el(`<div class="stats-perday-bars"></div>`);
  for (const d of days) {
    const bar = el(`<div class="stats-perday-day" role="img"></div>`);
    bar.setAttribute("aria-label", t("stats.perDayBar", { day: d.day, n: I18N.num(d.count) }));
    bar.title = `${d.day} — ${I18N.num(d.count)}`;
    const fill = el(`<div class="stats-perday-fill"></div>`);
    const h = d.count ? Math.max(8, Math.round((d.count / max) * 100)) : 0;
    fill.style.height = h + "%";
    fill.classList.toggle("zero", !d.count);
    bar.appendChild(fill);
    bars.appendChild(bar);
  }
  wrap.appendChild(bars);
  const labels = el(`<div class="stats-perday-labels"></div>`);
  const first = el(`<span></span>`);
  const last = el(`<span></span>`);
  first.textContent = days[0].day.slice(5);
  last.textContent = days[days.length - 1].day.slice(5) + " · " + t("stats.perDayTotal", { n: I18N.num(days.reduce((a, d) => a + d.count, 0)) });
  labels.appendChild(first);
  labels.appendChild(last);
  wrap.appendChild(labels);
  return wrap;
}

function renderTotals(totals, modelCount) {
  const wrap = el(`<div class="stats-totals"></div>`);
  const cells = [
    [t("stats.totalTasks"), I18N.num(totals.total || 0)],
    [t("stats.successRate"), I18N.percent(pct(totals.successRate))],
    [
      t("stats.audioDuration"),
      formatDuration(totals.audioSeconds || 0)
    ],
    [t("stats.outputSize"), I18N.bytes(totals.outputBytes || 0)]
  ];
  void modelCount;
  for (const [label, value] of cells) {
    wrap.appendChild(
      el(`<div class="stats-total"><div class="stats-total-value"></div><div class="stats-total-label"></div>`)
    );
    const card = wrap.lastElementChild;
    card.querySelector(".stats-total-value").textContent = value;
    card.querySelector(".stats-total-label").textContent = label;
  }
  return wrap;
}

function renderModelCard(m) {
  const card = el(`<div class="stats-model card"></div>`);
  const head = el(`<div class="stats-model-head"></div>`);
  const title = el(`<div class="stats-model-title"></div>`);
  title.textContent = m.instanceName ? m.instanceName + " · " + m.modelId : m.modelId;
  title.title = title.textContent;
  head.appendChild(title);
  if (m.category) {
    const badge = el(`<span class="badge"></span>`);
    badge.textContent = m.category;
    head.appendChild(badge);
  }
  card.appendChild(head);

  const rows = [
    [t("stats.totalTasks"), I18N.num(m.total || 0)],
    [t("stats.successRate"), I18N.percent(pct(m.successRate))],
    [t("stats.audioDuration"), formatDuration(m.audioSeconds || 0)],
    [t("stats.outputSize"), I18N.bytes(m.outputBytes || 0)],
    [t("stats.lastUsed"), m.lastAt ? I18N.date(m.lastAt) : "—"]
  ];
  if (m.samplesForPerf > 0) {
    rows.push(
      [t("stats.queueP50"), formatMs(m.queueMsP50)],
      [t("stats.runP50"), formatMs(m.runMsP50)],
      [t("stats.runP95"), formatMs(m.runMsP95)],
      [t("stats.rtf"), m.rtfP50 ? m.rtfP50.toFixed(2) + "×" : "—"]
    );
  }
  const grid = el(`<div class="stats-grid"></div>`);
  for (const [label, value] of rows) {
    const cell = el(`<div class="stats-cell"><span class="stats-cell-label"></span><span class="stats-cell-value"></span></div>`);
    cell.querySelector(".stats-cell-label").textContent = label;
    cell.querySelector(".stats-cell-value").textContent = value;
    grid.appendChild(cell);
  }
  card.appendChild(grid);
  if (m.samplesForPerf > 0) {
    const note = el(`<div class="hint stats-note"></div>`);
    note.textContent = t("stats.perfNote", { n: I18N.num(m.samplesForPerf) });
    card.appendChild(note);
  }
  return card;
}

/* Convert a 0..1 ratio to 0..100 for I18N.percent */
function pct(v) {
  return typeof v === "number" ? v * 100 : 0;
}

/* Seconds -> human readable (h/m/s); one decimal below 60s */
function formatDuration(sec) {
  const s = Number(sec) || 0;
  if (s < 60) return s.toFixed(1) + "s";
  const h = Math.floor(s / 3600);
  const mnt = Math.floor((s % 3600) / 60);
  if (h > 0) return h + "h " + mnt + "m";
  return mnt + "m " + Math.round(s % 60) + "s";
}

function formatMs(ms) {
  const v = Number(ms) || 0;
  return v >= 1000 ? (v / 1000).toFixed(2) + "s" : Math.round(v) + "ms";
}

/* ---------- event wiring (DOM is ready when the module evaluates) ----------
   The header button is NOT wired here: it must work before this chunk loads, so
   stats-lazy.js owns it. These are the in-panel controls, only reachable once the
   module is loaded. */
$("stats-close").onclick = () => closeStatsPanel();
$("stats-refresh").onclick = () => loadStats();
$("stats-panel").addEventListener("mousedown", (e) => {
  if (e.target === e.currentTarget) closeStatsPanel();
});
