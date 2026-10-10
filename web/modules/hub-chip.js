/* web/modules/hub-chip.js — 页头状态 chip
 *
 * 概念稿页头图标工具栏左侧有一颗 chip：「● Hub 4/4 ready · 0 failures」。
 * 本模块是它的落地版，元素是 index.html 里的 #hub-chip（header-actions 的第一项，
 * 即图标工具栏左边）。
 *
 * 浏览器不打另一个源（CSP connect-src 'self'）。农场数字走 hub 自己的
 * GET /api/farm/health：服务端去拉配置好的 fan-out URL，返回一小份摘要。
 * available 为真时 chip 显示「Farm n/n · failures」；否则退回本机口径：
 *   - 就绪台数：2s 轮询的 GET /api/instances（hub-instances-updated）；
 *   - 失败次数：GET /api/stats 的 totals.failed（历史索引全量累计，不是最近一小时）。 */

import { $, Api, t } from "./dom.js";
import { instances } from "./instances.js";

/* stats 拉取间隔：失败计数不需要 2s 级新鲜度。农场摘要服务端缓存约 5s。 */
const STATS_POLL_MS = 30000;
const FARM_POLL_MS = 5000;

const el = $("hub-chip");
const dotEl = $("hub-chip-dot");
const textEl = $("hub-chip-text");
const sepEl = $("hub-chip-sep");
const failEl = $("hub-chip-failures");
const hubEl = $("hub-chip-hub");
const hubSepEl = $("hub-chip-hub-sep");

/* 实例列表是否已经到过手（农场不可用时，没到过就整体隐藏，不显示 0/0） */
let loaded = false;
/* totals.failed；null = 还没拉到 / 拉取失败 */
let failures = null;
/* GET /api/farm/health 的最近一份摘要；null = 还没拉到 */
let farm = null;
let lastSignature = "";

/**
 * chip 的显示模型。纯函数，单测按 en / zh 两份词典跑。
 * 数据不可用（实例列表还没到过手）时调用方整行隐藏，不会走到这里——
 * 所以这里不需要「空数据」分支。hub 恒为空串：本机 chip 不画第三段
 * （那是农场 chip 的「这台 hub 的 GPU 名」）。
 * @param {{total:number, ready:number, failed:number|null}} input
 * @returns {{dot:"ok"|"warn"|"err", text:string, failed:string, failN:number|null, hub:string, aria:string, tip:string}}
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
    hub: "",
    aria: failedText
      ? t("chip.ariaWithFailed", { text, failed: failedText })
      : t("chip.aria", { text }),
    tip: failedText ? t("chip.tipWithFailed", { failed: failedText }) : t("chip.tip")
  };
}

/**
 * 农场 chip。ok = 全部 hub 在线且失败为 0；一台都没在线或总数为 0 是 err；
 * 部分在线或有失败是 warn。failures 用既有的 chip.failures 复数。
 * hubLabel 是这台 hub 的名字（服务端 /api/farm/health 的 hubLabel，缺失时由
 * gpuHubLabel 从本机 GPU 名推），空字符串表示不画第三段。
 * @param {{hubsUp:number, hubsTotal:number, failures:number, hubLabel?:string}} input
 * @returns {{dot:"ok"|"warn"|"err", text:string, failed:string, failN:number|null, hub:string, aria:string, tip:string}}
 */
export function farmChipModel(input) {
  const up = Math.max(0, Math.trunc(Number(input && input.hubsUp) || 0));
  const total = Math.max(0, Math.trunc(Number(input && input.hubsTotal) || 0));
  const failN = Math.max(0, Math.trunc(Number(input && input.failures) || 0));
  const hub = input && typeof input.hubLabel === "string" ? input.hubLabel.trim() : "";
  const text = t("chip.farm", { up, total });
  const failedText = I18N.plural("chip.failures", failN);
  const dot = total === 0 || up === 0 ? "err" : up === total && failN === 0 ? "ok" : "warn";
  const baseTip = failN ? t("chip.farmTipWithFailed", { failed: failedText }) : t("chip.farmTip");
  return {
    dot,
    text,
    failed: failedText,
    failN,
    hub,
    aria: failN
      ? t("chip.farmAriaWithFailed", { text, failed: failedText })
      : t("chip.farmAria", { text }),
    tip: hub ? baseTip + t("chip.tipThisHub", { label: hub }) : baseTip
  };
}

/**
 * 本机 GPU 名 → chip 第三段的短标签。「NVIDIA GeForce GTX 1080」→「GTX 1080 hub」。
 * 去掉厂商与系列词后什么都不剩（例如只有 "NVIDIA"）时看下一台实例；
 * 一台都没有 gpuName 就返回空串（那一节整段省略）。纯函数。
 * @param {any[]} list 2s 轮询拿到的实例列表
 * @returns {string}
 */
export function gpuHubLabel(list) {
  for (const inst of Array.isArray(list) ? list : []) {
    const mem = inst && inst.memory;
    const raw = mem && typeof mem.gpuName === "string" ? mem.gpuName.trim() : "";
    if (!raw) continue;
    const short = raw.replace(/\b(?:nvidia|geforce)\b/gi, " ").replace(/\s+/g, " ").trim();
    if (!short) continue;
    return t("chip.gpuHub", { name: short });
  }
  return "";
}

/**
 * available === true 用农场摘要；否则用本机 hub chip。
 * 农场摘要的 hubLabel（服务端匹配出来的，见 farm_health.go）优先；
 * 它缺失时（旧 hub、单机部署）用本机 GPU 名推一个。两个都没有 → 不画第三段。
 * @returns {{source:"farm"|"hub", model:{dot:"ok"|"warn"|"err", text:string, failed:string,
 *           failN:number|null, hub:string, aria:string, tip:string}}}
 */
export function selectChip(farmSummary, local) {
  if (farmSummary && farmSummary.available === true) {
    const raw = farmSummary.hubLabel;
    const fromServer = typeof raw === "string" ? raw.trim() : "";
    const hub = fromServer || gpuHubLabel(local && local.instances);
    return { source: "farm", model: farmChipModel({ ...farmSummary, hubLabel: hub }) };
  }
  return { source: "hub", model: hubChipModel(local || {}) };
}

/* 实例列表 → 就绪台数 / 总台数 */
function counts() {
  const list = Array.isArray(instances) ? instances : [];
  return { total: list.length, ready: list.filter(i => i && i.status === "READY").length, instances: list };
}

/** 按当前数据重画 chip；数据不可用时整体隐藏。 */
export function renderHubChip() {
  if (!el) return;
  const { total, ready } = counts();
  const choice = selectChip(farm, { total, ready, failed: failures, instances: counts().instances });
  // 农场还没答上来时，沿用「实例列表没到就藏起来」；农场可用则不必等本机列表。
  if (choice.source === "hub" && !loaded) {
    el.classList.add("hidden");
    return;
  }
  const model = choice.model;
  const signature = [choice.source, model.text, model.failed, model.dot, model.hub || ""].join("|");
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
  /* 第三段：这台 hub 的 GPU 名。没有标签时整段（含分隔线）收起来，chip 回到两段。 */
  const hub = model.hub || "";
  if (hubSepEl) hubSepEl.classList.toggle("hidden", !hub);
  if (hubEl) hubEl.textContent = hub;
  el.setAttribute("aria-label", model.aria);
  el.title = model.tip || "";
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
  // 同源摘要。服务端缓存约 5s，这里按同一节奏拉；失败就退回本机 chip。
  Api.poll("/api/farm/health", (data) => {
    farm = data && typeof data === "object" ? data : { available: false };
    renderHubChip();
  }, { interval: FARM_POLL_MS, onError: () => { farm = { available: false }; renderHubChip(); } });
}
