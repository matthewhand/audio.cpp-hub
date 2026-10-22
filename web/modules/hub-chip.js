
import { $, Api, t } from "./dom.js";
import { instances } from "./instances.js";
const STATS_POLL_MS = 30000;
const FARM_POLL_MS = 5000;

const el = $("hub-chip");
const dotEl = $("hub-chip-dot");
const textEl = $("hub-chip-text");
const sepEl = $("hub-chip-sep");
const failEl = $("hub-chip-failures");
const hubEl = $("hub-chip-hub");
const hubSepEl = $("hub-chip-hub-sep");
let loaded = false;
let failures = null;
let farm = null;
let lastSignature = "";

export function hubChipModel(input) {
  const total = Number(input && input.total) || 0;
  const ready = Number(input && input.ready) || 0;

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
    failN: failed,
    hub: "",
    aria: failedText
      ? t("chip.ariaWithFailed", { text, failed: failedText })
      : t("chip.aria", { text }),
    tip: failedText ? t("chip.tipWithFailed", { failed: failedText }) : t("chip.tip")
  };
}

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

export function selectChip(farmSummary, local) {
  if (farmSummary && farmSummary.available === true) {
    const raw = farmSummary.hubLabel;
    const fromServer = typeof raw === "string" ? raw.trim() : "";
    const hub = fromServer || gpuHubLabel(local && local.instances);
    return { source: "farm", model: farmChipModel({ ...farmSummary, hubLabel: hub }) };
  }
  return { source: "hub", model: hubChipModel(local || {}) };
}
function counts() {
  const list = Array.isArray(instances) ? instances : [];
  return { total: list.length, ready: list.filter(i => i && i.status === "READY").length, instances: list };
}

export function renderHubChip() {
  if (!el) return;
  const { total, ready } = counts();
  const choice = selectChip(farm, { total, ready, failed: failures, instances: counts().instances });

  if (choice.source === "hub" && !loaded) {
    el.classList.add("hidden");
    return;
  }
  const model = choice.model;
  const signature = [choice.source, model.text, model.failed, model.dot, model.hub || ""].join("|");
  if (signature === lastSignature) return;
  lastSignature = signature;
  el.classList.remove("hidden");
  el.classList.toggle("warn", model.dot === "warn");
  el.classList.toggle("err", model.dot === "err");
  el.classList.toggle("has-fail", (model.failN || 0) > 0);
  if (dotEl) dotEl.className = "chip-dot " + model.dot;
  if (textEl) textEl.textContent = model.text;
  if (sepEl) sepEl.classList.toggle("hidden", !model.failed);
  if (failEl) failEl.textContent = model.failed;
  const hub = model.hub || "";
  if (hubSepEl) hubSepEl.classList.toggle("hidden", !hub);
  if (hubEl) hubEl.textContent = hub;
  el.setAttribute("aria-label", model.aria);
  el.title = model.tip || "";
}

export function farmSummary() {
  return farm;
}

export function startHubChip() {
  if (!el) return;
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("hub-instances-updated", () => { loaded = true; renderHubChip(); });
  }

  Api.poll("/api/stats", (data) => {
    const totals = data && data.totals;
    failures = totals && Number.isFinite(Number(totals.failed)) ? Number(totals.failed) : null;
    renderHubChip();
  }, { interval: STATS_POLL_MS, onError: () => {} });

  const publishFarm = (data) => {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new CustomEvent("hub-farm-summary", { detail: farm }));
    }
    return data;
  };
  Api.poll("/api/farm/health", (data) => {
    farm = data && typeof data === "object" ? data : { available: false };
    renderHubChip();
    publishFarm(data);
  }, { interval: FARM_POLL_MS, onError: () => { farm = { available: false }; renderHubChip(); publishFarm(null); } });
}
