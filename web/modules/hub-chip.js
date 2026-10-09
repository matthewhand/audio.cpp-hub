/* web/modules/hub-chip.js — 页头状态 chip
 *
 * 概念稿页头图标工具栏左侧有一颗 chip：「● Hub 4/4 ready · 0 failures」。
 * 本模块是它的落地版，元素是 index.html 里的 #hub-chip（header-actions 的第一项，
 * 即图标工具栏左边）。
 *
 * 数据全部来自 hub 自己的两个接口，**不发跨源请求**：
 *   - 就绪台数：2s 轮询的 GET /api/instances（instances.js 每次拉到数据后广播
 *     hub-instances-updated 窗口事件，本模块只消费事件，不另起轮询）；
 *   - 失败次数：GET /api/stats 的 totals.failed（历史索引口径，**全量累计**，
 *     不是最近一小时——tooltip 里写明了这一点）。30s 一拉，失败静默忽略：
 *     统计拉不到时 chip 照常显示就绪台数。
 *
 * 刻意**不请求 fan-out 的 /farm/health**：那是另一个源，而本页的 CSP
 * connect-src 只有 'self'（见 headers.go），跨源 fetch 会被浏览器直接拦掉，
 * 连错误提示都拿不到。hub 摆到 fan-out 后面时，这颗 chip 描述的就是当前这台 hub。 */

import { $, Api, t } from "./dom.js";
import { instances } from "./instances.js";

/* stats 拉取间隔：失败计数不需要 2s 级新鲜度 */
const STATS_POLL_MS = 30000;

const el = $("hub-chip");
const dotEl = $("hub-chip-dot");
const textEl = $("hub-chip-text");
const sepEl = $("hub-chip-sep");
const failEl = $("hub-chip-failures");

/* 实例列表是否已经到过手（没到过就整体隐藏，不显示 0/0 冒充数据） */
let loaded = false;
/* totals.failed；null = 还没拉到 / 拉取失败 */
let failures = null;
let lastSignature = "";

/**
 * chip 的显示模型。纯函数，单测按 en / zh 两份词典跑。
 * 数据不可用（实例列表还没到过手）时调用方整行隐藏，不会走到这里——
 * 所以这里不需要「空数据」分支。
 * @param {{total:number, ready:number, failed:number|null}} input
 * @returns {{dot:"ok"|"warn"|"err", text:string, failed:string, failN:number|null, aria:string}}
 */
export function hubChipModel(input) {
  const total = Number(input && input.total) || 0;
  const ready = Number(input && input.ready) || 0;
  // null / 缺字段 = 统计还没到（Number(null) 是 0，不能拿来判断）
  const rawFailed = input ? input.failed : null;
  const failed = rawFailed == null || !Number.isFinite(Number(rawFailed))
    ? null
    : Math.max(0, Number(rawFailed));
  const text = t("chip.ready", { ready, total });
  const failedText = failed === null ? "" : I18N.plural("chip.failures", failed);
  const dot = ready > 0 && ready === total ? "ok" : ready > 0 ? "warn" : "err";
  return {
    dot,
    text,
    failed: failedText,
    /* null = 统计还没到；0 也要显示「0 failures」，但不变红 */
    failN: failed,
    aria: failedText
      ? t("chip.ariaWithFailed", { text, failed: failedText })
      : t("chip.aria", { text })
  };
}

/* 实例列表 → 就绪台数 / 总台数 */
function counts() {
  const list = Array.isArray(instances) ? instances : [];
  return { total: list.length, ready: list.filter(i => i && i.status === "READY").length };
}

/** 按当前数据重画 chip；数据不可用时整体隐藏。 */
export function renderHubChip() {
  if (!el) return;
  if (!loaded) {
    el.classList.add("hidden");
    return;
  }
  const { total, ready } = counts();
  const model = hubChipModel({ total, ready, failed: failures });
  const signature = [model.text, model.failed, model.dot].join("|");
  if (signature === lastSignature) return; // 数据没变就不动 DOM
  lastSignature = signature;
  el.classList.remove("hidden");
  el.classList.toggle("warn", model.dot === "warn");
  el.classList.toggle("err", model.dot === "err");
  el.classList.toggle("has-fail", (model.failN || 0) > 0);
  if (dotEl) dotEl.className = "chip-dot " + model.dot;
  if (textEl) textEl.textContent = model.text;
  if (sepEl) sepEl.classList.toggle("hidden", !model.failed);
  if (failEl) failEl.textContent = model.failed;
  el.setAttribute("aria-label", model.aria);
  el.title = model.failed ? t("chip.tipWithFailed", { failed: model.failed }) : t("chip.tip");
}

/** 由 web/app.js 在启动时调用一次。 */
export function startHubChip() {
  if (!el) return;
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("hub-instances-updated", () => { loaded = true; renderHubChip(); });
  }
  // 失败次数来自 /api/stats 的全量累计（tooltip 已说明口径）；拉不到就只显示就绪台数
  Api.poll("/api/stats", (data) => {
    const totals = data && data.totals;
    failures = totals && Number.isFinite(Number(totals.failed)) ? Number(totals.failed) : null;
    renderHubChip();
  }, { interval: STATS_POLL_MS, onError: () => {} });
}
