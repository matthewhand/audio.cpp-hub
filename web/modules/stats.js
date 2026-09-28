/* web/modules/stats.js — 用量与性能看板（#/stats）
 *
 * 数据来自 GET /api/stats（见根目录 stats.go）：用量口径取自历史索引（无淘汰），
 * 性能口径取自内存任务的时间戳与 result.durationSec。本模块只负责拉取、渲染与
 * 打开/关闭面板；不持有跨模块状态。刷新沿用页头按钮，与历史面板一致。
 *
 * 渲染对齐既有约定：三态骨架（showSkeleton / renderEmptyState / renderStateError）、
 * escapeHtml 一律走 esc()，数字/百分比/字节走 I18N 格式化，文案走 i18n 词典。 */

import { $, el, t, Api } from "./dom.js";
import { goPanel } from "./routing.js";
import {
  showSkeleton,
  renderEmptyState,
  renderStateError,
  focusDialog,
  restoreDialogFocus
} from "./async-ui.js";

let lastStats = null;

/* ---------- 打开 / 关闭 ---------- */
export function openStatsPanel() {
  const wasHidden = $("stats-panel").classList.contains("hidden");
  $("stats-panel").classList.remove("hidden");
  if (wasHidden) {
    focusDialog($("stats-panel"));
    loadStats();
  }
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

/* ---------- 渲染 ---------- */
function renderStats(data) {
  const body = $("stats-body");
  body.innerHTML = "";
  const models = Array.isArray(data && data.models) ? data.models : [];
  if (!models.length) {
    renderEmptyState(body, t("stats.empty"));
    return;
  }

  body.appendChild(renderTotals(data.totals || {}, models.length));
  const list = el(`<div class="stats-models"></div>`);
  for (const m of models) list.appendChild(renderModelCard(m));
  body.appendChild(list);
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

/* 0..1 的比率 → 0..100（供 I18N.percent） */
function pct(v) {
  return typeof v === "number" ? v * 100 : 0;
}

/* 秒 → 可读时长（h/m/s），小于 60s 保留一位小数 */
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

/* ---------- 事件绑定（模块求值时 DOM 已就绪） ---------- */
$("stats-btn").onclick = () => goPanel("stats");
$("stats-close").onclick = () => closeStatsPanel();
$("stats-refresh").onclick = () => loadStats();
$("stats-panel").addEventListener("mousedown", (e) => {
  if (e.target === e.currentTarget) closeStatsPanel();
});
