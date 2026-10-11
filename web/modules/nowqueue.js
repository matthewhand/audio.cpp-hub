/* web/modules/nowqueue.js — 工作区顶部的「Now / Queue」状态条
 *
 * 概念稿在实例工具栏与合成面板之间那条卡片状状态条：标题图标 + 「Now / Queue」，
 * 「In flight n / cap」容量 chip，每个 RUNNING 任务一枚强调色 chip（脉冲点 ·
 * 实例名 · 文本前 ~14 字 · 计时 · 取消），剩下的容量用虚线「free」chip 占位；
 * 竖线之后是「Queued n」与每条 QUEUED 任务的 chip（位次 · 实例名 · 已等待 · 取消）。
 *
 * 数据源与左栏 activity.js 完全同源：activity.js 通过 activeActivityRows() 交出
 * 它已经归约好的行，本模块只订阅 hub-task-event 重画，**不新增轮询器**。SSE 断开
 * 时由 activity.js 自己的轮询兜底；这里另有一个保险拉取（SAFETY_POLL_MS），
 * 只在 SSE 不通时启用，复用 activity.js 的同一条请求路径。
 *
 * 计时文本全站只有 elapsed.js 一处写：运行中 chip 的耗时是
 * .badge-elapsed[data-elapsed-id]，由 instances.js 的唯一定时器现查现画；本模块
 * 不新开 interval 写耗时，只在重画后调 syncBusyTimer()。排队 chip 的「已等待」
 * 不是任务耗时（QUEUED 行本来就没有 startedAt），因此自带一个每秒一跳的
 * interval，且只在真的有排队 chip 时运行（见 ensureWaitTick）。
 *
 * 容量口径：cap = 农场摘要 /api/farm/health 的 inFlightCap（fan-out 的
 * MaxInFlightPerTarget 透传，页面不跨源，该值由 hub-chip.js 轮询后共享），
 * 缺失或不是数字时回落到 DEFAULT_CAP=2。free chip 数量 = max(0, cap - 运行中
 * 条数)：cap 是并发额度而不是实例台数，所以空闲 chip 不按实例逐台画。
 *
 * 已知口径限制：hub 的 /api/tasks 不含分片（chunk）进度字段，所以这里不画
 * 「第 n/m 片」的进度条——要画需要后端先加一个字段，见 CHANGELOG。 */

import { $, esc, t } from "./dom.js";
import { activeActivityRows, pullActivityTasks } from "./activity.js";
import { rememberStart } from "./elapsed.js";
import { farmSummary } from "./hub-chip.js";
import { formatBusyElapsed, instances, syncBusyTimer } from "./instances.js";
import { cancelTask } from "./tasks.js";
import { isTaskStreamLive } from "./task-events.js";

/* 农场没报 inFlightCap 时的兜底容量。与 fan-out 的默认 MaxInFlightPerTarget 同值。 */
export const DEFAULT_CAP = 2;
/* 文本摘要在 chip 上的长度（概念稿是 ~14 字，超出加省略号） */
export const SNIPPET_MAX = 14;
/* SSE 不通时的保险拉取间隔。SSE 通着时只靠 task.* 事件，不再定时拉。 */
const SAFETY_POLL_MS = 15000;
/* 排队 chip「已等待」的跳表间隔；只在有排队 chip 时存在 */
const WAIT_TICK_MS = 1000;
/* 同一时刻在途的取消请求：同一任务只发一次，双击不会打两次 DELETE */
const cancelling = new Set();

/** farm 摘要 → 容量。缺失 / 非数字 / <=0 一律回落到 DEFAULT_CAP。纯函数。 */
export function capacityFrom(summary) {
  const raw = Number(summary && summary.inFlightCap);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CAP;
  return Math.trunc(raw);
}

/**
 * 文本摘要：压掉换行与多余空白、截断加省略号。
 * 长度上限缺省 / 非法时用 SNIPPET_MAX。纯函数。
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function snippet(text, max) {
  const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  const cap = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.trunc(Number(max)) : SNIPPET_MAX;
  if (!s) return "";
  return s.length > cap ? s.slice(0, cap).trimEnd() + "…" : s;
}

/** 已等待秒数 = now - createdAt，钳到 0；任一侧缺失 / 非法 → null。纯函数。 */
export function waitSeconds(createdAt, nowMs) {
  const c = Number(createdAt);
  if (!Number.isFinite(c) || c <= 0) return null;
  // Number(null) 是 0，会被当成「1970 年」，先挡掉 null / undefined / ""
  if (nowMs == null || nowMs === "") return null;
  const now = Number(nowMs);
  if (!Number.isFinite(now)) return null;
  return Math.max(0, (now - c) / 1000);
}

function statusOf(row) {
  return String((row && row.status) || "").toUpperCase();
}

function isActive(row) {
  const s = statusOf(row);
  return s === "RUNNING" || s === "QUEUED";
}

function createdMs(row) {
  const c = Number(row && row.createdAt);
  if (Number.isFinite(c) && c > 0) return c;
  const q = Number(row && row.queuedAt);
  return Number.isFinite(q) && q > 0 ? q : 0;
}

/** 实例显示名：优先任务自带的 instanceName，退回实例列表，再退回 id 前 6 位。纯函数。 */
export function chipInstanceName(row, list) {
  const own = String((row && row.instanceName) || "").trim();
  if (own) return own;
  const id = String((row && row.instanceId) || "");
  const hit = (Array.isArray(list) ? list : []).find(i => i && String(i.id) === id);
  const fromList = hit ? String(hit.instanceName || hit.name || hit.modelId || "").trim() : "";
  if (fromList) return fromList;
  return id.slice(0, 6);
}

/**
 * 整条状态条的显示模型。纯函数，渲染与单测共用。
 *
 * inFlight = RUNNING 条数；cap 来自农场摘要（缺失回落 DEFAULT_CAP）；
 * running 按 startedAt 旧的在前；queued 按 createdAt 旧的在前，位次优先用
 * 服务端的 position（没有就按排序下标 +1）。free 是 max(0, cap - inFlight) 个
 * 虚拟槽位，只用来画虚线 chip。
 *
 * @param {any[]} rows activity.js 归约后的任务行
 * @param {{farm?:any, instances?:any[], now?:number}} [opts]
 * @returns {{inFlight:number, cap:number, running:any[], queued:any[], free:number}}
 */
export function describeNowQueue(rows, opts) {
  const o = opts || {};
  const list = Array.isArray(o.instances) ? o.instances : [];
  const cap = capacityFrom(o.farm);
  const now = Number.isFinite(Number(o.now)) ? Number(o.now) : Date.now();
  const active = (Array.isArray(rows) ? rows : []).filter(isActive);

  const running = active
    .filter(r => statusOf(r) === "RUNNING")
    .map(r => ({
      id: String(r.taskId || ""),
      name: chipInstanceName(r, list),
      text: snippet(r.text),
      startedAt: Number(r.startedAt) || 0,
      task: r
    }))
    .sort((a, b) => (a.startedAt || now) - (b.startedAt || now) || a.id.localeCompare(b.id));

  const queued = active
    .filter(r => statusOf(r) === "QUEUED")
    .map(r => ({
      id: String(r.taskId || ""),
      name: chipInstanceName(r, list),
      text: snippet(r.text),
      createdAt: createdMs(r),
      position: Number(r.position) || 0,
      task: r
    }))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((r, i) => ({ ...r, position: r.position > 0 ? r.position : i + 1 }));

  const inFlight = running.length;
  return { inFlight, cap, running, queued, free: Math.max(0, cap - inFlight) };
}

/**
 * 是否应该整条隐藏。没有就绪实例也没有在途任务时收起——没有可说的内容。
 * cap 只是兜底值，不会因为它存在就凭空显示一条空条。
 * @param {{inFlight:number, queued:any[], cap:number}} model
 * @param {any[]} list 当前实例列表
 */
export function shouldHideStrip(model, list) {
  const m = model || /** @type {any} */ ({});
  const runningCount = Number(m.inFlight) || 0;
  const queued = Array.isArray(m.queued) ? m.queued : [];
  if (runningCount > 0 || queued.length > 0) return false;
  const ready = (Array.isArray(list) ? list : []).some(i => i && i.status === "READY");
  return !ready;
}

/* ---------- 渲染 ---------- */

function stripEl() { return $("now-queue"); }

/** chip 容器。标题图标 + 「Now / Queue」是 index.html 里的静态 DOM（走 data-i18n），
    这里只重建它右边的动态部分，语言切换时静态文案由 I18N.applyI18n 处理。 */
function bodyEl() {
  const root = stripEl();
  if (!root) return null;
  return root.querySelector(".nq-body") || root;
}

function pulseHtml() {
  return `<span class="pulse" aria-hidden="true"><i></i><i class="r1"></i><i class="r2"></i></span>`;
}

/* 雪碧图 <use>：描边属性声明在使用方（与页头 / 上一条录音条同写法），
   尺寸由 style.css 的 .nq-x .icon 给。 */
function iconUse(href) {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><use href="${esc(href)}"/></svg>`;
}

/** 取消按钮。aria-label 带实例名，title 额外给出任务 id 与文本。 */
function cancelHtml(taskId, name, tip, pending) {
  const cls = "nq-x" + (pending ? " busy" : "");
  const label = t("nq.cancel", { name });
  return `<button type="button" class="${cls}" data-task="${esc(taskId)}" aria-label="${esc(label)}" title="${esc(tip)}"${pending ? " disabled" : ""}>${iconUse("#i-x")}</button>`;
}

/** 运行中 chip 的 tooltip：实例 + 短 id + 完整文本（无文本时省略该段）。 */
export function runningTip(chip) {
  const text = String((chip && chip.task && chip.task.text) || "").replace(/\s+/g, " ").trim();
  const id = String((chip && chip.id) || "").slice(0, 8);
  const base = t("nq.tipRunning", { name: (chip && chip.name) || "", id });
  return text ? base + " · " + text : base;
}

export function queuedTip(chip) {
  const text = String((chip && chip.task && chip.task.text) || "").replace(/\s+/g, " ").trim();
  const id = String((chip && chip.id) || "").slice(0, 8);
  const base = t("nq.tipQueued", {
    name: (chip && chip.name) || "",
    id,
    pos: (chip && chip.position) || 1
  });
  return text ? base + " · " + text : base;
}

function runningChipHtml(chip, now) {
  const tip = runningTip(chip);
  // 起点来自 elapsed.js 的共享表；本模块先登记一次（有 startedAt 才登记），
  // 让 data-elapsed-id 这条路径与卡片徽标走同一张表、同一个定时器。
  const text = chip.startedAt ? formatBusyElapsed(Math.max(0, (now - chip.startedAt) / 1000)) : "";
  const clock = chip.startedAt
    ? `<span class="nq-t num" data-elapsed-id="${esc(chip.id)}">${esc(text)}</span>`
    : "";
  const quote = chip.text ? `<span class="nq-q">“${esc(chip.text)}”</span>` : "";
  return `<span class="nq-slot" title="${esc(tip)}">${pulseHtml()}`
    + `<b class="nq-n">${esc(chip.name)}</b>${quote}${clock}`
    + cancelHtml(chip.id, chip.name, tip, cancelling.has(chip.id))
    + `</span>`;
}

function freeChipHtml() {
  return `<span class="nq-slot free" title="${esc(t("nq.freeTip"))}">${esc(t("nq.free"))}</span>`;
}

function queuedChipHtml(chip) {
  const tip = queuedTip(chip);
  const wait = waitSeconds(chip.createdAt, Date.now());
  const waitText = wait == null ? "" : `<span class="nq-t num" data-wait-at="${chip.createdAt}">${esc(formatBusyElapsed(wait))}</span>`;
  return `<span class="nq-qchip" title="${esc(tip)}">`
    + `<span class="nq-n">#${esc(chip.position)}</span><b class="nq-n">${esc(chip.name)}</b>${waitText}`
    + cancelHtml(chip.id, chip.name, tip, cancelling.has(chip.id))
    + `</span>`;
}

/** 排队 chip 的「已等待」每秒一跳；没有排队 chip 时 interval 立刻停掉。 */
function updateWaitTicks() {
  const box = bodyEl();
  if (!box || !box.querySelectorAll) return;
  const now = Date.now();
  for (const node of box.querySelectorAll("[data-wait-at]")) {
    const wait = waitSeconds(node.getAttribute("data-wait-at"), now);
    if (wait != null) node.textContent = formatBusyElapsed(wait);
  }
}

let waitTimer = null;

function stopWaitTick() {
  if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
}

/** 只有真的画出了排队 chip 才开表；没有排队立刻停（唯一的轻量 tick）。 */
function ensureWaitTick(queuedCount) {
  if (queuedCount > 0) {
    if (!waitTimer) waitTimer = setInterval(updateWaitTicks, WAIT_TICK_MS);
    return;
  }
  stopWaitTick();
}

/** 农场摘要直接读页头 chip 已经拉好的那份（hub-chip.js 的 farmSummary()），
    不在这里再开一条同源轮询；拿不到就用 capacityFrom 的 DEFAULT_CAP 兜底。 */
function currentFarm() {
  try {
    const s = farmSummary();
    return s && typeof s === "object" ? s : null;
  } catch {
    return null;
  }
}

function currentInstances() {
  return Array.isArray(instances) ? instances : [];
}

/**
 * 重画整条状态条。无就绪实例且无在途任务时整条隐藏。
 * 每次重画都调 syncBusyTimer()：运行中 chip 的耗时节点是新插入的，
 * 共享计时器要重新认一次（和 instances.js / activity.js 一样的约定）。
 */
export function renderNowQueue(nowMs) {
  const root = stripEl();
  const box = bodyEl();
  if (!root || !box) return;
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const model = describeNowQueue(activeActivityRows(), { farm: currentFarm(), instances: currentInstances(), now });

  if (shouldHideStrip(model, currentInstances())) {
    root.classList.add("hidden");
    box.innerHTML = "";
    stopWaitTick();
    return;
  }
  root.classList.remove("hidden");

  // 运行中 chip 的耗时读 elapsed.js 的共享表，先把这一拍的起点登记进去
  // （有 startedAt 才登记；SSE 事件早已登记过同一 taskId 时不会覆盖成更晚的值）。
  for (const chip of model.running) {
    rememberStart({ taskId: chip.id }, { startedAt: chip.startedAt || null, now });
  }

  const idle = model.inFlight === 0 && model.queued.length === 0;
  const parts = [`<span class="nq-cap num">${esc(t("nq.inflight", { n: model.inFlight, cap: model.cap }))}</span>`];
  for (const chip of model.running) parts.push(runningChipHtml(chip, now));
  for (let i = 0; i < model.free; i++) parts.push(freeChipHtml());
  if (model.queued.length) {
    parts.push(`<span class="nq-vs" aria-hidden="true"></span>`);
    parts.push(`<span class="nq-cap num">${esc(t("nq.queued", { n: model.queued.length }))}</span>`);
    for (const chip of model.queued) parts.push(queuedChipHtml(chip));
  }
  box.innerHTML = parts.join("");
  root.classList.toggle("is-idle", idle);
  root.setAttribute("aria-label", t("nq.aria", {
    n: model.inFlight,
    cap: model.cap,
    q: model.queued.length
  }));

  ensureWaitTick(model.queued.length);
  syncBusyTimer();
  bindClicks(root);
}

/* ---------- 取消 ---------- */

/* 单击即取消（不弹确认框）。同一任务在途时按钮 disabled + busy，
   并且 cancelling 集合挡住第二次点击，请求失败走 toast（tasks.js 的既有机制）。 */
function bindClicks(root) {
  if (!root || root.__nqBound) return;
  root.__nqBound = true;
  root.addEventListener("click", (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest(".nq-x") : null;
    if (!btn) return;
    const taskId = btn.getAttribute("data-task");
    if (!taskId || cancelling.has(taskId)) return;
    cancelling.add(taskId);
    btn.classList.add("busy");
    btn.disabled = true;
    Promise.resolve(cancelTask(taskId))
      .catch(() => {})
      .then(() => {
        cancelling.delete(taskId);
        renderNowQueue();
      });
  });
}

/* ---------- 启动 ---------- */

let safetyTimer = null;

function stopSafetyPoll() {
  if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
}

/* SSE 不通时的保险拉取：只复用 activity.js 的那条 GET /api/tasks 路径，
   不新增第二个轮询器；SSE 一通就停（事件已经更快地推来了）。 */
function ensureSafetyPoll() {
  stopSafetyPoll();
  if (isTaskStreamLive()) return;
  safetyTimer = setTimeout(() => {
    safetyTimer = null;
    pullActivityTasks();
    ensureSafetyPoll();
  }, SAFETY_POLL_MS);
}

export function startNowQueue() {
  // cap 的来源（农场 inFlightCap）由页头 chip 的轮询负责，这里只读它缓存的值。
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("hub-task-event", () => renderNowQueue());
    // activity.js 每次拿到新清单（或收到一条 task.* 事件）后广播，
    // 状态条据此重画：SSE 不通时它靠这条信号跟上清单，不必自己发请求。
    window.addEventListener("hub-tasks-refreshed", () => renderNowQueue());
    window.addEventListener("hub-instances-updated", () => renderNowQueue());
    // 农场摘要到位 / 失效时 cap 可能变，跟着重画一次
    window.addEventListener("hub-farm-summary", () => renderNowQueue());
    window.addEventListener("hub-task-stream", () => {
      ensureSafetyPoll();
      renderNowQueue();
    });
  }
  ensureSafetyPoll();
  pullActivityTasks();
  renderNowQueue();
}

/** 测试复位。生产路径不调用。 */
export function resetNowQueue() {
  stopSafetyPoll();
  stopWaitTick();
  cancelling.clear();
  const root = stripEl();
  if (root) {
    const box = bodyEl();
    if (box) box.innerHTML = "";
    root.classList.add("hidden");
    root.__nqBound = false;
  }
}
