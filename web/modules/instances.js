/* web/modules/instances.js — 实例
 *
 * 左栏实例列表、顶部实例状态条（选择 / 停止 / 详情）、实例详情弹窗，
 * 以及 2s 轮询的建立与复用（Api.poll 句柄在模块内保存，单飞 + 可见性语义不变）。 */

import { focusDialog, renderEmptyState, renderListError, restoreDialogFocus, showSkeleton } from "./async-ui.js";
import { $, Api, esc, t } from "./dom.js";
import { ELAPSED_TICK_MS, hasActiveStarts, rawStartMs, rememberStart, taskStartMs } from "./elapsed.js";
import { openLaunchModal } from "./launch.js";
import { selectModelById } from "./models.js";
import { getPendingInstanceId, go, modelRoute, parseRoute, setPendingInstanceId } from "./routing.js";
import { activeInstanceId, busyStarts, idleFallbacks, models, runningStarts, selectedModelId, setActiveInstanceId } from "./state.js";

/* ---------- 「生成中…」徽标：SSE + 轮询合并成一个忙碌源 ---------- */

/* 毫秒时间戳，非法 / 缺失 → null */
function msOr(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 卡片与实例条共用的忙碌判定。纯函数，单测直接注入 sse / 轮询实例。
 *
 * @param {{startMs:number|null}|null} sse SSE 侧对这一实例的观测：非空即「SSE
 *        说它在忙」，startMs 是 task.started 的 ts（事件没带 ts 时为 null）。
 *        流断开时调用方传 null（task-events.js 已清表）。
 * @param {Object|null} inst 2s 轮询拿到的实例对象；可带 runningStartedAt
 *        （该实例当前 RUNNING 任务的 startedAt，由 tasks.js 从任务轮询补上）。
 * @returns {{busy:boolean,startMs:number|null,source:"sse"|"poll"|null}}
 *         source 说明这一拍是谁说的（null = 不忙）。
 */
export function resolveBusy(sse, inst) {
  if (sse) return { busy: true, startMs: msOr(sse.startMs), source: "sse" };
  const count = inst ? Number(inst.taskCount) : NaN;
  const busy = (Number.isFinite(count) && count > 0) || Boolean(inst && inst.memory && inst.memory.busy);
  if (!busy) return { busy: false, startMs: null, source: null };
  return { busy: true, startMs: msOr(inst && inst.runningStartedAt), source: "poll" };
}

/* 忙碌计时：60s 内保留 1 位小数（3.2s），之后按分秒（1m 05s）。纯函数。 */
export function formatBusyElapsed(sec) {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec < 0) return "";
  const t = Math.round(sec * 10) / 10; // 到 60.0s 之前不写「60.0s」，直接进位到分秒
  if (t < 60) return t.toFixed(1) + "s";
  return Math.floor(t / 60) + "m " + String(Math.floor(t % 60)).padStart(2, "0") + "s";
}

/* ---------- 实例排序（全序，与选中 / 忙碌无关） ---------- */

/**
 * 实例列表排序：状态 → createdAt → name → id。
 *
 * 全序比较：任何两个实例都比得出结果，平级时依次用 createdAt / 名称 / id 兜底，
 * 所以同一份输入恒得同一份输出（不依赖 Array.sort 的稳定性）。
 * **刻意不看选中态与忙碌态**——选中只是给卡片加个 class，参与排序会让
 * 「点哪张卡片，哪张就跳到列表顶部」，2s 轮询重画时还会来回跳。
 * 纯函数，单测反复打乱输入断言同一输出。
 * @param {any[]} list
 * @returns {any[]} 新数组（不改入参）
 */
export function sortInstances(list) {
  // 状态权重：就绪 > 启动中 > 其它（ERROR/STOPPED 等），只用来把可用的排在前面
  const rank = s => (s === "READY" ? 0 : s === "STARTING" ? 1 : 2);
  const arr = Array.isArray(list) ? list.slice() : [];
  return arr.sort((a, b) => {
    const ar = rank(a.status), br = rank(b.status);
    if (ar !== br) return ar - br;
    const ac = String(a.createdAt || ""), bc = String(b.createdAt || "");
    if (ac !== bc) return ac < bc ? -1 : 1;
    const an = String(a.instanceName || a.modelId || ""), bn = String(b.instanceName || b.modelId || "");
    if (an !== bn) return an < bn ? -1 : 1;
    const ai = String(a.id || ""), bi = String(b.id || "");
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
}

/* 一个实例的忙碌状态 + 计时起点：SSE 优先，其次任务轮询的 startedAt。 */
function busyState(inst) {
  if (!inst) return { busy: false, startMs: null, source: null };
  const sse = busyStarts.has(inst.id) ? { startMs: busyStarts.get(inst.id) } : null;
  return resolveBusy(sse, { ...inst, runningStartedAt: runningStarts.get(inst.id) });
}

/* 把这一拍的忙碌起点并进唯一的表。已有更早的锚不会被更晚的 startedAt 盖掉。 */
function noteBusyAnchor(inst, busy) {
  if (!inst || !busy || !busy.busy) return;
  rememberStart({ instanceId: inst.id }, { startedAt: busy.startMs, now: Date.now() });
}

/* 计时片段：起点来自 elapsed.js 的表，不来自这一帧的 Date.now()。
   类名刻意不叫 busy-elapsed——那个名字已被忙碌遮罩 #busy-elapsed 占用。
   data-elapsed-id 是计时器的查找键；data-start 只是存下来的原始锚（展示时再钳）。
   卡片标题行右端、工具栏胶囊、状态行共用它，所以只有这一处写 data-elapsed-id。 */
function busyElapsedHtml(instId) {
  const now = Date.now();
  const shown = taskStartMs(instId, now);
  if (shown == null) return "";
  const raw = rawStartMs(instId);
  const text = formatBusyElapsed((now - shown) / 1000);
  const startAttr = raw != null ? raw : shown;
  return ` <span class="badge-elapsed num" data-elapsed-id="${esc(instId)}" data-start="${startAttr}">${esc(text)}</span>`;
}

/* 「生成中…」胶囊的形状：.pulse 的一点两环（见 style.css）+ 文案。
   胶囊里刻意不放耗时——卡片上它在标题行右端（cardElapsedHtml），
   工具栏上没有那个位置，才留在胶囊里，两种布局都不会同时出现两个计时。 */
function generatingBadgeHtml(instId, withElapsed) {
  const pulse = `<span class="pulse" aria-hidden="true"><i></i><i class="r1"></i><i class="r2"></i></span>`;
  const tail = withElapsed ? busyElapsedHtml(instId) : "";
  return `<span class="badge generating">${pulse}${esc(t("instance.generating"))}${tail}</span>`;
}

/* 卡片标题行右端的「活动图标 + 耗时」：生成中时顶替 idle 标签。
   与徽标 / 状态行同一个查找键（data-elapsed-id），由唯一的计时器重画；
   起点这一帧就按 elapsed.js 的表钳好，不等下一拍。
   stroke 走 currentColor，颜色由 .card-elapsed 的 --accent-live 给。 */
function cardElapsedHtml(instId) {
  const now = Date.now();
  const shown = taskStartMs(instId, now);
  if (shown == null) return "";
  const raw = rawStartMs(instId);
  const text = formatBusyElapsed((now - shown) / 1000);
  const startAttr = raw != null ? raw : shown;
  const tip = t("instance.generatingTip");
  return `<span class="card-elapsed" title="${esc(tip)}">`
    + `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><use href="#i-activity"/></svg>`
    + `<span class="badge-elapsed num" data-elapsed-id="${esc(instId)}" data-start="${startAttr}">${esc(text)}</span>`
    + `</span>`;
}

/* 卡片、工具栏、状态行共用这一个定时器。重画只换节点，不换表里的起点，
   所以每拍都按 data-elapsed-id 现查现画。表还在、节点暂时没了（innerHTML
   清空的间隙）也不停表，避免停在旧数字上再跳。表和节点都没了才停。 */
let busyTimer = null;

function updateBusyTimers() {
  const now = Date.now();
  for (const node of document.querySelectorAll("[data-elapsed-id]")) {
    const id = node.getAttribute("data-elapsed-id");
    const shown = taskStartMs(id, now);
    if (shown == null) continue;
    node.textContent = formatBusyElapsed((now - shown) / 1000);
  }
}

/* 每次重画后调用：立刻刷一帧（不会留下 0.0s / 旧数字），有任务才保持 interval。 */
export function syncBusyTimer() {
  const nodes = document.querySelectorAll("[data-elapsed-id]");
  if (!nodes.length && !hasActiveStarts()) {
    if (busyTimer) { clearInterval(busyTimer); busyTimer = null; }
    return;
  }
  updateBusyTimers();
  if (!busyTimer) busyTimer = setInterval(updateBusyTimers, ELAPSED_TICK_MS);
}

/* ---------- 实例内存条（RAM / VRAM 进度条 + 迷你折线） ---------- */
const MEM_MIB = 1024 * 1024;
/* 折线图的画布尺寸与点数上限（与概念稿一致；上限与服务端 memSeriesCap 对齐） */
const SPARK_W = 74;
const SPARK_H = 16;
const SPARK_CAP = 60;

/* bytes → MiB；缺失 / 非法 → NaN（调用方据此判断「这一项没有」） */
function memMiB(bytes) {
  return typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0 ? bytes / MEM_MIB : NaN;
}
function numOr(v, dflt) { return Number.isFinite(v) ? v : dflt; }
function opt(v) { return Number.isFinite(v) ? v : null; }
/* 属性里用的数值：保留 1 位小数 */
function num1(v) { return Math.round(v * 10) / 10; }

/* 人类可读的 MiB 值：≥ 1024 MiB 用 1 位小数的 GiB，否则取整 MiB。纯函数。 */
export function formatMiB(mib) {
  if (typeof mib !== "number" || !Number.isFinite(mib) || mib < 0) return "";
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GiB` : `${Math.round(mib)} MiB`;
}

/* 百分比钳制到 0–100（保留 1 位小数）。纯函数。 */
export function clampPct(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 0;
  return n >= 100 ? 100 : Math.round(n * 10) / 10;
}

/**
 * Bar denominator, in the same unit as cur/peak/avg/total (MiB).
 * A known positive total is the denominator.
 * Unknown or 0 must not sit near a full fill:
 * VRAM: max(peak, current, avg) * 1.25
 * RAM:  max(peak, current) * 1.25 unless a positive total is supplied.
 * A zero head falls back to 1 so the bar stays defined.
 */
export function memBarScale(kind, cur, peak, avg, total) {
  if (typeof total === "number" && Number.isFinite(total) && total > 0) return total;
  const head = kind === "vram" ? Math.max(peak, cur, avg) : Math.max(peak, cur);
  const scale = (Number.isFinite(head) ? head : 0) * 1.25;
  return scale > 0 ? scale : 1;
}

/**
 * 一行内存条的模型。纯函数，卡片 / 详情弹窗渲染与单测共用。
 * kind 为 "ram" / "vram"，mem 是实例的 memory 对象（字段全部可选）。
 * 返回 null 表示这一行画不出来：没有当前读数（VRAM 从未读到）或整个 memory 缺失。
 *
 * 比例尺见 memBarScale。fillPct / peakPct / avgPct 已钳制；
 * hot = VRAM 当前值已到比例尺的 85% 以上。总量 ≤ 0 视为未知（不写 "/ 0"）。
 */
export function memRowModel(kind, mem) {
  if (!mem) return null;
  const vram = kind === "vram";
  const cur = memMiB(vram ? mem.vramBytes : mem.ramBytes);
  if (!Number.isFinite(cur)) return null;
  const peak = numOr(memMiB(vram ? mem.vramPeakBytes : mem.ramPeakBytes), cur);
  const avg = numOr(memMiB(vram ? mem.vramAvgBytes : mem.ramAvgBytes), cur);
  const idle = opt(memMiB(vram ? mem.vramIdleBytes : mem.ramIdleBytes));
  const totalRaw = opt(memMiB(vram ? mem.vramTotalBytes : mem.ramTotalBytes));
  const total = totalRaw != null && totalRaw > 0 ? totalRaw : null;
  const scale = memBarScale(kind, cur, peak, avg, total);
  const fillPct = clampPct((cur / scale) * 100);
  return {
    kind, cur, peak, avg, idle, total, scale, fillPct,
    peakPct: clampPct((peak / scale) * 100),
    avgPct: clampPct((avg / scale) * 100),
    hot: vram && fillPct >= 85,
    // 近期趋势（旧→新的字节序列）；服务端没给时由客户端 2s 轮询补齐
    series: memSeries(vram ? mem.vramSeries : mem.ramSeries)
  };
}

/** Short idle age: 12s / 4m / 3h / 2d. nowMs defaults to Date.now(). */
export function formatIdleFor(sinceMs, nowMs) {
  const since = Number(sinceMs);
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  if (!Number.isFinite(since) || since <= 0) return "";
  let sec = Math.floor((now - since) / 1000);
  if (sec < 0) sec = 0;
  if (sec < 60) return sec + "s";
  const min = Math.floor(sec / 60);
  if (min < 60) return min + "m";
  const hr = Math.floor(min / 60);
  if (hr < 48) return hr + "h";
  return Math.floor(hr / 24) + "d";
}

/** idleSinceMs from memory, else the client's last task finishedAt, else null. */
export function idleSinceOf(mem, fallbackMs) {
  const fromMem = mem && Number(mem.idleSinceMs);
  if (Number.isFinite(fromMem) && fromMem > 0) return fromMem;
  const fb = Number(fallbackMs);
  return Number.isFinite(fb) && fb > 0 ? fb : null;
}

/**
 * Second line under the instance name:
 * "<model> · <GPU name> · vulkan:0 · :18090". Empty parts are dropped.
 */
export function instanceSubtitle(inst, modelName) {
  const parts = [];
  if (modelName) parts.push(String(modelName));
  const gpu = inst && inst.memory && typeof inst.memory.gpuName === "string" ? inst.memory.gpuName.trim() : "";
  if (gpu) parts.push(gpu);
  if (inst && inst.backend) {
    const dev = inst.device != null && inst.device !== "" ? ":" + inst.device : "";
    parts.push(String(inst.backend) + dev);
  }
  if (inst && inst.port != null && inst.port !== "") parts.push(":" + inst.port);
  return parts.join(" · ");
}

/**
 * Sum vramBytes across instances. Total is the sum of per-GPU vramTotalBytes,
 * de-duplicated by GPU name (instances on the same card share one total).
 * Unnamed totals share one bucket and the first total wins — the backend only
 * emits vramTotalBytes when exactly one GPU is present. Returns null when no
 * instance reports a VRAM reading (a missing field is not zero).
 */
export function aggregateVram(list) {
  if (!Array.isArray(list) || !list.length) return null;
  let used = 0;
  let saw = false;
  const totals = new Map();
  for (const inst of list) {
    const mem = inst && inst.memory;
    if (!mem || typeof mem !== "object") continue;
    const bytes = mem.vramBytes;
    if (typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0) {
      used += bytes;
      saw = true;
    }
    const total = mem.vramTotalBytes;
    if (typeof total === "number" && Number.isFinite(total) && total > 0) {
      const name = typeof mem.gpuName === "string" ? mem.gpuName.trim() : "";
      const key = name || "anon";
      if (!totals.has(key)) totals.set(key, total);
    }
  }
  if (!saw) return null;
  let totalBytes = null;
  if (totals.size) {
    totalBytes = 0;
    for (const v of totals.values()) totalBytes += v;
  }
  return { usedBytes: used, totalBytes };
}

/** "3.6 / 8.0 GiB" when both sides are GiB, else separate units, or used only. */
export function formatVramHead(agg) {
  if (!agg) return "";
  const usedMiB = agg.usedBytes / MEM_MIB;
  if (!Number.isFinite(usedMiB) || usedMiB < 0) return "";
  const totalMiB = typeof agg.totalBytes === "number" && agg.totalBytes > 0 ? agg.totalBytes / MEM_MIB : null;
  if (totalMiB != null && usedMiB >= 1024 && totalMiB >= 1024) {
    return `${(usedMiB / 1024).toFixed(1)} / ${(totalMiB / 1024).toFixed(1)} GiB`;
  }
  if (totalMiB != null) return `${formatMiB(usedMiB)} / ${formatMiB(totalMiB)}`;
  return formatMiB(usedMiB);
}

/* 取自带序列的内存对象：只留有限数字，最多 SPARK_CAP 个（取最近的一端）。
   少于 2 个点返回空数组（画不出线，调用方据此不渲染 svg）。纯函数。 */
export function memSeries(series) {
  if (!Array.isArray(series)) return [];
  const vals = series.filter(v => typeof v === "number" && Number.isFinite(v) && v >= 0);
  return vals.length > SPARK_CAP ? vals.slice(vals.length - SPARK_CAP) : vals;
}

/**
 * 折线图的 polyline points。
 *
 * 少于 2 个点返回 ""（单点画不出趋势，调用方不渲染 svg）。
 * 纵向范围取 min..max 并各留 ~15% 余量，让线条不贴边；完全平坦的序列画在
 * 中线（基线）上，不放大成方波。坐标为 1 位小数。纯函数。
 * @param {Array<number>} series 旧→新
 * @param {number} [w] viewBox 宽
 * @param {number} [h] viewBox 高
 * @returns {string} "x,y x,y …" 或 ""
 */
export function sparkPoints(series, w, h) {
  const vals = memSeries(series);
  if (vals.length < 2) return "";
  const W = Number(w) > 0 ? Number(w) : SPARK_W;
  const H = Number(h) > 0 ? Number(h) : SPARK_H;
  const step = W / (vals.length - 1);
  const r1 = n => Math.round(n * 10) / 10;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (!(hi > lo)) {
    // 平序列：画在基线上（中线），一眼能看出「一直是这个值」
    const y = r1(H / 2);
    return vals.map((_, i) => `${r1(i * step)},${y}`).join(" ");
  }
  const pad = (hi - lo) * 0.15;
  lo -= pad;
  hi += pad;
  const top = 1, bottom = H - 1;
  return vals.map((v, i) => {
    const y = bottom - ((v - lo) / (hi - lo)) * (bottom - top);
    return `${r1(i * step)},${r1(Math.min(bottom, Math.max(top, y)))}`;
  }).join(" ");
}

/**
 * 客户端兜底序列：服务端没给 ramSeries / vramSeries（旧 hub、或没升级的部署）
 * 时，用 2s 轮询自己攒。同一拍读数不重复追加（memory.sampledAt 不变即同一拍）。
 * 纯函数。
 * @param {{at:number,ram:number[],vram:number[]}|null|undefined} prev 上一拍
 * @param {any} mem 这一拍的 memory 对象
 * @returns {{at:number,ram:number[],vram:number[]}}
 */
export function nextSparkState(prev, mem) {
  const state = prev && typeof prev === "object" ? prev : { at: 0, ram: [], vram: [] };
  if (!mem || typeof mem !== "object") return state;
  const at = Number(mem.sampledAt) || 0;
  if (at > 0 && at === state.at) return state; // 同一拍读数（SSE 触发重画）不追加
  return {
    at,
    ram: pushSparkSample(state.ram, mem.ramBytes),
    vram: pushSparkSample(state.vram, mem.vramBytes)
  };
}

/* 追加一个采样点并裁到 SPARK_CAP；非法值 / 缺失值被丢弃（VRAM 未读到不是 0）。纯函数。 */
export function pushSparkSample(series, value) {
  const list = Array.isArray(series) ? series.slice() : [];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return list;
  list.push(value);
  return list.length > SPARK_CAP ? list.slice(list.length - SPARK_CAP) : list;
}

/* 客户端攒出来的折线序列：instanceId → {at, ram[], vram[]}。
   只在服务端没给 series（旧 hub / 没升级的部署）时兜底，所以量很小：
   每实例最多 60×2 个数字，实例消失即丢。 */
const sparkStore = new Map();

/* 给这一拍的 memory 对象补序列：服务端给了就用服务端的（1s 一拍更密），
   缺的那个字段用 2s 轮询攒出来的顶上。
   返回的是 memory 对象本身（没有 memory 时返回 null），不是实例。
   卡片与详情弹窗同一写法：memBlockHtml(withSparkSeries(inst))。 */
function withSparkSeries(inst) {
  const mem = inst && inst.memory;
  if (!mem || typeof mem !== "object") return null;
  const state = nextSparkState(sparkStore.get(inst.id), mem);
  sparkStore.set(inst.id, state);
  if (Array.isArray(mem.ramSeries) && Array.isArray(mem.vramSeries)) return mem;
  const next = { ...mem };
  if (!Array.isArray(mem.ramSeries) && state.ram.length >= 2) next.ramSeries = state.ram;
  if (!Array.isArray(mem.vramSeries) && state.vram.length >= 2) next.vramSeries = state.vram;
  return next;
}

/* 列表里已经没有的实例（已停止 / 启动失败）丢掉它的序列，Map 不随启停无界增长。 */
function pruneSparkStore() {
  for (const id of [...sparkStore.keys()]) {
    if (!instances.some(i => i.id === id)) sparkStore.delete(id);
  }
}

/**
 * 一行的取值单位：行内最大值 ≥ 1024 MiB 时整行统一用 GiB（1 位小数），
 * 否则用 MiB（取整）。统计行与无障碍文本共用它，避免同一行里混单位。
 * 纯函数。
 */
export function memUnitFormat(values) {
  const vals = values.filter(v => Number.isFinite(v));
  const unit = vals.length && Math.max(...vals) >= 1024 ? "GiB" : "MiB";
  return { unit, fmt: v => (unit === "GiB" ? (v / 1024).toFixed(1) : String(Math.round(v))) };
}

/**
 * 条形下方那行统计：「Peak 988 · Avg 700 · Idle 598 MiB」。
 * 单位只在行尾出现一次；idle 未知时整项省略。纯函数（文案走 t()）。
 */
export function memStatsLabel(row) {
  const { unit, fmt } = memUnitFormat([row.peak, row.avg, row.idle]);
  const parts = [`${t("instance.memStatPeak")} ${fmt(row.peak)}`, `${t("instance.memStatAvg")} ${fmt(row.avg)}`];
  if (Number.isFinite(row.idle)) parts.push(`${t("instance.memStatIdle")} ${fmt(row.idle)}`);
  return `${parts.join(" · ")} ${unit}`;
}

/* 进度条的无障碍名称 / 值文本（两者同文），并作为整块的 title 提示。
   例：VRAM 4.1 GiB now, peak 4.2, average 3.7, idle 3.6 GiB——当前值自带单位，
   峰值 / 均值 / 空闲共用行尾那一个。纯函数。 */
export function memAriaText(row) {
  const base = row.kind === "vram" ? "instance.memAriaVram" : "instance.memAriaRam";
  const { unit, fmt } = memUnitFormat([row.peak, row.avg, row.idle]);
  const params = { cur: formatMiB(row.cur), peak: fmt(row.peak), avg: fmt(row.avg), unit };
  return Number.isFinite(row.idle)
    ? t(base + "Idle", { ...params, idle: fmt(row.idle) })
    : t(base, params);
}

/* 填充宽度与峰值/均值刻度只写 data-w / data-l。CSP style-src 'self'（headers.go）会丢掉
   markup 里的 style=""；插入 DOM 后由 applyMemBars 用 CSSOM 写成 width / left。 */
function memRowHtml(row) {
  const key = row.kind === "vram" ? t("instance.memKeyVram") : t("instance.memKeyRam");
  /* 有 GPU 总量时标签行写「/ total」，不再叠一个 now；没有总量（RAM，或旧 hub
     没给 vramTotalBytes）就只写 now。Idle 在下面的统计行，字段缺失则整项省略。 */
  const valueTail = row.total
    ? `<span class="of num">/ ${esc(formatMiB(row.total))}</span>`
    : `<span class="of">${esc(t("instance.memNow"))}</span>`;
  const aria = memAriaText(row);
  return `<div class="mem-row">
      <div class="mem-l"><span class="k">${esc(key)}</span><span class="v num">${esc(formatMiB(row.cur))}</span>${valueTail}${sparkHtml(row)}</div>
      <div class="bar" role="meter" aria-label="${esc(aria)}" aria-valuetext="${esc(aria)}" aria-valuemin="0" aria-valuemax="${num1(row.scale)}" aria-valuenow="${num1(row.cur)}">
        <div class="fill ${row.kind}${row.hot ? " hot" : ""}" data-w="${row.fillPct}"></div>
        <div class="pk" data-l="${row.peakPct}" aria-hidden="true"></div>
        <div class="avg" data-l="${row.avgPct}" aria-hidden="true"></div>
      </div>
      <div class="stats3">${esc(memStatsLabel(row))}</div>
    </div>`;
}

/* 标签行右端的迷你折线（近期趋势）。少于 2 个采样点返回 ""——一条线画不出来，
   就不放占位空框。stroke 颜色走 style.css 的 .spark.ram / .spark.vram（CSP
   style-src 'self' 不允许 inline style，SVG presentation 属性不受影响）。 */
function sparkHtml(row) {
  const pts = sparkPoints(row.series, SPARK_W, SPARK_H);
  if (!pts) return "";
  return `<svg class="spark ${esc(row.kind)}" width="${SPARK_W}" height="${SPARK_H}" viewBox="0 0 ${SPARK_W} ${SPARK_H}" aria-hidden="true" focusable="false"><polyline points="${pts}" fill="none" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

/**
 * 一个实例的内存条 HTML（实例卡片与详情弹窗共用）。没有 memory（旧 hub /
 * 尚未采样）或没有当前读数时返回 ""；VRAM 从未读到时只画 RAM 行。
 * 整块挂 title 提示：无障碍文本 + 采样来源 / 采样次数明细。
 */
export function memBlockHtml(mem) {
  const ramp = memRowModel("ram", mem);
  const vram = memRowModel("vram", mem);
  const rows = [ramp, vram].filter(Boolean);
  if (!rows.length) return "";
  const tip = rows.map(memAriaText);
  if (vram) {
    tip.push(t("instance.memTipVram", {
      cur: formatMiB(vram.cur), peak: formatMiB(vram.peak), avg: formatMiB(vram.avg),
      source: t("instance.memSource." + (mem.vramSource || "none"))
    }));
  }
  tip.push(t("instance.memTipMeta", {
    n: mem.samples != null ? mem.samples : 0,
    state: mem.busy ? t("instance.memBusy") : t("instance.memIdle")
  }));
  const legend = `<div class="mem-legend"><span><i class="pk"></i>${esc(t("instance.memStatPeak"))}</span><span><i class="avg"></i>${esc(t("instance.memStatAvg"))}</span></div>`;
  return `<div class="mem" title="${esc(tip.join("\n"))}">${rows.map(memRowHtml).join("")}${legend}</div>`;
}

/* CSP style-src 'self' 不放行 style=""（headers.go）。内存条的 data-w / data-l 在插入 DOM 后
   由这里写成 width / left；CSSOM 赋值不受这条限制。每次重画实例列表或详情弹窗后调用。 */
export function applyMemBars(rootEl) {
  if (!rootEl || typeof rootEl.querySelectorAll !== "function") return;
  for (const el of rootEl.querySelectorAll("[data-w]")) {
    const v = el.getAttribute("data-w");
    if (v != null && v !== "") el.style.width = v + "%";
  }
  for (const el of rootEl.querySelectorAll("[data-l]")) {
    const v = el.getAttribute("data-l");
    if (v != null && v !== "") el.style.left = v + "%";
  }
}

export const STATUS_CLASS = { STARTING: "starting", READY: "ready", ERROR: "error", STOPPED: "stopped" };
export function statusText(s) {
  const v = t("instance.status." + s);
  return v === "instance.status." + s ? s : v;
}

export const SUBMIT_BTNS = ["tts-submit", "asr-submit", "sep-submit", "music-submit", "other-submit"];
export const SUBMIT_KEYS = { "tts-submit": "tts.submit", "asr-submit": "asr.submit", "sep-submit": "sep.submit", "music-submit": "music.submit", "other-submit": "other.submit" };
export function submitLabel(id) {
  return t(SUBMIT_KEYS[id]);
}

export let instances = [];

/* ---------- 实例列表 + 状态条（每 2s 轮询） ---------- */
export let instancePoller = null;
let instancesLoaded = false;   // 首次成功拉取前显示骨架屏 / 失败时给可见错误+重试
/* One-shot: on first instance payload, prefer a model that already has a READY
   instance so Synthesize works without a manual model switch (issue #119). */
let autoReadyApplied = false;
/* 轮询数据回调：只在成功时更新视图；失败由 Api.poll 的 onError 处理 */
export function applyInstances(data) {
  instancesLoaded = true;
  instances = data;
  // 深链接 #/instance/<id>：实例列表就绪后补齐打开详情
  const want = getPendingInstanceId();
  if (want) {
    const inst = instances.find(i => i.id === want);
    if (inst) { setPendingInstanceId(null); openInstanceDetail(inst); }
  }
  maybeAutoSelectReadyModel();
  pruneSparkStore();
  renderInstanceList();
  updateInstanceBar();
  // 广播给不依赖本模块的外观层（页头 chip、实时状态行）：它们要的是「选中实例
  // 有没有任务 / 有几台就绪」，走窗口事件而不是互相 import，避免成环。
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent("hub-instances-updated", { detail: { instances } }));
  }
}

/* Prefer a Ready model on first load when the current selection has none.
   Skips deep-linked #/model/<id> so explicit navigation still wins. */
export function maybeAutoSelectReadyModel() {
  if (autoReadyApplied) return;
  if (!models.length) return; // instances may arrive before models; retry next poll
  autoReadyApplied = true;
  const ready = instances.filter(i => i.status === "READY");
  if (!ready.length) return;
  const route = parseRoute(location.hash);
  if (route.view === "model" && route.id) return; // deep link wins
  if (ready.some(i => i.modelId === selectedModelId)) return;
  const remembered = localStorage.getItem("hub-model");
  const pick = ready.find(i => i.modelId === remembered)
    || ready.find(i => models.some(m => m.id === i.modelId))
    || ready[0];
  if (!pick || pick.modelId === selectedModelId) return;
  selectModelById(pick.modelId);
  if (route.view === "home" || !location.hash || location.hash === "#/" || location.hash === "#") {
    history.replaceState(null, "", modelRoute(pick.modelId));
  }
}
/* 轮询中的瞬时失败保留上次列表，仅在从未加载成功时显示错误/重试 */
export function onInstancesError(e) {
  if (instances.length === 0) renderListError($("instance-list"), t("common.loadFailed") + t("common.colon") + e.message, refreshInstances);
}

export function refreshInstances() {
  if (instancePoller) return instancePoller.refresh();
  return Api.list("/api/instances").then(applyInstances).catch(onInstancesError);
}

/* 建立 2s 轮询（由 web/app.js 在启动时调用一次）。句柄只在本模块持有：
   Api.poll 保证上一轮结束才排下一轮、标签页隐藏时不发请求、重新可见立即补一次。
   Api.poll 默认 immediate：建轮询时首轮请求已发出，所以这里只需在首轮回来之前占位。 */
export function startInstancePolling() {
  if (!instancesLoaded) showSkeleton($("instance-list"), 3);
  instancePoller = Api.poll("/api/instances", applyInstances, { list: true, onError: onInstancesError });
  return instancePoller;
}

/* Right-aligned "idle 4m". Hidden while generating. Falls back to the last
   finished task when memory.idleSinceMs is absent. */
function idleLabelHtml(inst, busy) {
  if (busy || !inst) return "";
  const since = idleSinceOf(inst.memory, idleFallbacks.get(inst.id));
  if (!since) return "";
  const label = formatIdleFor(since);
  if (!label) return "";
  return `<span class="idle-for" title="${esc(t("instance.idleForTip"))}">${esc(t("instance.idleFor", { t: label }))}</span>`;
}

export function renderInstanceList() {
  const list = $("instance-list");
  list.removeAttribute("aria-busy");
  // 展示全部实例（不再按选中模型过滤），用 sortInstances 取一个全序：
  // 状态 → createdAt → name → id。map 迭代顺序随机的后端也据此稳定下来，
  // 2s 轮询重画时卡片不会跳位（排序与选中 / 忙碌无关）。
  const sorted = sortInstances(instances);
  list.innerHTML = "";
  if (instances.length === 0) {
    renderEmptyState(list, t("instance.empty"), {
      label: t("instance.create"),
      onClick: openLaunchModal
    });
    syncBusyTimer();
    return;
  }
  for (const inst of sorted) {
    const m = models.find(x => x.id === inst.modelId);
    const modelName = m ? I18N.pick(m, "displayName") : inst.modelId;
    const card = document.createElement("div");
    const statusClass = STATUS_CLASS[inst.status] || "stopped";
    card.className = "card" + (inst.id === activeInstanceId ? " selected" : "");
    // 忙碌只有一个徽标：「生成中…」+ 脉冲圆点 + 计时。SSE 与轮询合并成同一个
    // 来源（resolveBusy），原先轮询的「工作中」徽标已合并进来。
    const busy = busyState(inst);
    noteBusyAnchor(inst, busy);
    if (busy.busy) card.classList.add("generating");
    // Generating replaces the status pill (Ready / Starting / …). Idle shows
    // the status pill only. The idle-for label is hidden while generating, and
    // the elapsed clock moves to the card header's right side instead.
    const statusBadge = busy.busy
      ? ""
      : `<span class="badge ${statusClass}">${esc(statusText(inst.status))}</span>`;
    const busyBadge = busy.busy ? generatingBadgeHtml(inst.id, false) : "";
    const elapsedHtml = busy.busy ? cardElapsedHtml(inst.id) : "";
    const idleHtml = idleLabelHtml(inst, busy.busy);
    const memHtml = memBlockHtml(withSparkSeries(inst));
    const extra = [`#${inst.id}`];
    if (inst.executableName) extra.push(inst.executableName);
    let html = `<div class="card-title"><span class="card-name">${esc(inst.instanceName || inst.modelId)}</span>${statusBadge}${busyBadge}${elapsedHtml}${idleHtml}</div>
      <div class="card-family">${esc(instanceSubtitle(inst, modelName))}</div>
      <div class="card-desc">${esc(extra.join(" · "))}</div>${memHtml}`;
    if (inst.status === "ERROR" && inst.errorMessage) {
      html += `<div class="error-text">${esc(inst.errorMessage)}</div>`;
    }
    if (inst.status !== "STOPPED") {
      html += `<div class="card-actions"><button class="btn-ghost detail-btn">${t("instance.detail")}</button><button class="stop-btn">${t("instance.stop")}</button></div>`;
    }
    card.innerHTML = html;
    applyMemBars(card);
    const detailBtn = card.querySelector(".detail-btn");
    if (detailBtn) detailBtn.onclick = () => go("#/instance/" + encodeURIComponent(inst.id));
    const stopBtn = card.querySelector(".stop-btn");
    if (stopBtn) {
      stopBtn.onclick = async () => {
        // 停止请求的失败不单独提示：实例状态以下一轮 2s 轮询为准（显式吞掉错误）
        await Api.del("/api/instances/{id}", { params: { id: inst.id } }).catch(() => {});
        refreshInstances();
      };
    }
    list.appendChild(card);
  }
  syncBusyTimer();
}

export function updateInstanceBar() {
  /* 下拉只列当前模型的就绪实例，顺序与卡片同一套全序（不按选中态重排）。 */
  const ready = sortInstances(instances.filter(i => i.modelId === selectedModelId && i.status === "READY"));
  const select = $("instance-select");
  select.innerHTML = "";
  for (const inst of ready) {
    const opt = document.createElement("option");
    opt.value = inst.id;
    opt.textContent = `${inst.instanceName || inst.modelId} ｜ ${inst.backend}${inst.device != null ? ":" + inst.device : ""} ｜ ${t("instance.port")} ${inst.port} ｜ #${inst.id}`;
    select.appendChild(opt);
  }
  const has = ready.length > 0;
  if (has) {
    if (!ready.some(i => i.id === activeInstanceId)) {
      selectActiveInstance(ready[0].id);
    }
    select.value = activeInstanceId;
  } else {
    selectActiveInstance(null);
  }
  // 注意：历史按 modelId 维度记录，与激活哪个实例无关，实例启停/切换不得刷新历史列表
  // （重建 DOM 会打断行内播放、折叠已展开的播放器）
  select.disabled = !has;
  $("instance-stop").disabled = !has;
  $("instance-detail").disabled = !has;
  // 详情弹窗打开时跟随轮询刷新；实例已消失则自动关闭
  if (detailInstanceId) {
    const cur = instances.find(i => i.id === detailInstanceId);
    if (cur) renderInstanceDetail(cur); else closeInstanceDetail();
  }

  const active = instances.find(i => i.id === activeInstanceId);
  const barBusy = busyState(active);
  // Generating replaces the Ready pill on the toolbar too. No ready instance
  // still shows the warn pill, and never the generating pill.
  const showGen = has && barBusy.busy;
  const pill = $("instance-pill");
  pill.textContent = has ? t("instance.ready") : t("instance.noReady");
  pill.className = "pill " + (has ? "ok" : "warn") + (showGen ? " hidden" : "");

  // 左栏标题行右侧的实例台数（与「实时事件」灯并排，见 index.html 的 .sec-head）
  const cnt = $("instance-count");
  if (cnt) cnt.textContent = instancesLoaded ? I18N.num(instances.length) : "";

  const vramEl = $("instance-vram");
  if (vramEl) {
    const text = formatVramHead(aggregateVram(instances));
    vramEl.textContent = text ? t("instance.vramHead", { text }) : "";
    if (text) vramEl.title = t("instance.vramHeadTip");
    else vramEl.removeAttribute("title");
  }

  // 与卡片同一个忙碌来源（resolveBusy）。生成中时藏起 Ready 胶囊。
  const gen = $("instance-generating");
  if (gen) {
    if (showGen && active) noteBusyAnchor(active, barBusy);
    // innerHTML 一次换掉旧片段。textContent 会先清掉子节点，重绘间隙里
    // 共享计时器会看见「没有 .badge-elapsed」而把 interval 停掉。
    // 工具栏上没有卡片那样的标题行，耗时仍放在胶囊里（同一份 .pulse 形状）。
    gen.innerHTML = showGen && active ? generatingBadgeHtml(active.id, true) : "";
    gen.classList.toggle("hidden", !showGen);
  }

  for (const id of SUBMIT_BTNS) {
    const btn = $(id);
    if (!btn) continue;
    btn.disabled = !has;
    // Keep the verb clean; the one-line ready-hint explains why it's disabled (#119).
    btn.textContent = submitLabel(id);
    if (!has) btn.title = t("instance.noReady");
    else btn.removeAttribute("title");
  }
  const hintMap = {
    "tts-submit": "tts-ready-hint",
    "asr-submit": "asr-ready-hint",
    "sep-submit": "sep-ready-hint",
    "music-submit": "music-ready-hint",
    "other-submit": "other-ready-hint"
  };
  for (const hintId of Object.values(hintMap)) {
    const hint = $(hintId);
    if (!hint) continue;
    hint.classList.toggle("hidden", has);
    if (!has) {
      hint.textContent = hintId === "tts-ready-hint" ? t("tts.needReady") : t("submit.needReady");
    }
  }
  syncBusyTimer();
}

/* 选中实例的唯一写入口：变化时广播一个窗口事件。页头 chip 与「实时状态行」
   （web/modules/hub-chip.js / live-ticker.js）要知道选中对象换没换，走事件而不是
   互相 import——那两个模块单向依赖本模块（读 instances / formatBusyElapsed）。 */
function selectActiveInstance(id) {
  if (id === activeInstanceId) return;
  setActiveInstanceId(id);
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent("hub-active-instance", { detail: { id } }));
  }
}

$("instance-select").onchange = (e) => {
  selectActiveInstance(e.target.value);
  renderInstanceList();
};

$("instance-stop").onclick = async () => {
  if (!activeInstanceId) return;
  $("instance-stop").disabled = true;
  await Api.del("/api/instances/{id}", { params: { id: activeInstanceId } }).catch(() => {});
  refreshInstances();
};

/* ---------- 实例详情弹窗 ---------- */
export const instanceDetailModal = $("instance-detail-modal");
export let detailInstanceId = null;
export function openInstanceDetail(inst) {
  detailInstanceId = inst.id;
  renderInstanceDetail(inst);
  instanceDetailModal.classList.remove("hidden");
  focusDialog(instanceDetailModal);
}
export function closeInstanceDetail() {
  detailInstanceId = null;
  instanceDetailModal.classList.add("hidden");
  restoreDialogFocus();
  window.hubPanelClosed("instance");
}
export function renderInstanceDetail(inst) {
  const body = $("instance-detail-body");
  body.innerHTML = "";
  const model = models.find(m => m.id === inst.modelId);
  const rows = [
    [t("instance.field.name"), inst.instanceName || inst.modelId],
    [t("instance.field.id"), "#" + inst.id],
    [t("instance.field.model"), model ? `${I18N.pick(model, "displayName")}（${inst.modelId}）` : inst.modelId],
    [t("instance.field.status"), statusText(inst.status)],
    [t("instance.field.weights"), inst.weightsPath],
    [t("instance.field.backend"), inst.backend],
    [t("instance.field.device"), inst.device != null ? String(inst.device) : t("instance.valueAuto")],
    [t("instance.field.port"), String(inst.port)],
    [t("instance.field.threads"), inst.threads != null ? String(inst.threads) : t("instance.valueAuto")],
    [t("instance.field.executable"), inst.executableName || "-"],
    [t("instance.field.createdAt"), inst.createdAt ? I18N.date(inst.createdAt) : "-"]
  ];
  const addRow = (keyText, valueNode) => {
    const row = document.createElement("div");
    row.className = "kv-row";
    const key = document.createElement("span");
    key.className = "kv-key";
    key.textContent = keyText;
    row.appendChild(key);
    row.appendChild(valueNode);
    body.appendChild(row);
  };
  for (const [k, v] of rows) {
    const val = document.createElement("span");
    val.className = "kv-val";
    val.textContent = v;
    addRow(k, val);
  }
  const memHtml = memBlockHtml(withSparkSeries(inst));
  if (memHtml) {
    const val = document.createElement("span");
    val.className = "kv-val mem-kv";
    val.innerHTML = memHtml;
    applyMemBars(val);
    addRow(t("instance.field.memory"), val);
  }
  const opts = inst.sessionOptions || {};
  const names = Object.keys(opts);
  if (names.length) {
    const list = document.createElement("div");
    list.className = "kv-opts";
    for (const name of names) {
      const item = document.createElement("code");
      item.textContent = `${name}=${opts[name]}`;
      list.appendChild(item);
    }
    addRow(t("instance.field.sessionOptions"), list);
  } else {
    const val = document.createElement("span");
    val.className = "kv-val";
    val.textContent = t("instance.valueNone");
    addRow(t("instance.field.sessionOptions"), val);
  }
}
$("instance-detail").onclick = () => {
  if (activeInstanceId) go("#/instance/" + encodeURIComponent(activeInstanceId));
};
$("instance-detail-close").onclick = closeInstanceDetail;
instanceDetailModal.onclick = (e) => { if (e.target === instanceDetailModal) closeInstanceDetail(); };
