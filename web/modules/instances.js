import { focusDialog, renderEmptyState, renderListError, restoreDialogFocus, showSkeleton, showToast } from "./async-ui.js";
import { $, Api, esc, t } from "./dom.js";
import { openLaunchModal } from "./launch.js";
import { getPendingInstanceId, go, setPendingInstanceId } from "./routing.js";
import { activeInstanceId, models, selectedModelId, setActiveInstanceId } from "./state.js";

/* #174 Instance cards: total-order sort (status, createdAt, name, id; ignores
   selection/busy so cards don't jump on poll redraws) and RAM/VRAM bars with
   peak/avg markers plus a client-side sparkline. Bar geometry is written via
   CSSOM in applyMemBars because CSP style-src 'self' drops inline style="". */
export function sortInstances(list) {
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

const MEM_MIB = 1024 * 1024;
const SPARK_W = 74;
const SPARK_H = 16;
const SPARK_CAP = 60;

function memMiB(bytes) {
  return typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0 ? bytes / MEM_MIB : NaN;
}
function numOr(v, dflt) { return Number.isFinite(v) ? v : dflt; }
function opt(v) { return Number.isFinite(v) ? v : null; }
function num1(v) { return Math.round(v * 10) / 10; }

export function formatMiB(mib) {
  if (typeof mib !== "number" || !Number.isFinite(mib) || mib < 0) return "";
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GiB` : `${Math.round(mib)} MiB`;
}

export function clampPct(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 0;
  return n >= 100 ? 100 : Math.round(n * 10) / 10;
}

export function memBarScale(kind, cur, peak, avg, total) {
  if (typeof total === "number" && Number.isFinite(total) && total > 0) return total;
  const head = kind === "vram" ? Math.max(peak, cur, avg) : Math.max(peak, cur);
  const scale = (Number.isFinite(head) ? head : 0) * 1.25;
  return scale > 0 ? scale : 1;
}

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
    idlePct: idle == null ? null : clampPct((idle / scale) * 100),
    hot: vram && fillPct >= 85,
    series: memSeries(vram ? mem.vramSeries : mem.ramSeries)
  };
}

export function memSeries(series) {
  if (!Array.isArray(series)) return [];
  const vals = series.filter(v => typeof v === "number" && Number.isFinite(v) && v >= 0);
  return vals.length > SPARK_CAP ? vals.slice(vals.length - SPARK_CAP) : vals;
}

export function sparkPoints(series, w, h) {
  const vals = memSeries(series);
  if (vals.length < 2) return "";
  const W = Number(w) > 0 ? Number(w) : SPARK_W;
  const H = Number(h) > 0 ? Number(h) : SPARK_H;
  const step = W / (vals.length - 1);
  const r1 = n => Math.round(n * 10) / 10;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (!(hi > lo)) {
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

export function nextSparkState(prev, mem) {
  const state = prev && typeof prev === "object" ? prev : { at: 0, ram: [], vram: [] };
  if (!mem || typeof mem !== "object") return state;
  const at = Number(mem.sampledAt) || 0;
  if (at > 0 && at === state.at) return state;
  return {
    at,
    ram: pushSparkSample(state.ram, mem.ramBytes),
    vram: pushSparkSample(state.vram, mem.vramBytes)
  };
}

export function pushSparkSample(series, value) {
  const list = Array.isArray(series) ? series.slice() : [];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return list;
  list.push(value);
  return list.length > SPARK_CAP ? list.slice(list.length - SPARK_CAP) : list;
}

const sparkStore = new Map();

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

function pruneSparkStore() {
  for (const id of [...sparkStore.keys()]) {
    if (!instances.some(i => i.id === id)) sparkStore.delete(id);
  }
}

export function memUnitFormat(values) {
  const vals = values.filter(v => Number.isFinite(v));
  const unit = vals.length && Math.max(...vals) >= 1024 ? "GiB" : "MiB";
  return { unit, fmt: v => (unit === "GiB" ? (v / 1024).toFixed(1) : String(Math.round(v))) };
}

export function memStatsLabel(row) {
  const { unit, fmt } = memUnitFormat([row.peak, row.avg, row.idle]);
  const parts = [`${t("instance.memStatPeak")} ${fmt(row.peak)}`, `${t("instance.memStatAvg")} ${fmt(row.avg)}`];
  if (Number.isFinite(row.idle)) parts.push(`${t("instance.memStatIdle")} ${fmt(row.idle)}`);
  return `${parts.join(" · ")} ${unit}`;
}

export function memAriaText(row) {
  const base = row.kind === "vram" ? "instance.memAriaVram" : "instance.memAriaRam";
  const { unit, fmt } = memUnitFormat([row.peak, row.avg, row.idle]);
  const params = { cur: formatMiB(row.cur), peak: fmt(row.peak), avg: fmt(row.avg), unit };
  return Number.isFinite(row.idle)
    ? t(base + "Idle", { ...params, idle: fmt(row.idle) })
    : t(base, params);
}

function memRowHtml(row) {
  const key = row.kind === "vram" ? t("instance.memKeyVram") : t("instance.memKeyRam");
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
        ${row.idlePct == null ? "" : `<div class="idle" data-l="${row.idlePct}" aria-hidden="true"></div>`}
      </div>
      <div class="stats3">${esc(memStatsLabel(row))}</div>
    </div>`;
}

function sparkHtml(row) {
  const pts = sparkPoints(row.series, SPARK_W, SPARK_H);
  if (!pts) return "";
  return `<svg class="spark ${esc(row.kind)}" width="${SPARK_W}" height="${SPARK_H}" viewBox="0 0 ${SPARK_W} ${SPARK_H}" aria-hidden="true" focusable="false"><polyline points="${pts}" fill="none" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

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
  const legend = `<div class="mem-legend"><span><i class="pk"></i>${esc(t("instance.memStatPeak"))}</span><span><i class="avg"></i>${esc(t("instance.memStatAvg"))}</span>${hasIdle(rows) ? `<span><i class="id"></i>${esc(t("instance.memStatIdle"))}</span>` : ""}</div>`;
  return `<div class="mem" title="${esc(tip.join("\n"))}">${rows.map(memRowHtml).join("")}${legend}</div>`;
}

function hasIdle(rows) {
  return rows.some(r => Number.isFinite(r.idle));
}

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

export let instancePoller = null;
let instancesLoaded = false;
let instanceFeedStale = false;

export function applyInstances(data) {
  instancesLoaded = true;
  instanceFeedStale = false;
  instances = data;

  const want = getPendingInstanceId();
  if (want) {
    const inst = instances.find(i => i.id === want);
    if (inst) { setPendingInstanceId(null); openInstanceDetail(inst); }
  }
  pruneSparkStore();
  renderInstanceList();
  updateInstanceBar();
  // #178: tell the header farm/hub chip a fresh list arrived (a window event, not an import, to avoid a cycle).
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent("hub-instances-updated", { detail: { instances } }));
  }
}

export function onInstancesError(e) {
  instanceFeedStale = true;
  const pill = $("instance-pill");
  pill.textContent = t("instance.pollStale");
  pill.className = "pill warn";
  for (const id of SUBMIT_BTNS) $(id).disabled = true;
  document.querySelectorAll("#instance-select,#instance-stop,#instance-detail,#instance-list .stop-btn").forEach(el => el.setAttribute("disabled", ""));
  $("instance-context").classList.add("hidden");
  if (!instancesLoaded) renderListError($("instance-list"), t("common.loadFailed") + t("common.colon") + e.message, refreshInstances);
}

export function refreshInstances() {
  if (instancePoller) return instancePoller.refresh();
  return Api.list("/api/instances").then(applyInstances).catch(onInstancesError);
}

export function startInstancePolling() {
  if (!instancesLoaded) showSkeleton($("instance-list"), 3);
  instancePoller = Api.poll("/api/instances", applyInstances, { list: true, onError: onInstancesError });
  return instancePoller;
}

export function renderInstanceList() {
  const list = $("instance-list");
  list.removeAttribute("aria-busy");

  const sorted = sortInstances(instances);
  list.innerHTML = "";
  if (instances.length === 0) {
    renderEmptyState(list, t("instance.empty"), {
      label: t("instance.create"),
      onClick: openLaunchModal
    });
    return;
  }
  for (const inst of sorted) {
    const m = models.find(x => x.id === inst.modelId);
    const modelName = m ? I18N.pick(m, "displayName") : inst.modelId;
    const card = document.createElement("div");
    const statusClass = STATUS_CLASS[inst.status] || "stopped";
    card.className = "card" + (inst.id === activeInstanceId ? " selected" : "");

    const workingBadge = (inst.taskCount || 0) > 0
      ? ` <span class="badge working">${esc(inst.taskCount > 1 ? t("instance.workingCount", { n: inst.taskCount }) : t("instance.working"))}</span>`
      : "";
    let html = `<div class="card-title">${esc(inst.instanceName || inst.modelId)} <span class="badge ${statusClass}">${esc(statusText(inst.status))}</span>${workingBadge}</div>
      <div class="card-family">${esc(modelName)} ｜ #${esc(inst.id)}</div>
      <div class="card-desc">${esc(inst.backend)}${inst.device != null ? ":" + esc(inst.device) : ""} ｜ ${esc(t("instance.port"))} ${esc(inst.port)}${inst.executableName ? " ｜ " + esc(inst.executableName) : ""}</div>`;
    html += memBlockHtml(withSparkSeries(inst));
    if (inst.status === "ERROR" && inst.errorMessage) {
      html += `<div class="error-text">${esc(inst.errorMessage)}</div>`;
    }
    if (inst.status !== "STOPPED") {
      html += `<div class="card-actions"><button class="btn-ghost detail-btn">${t("instance.detail")}</button><button class="stop-btn">${t("instance.stop")}</button></div>`;
    }
    card.innerHTML = html;
    const detailBtn = card.querySelector(".detail-btn");
    if (detailBtn) detailBtn.onclick = () => go("#/instance/" + encodeURIComponent(inst.id));
    const stopBtn = card.querySelector(".stop-btn");
    if (stopBtn) {
      if (instanceFeedStale) stopBtn.setAttribute("disabled", "");
      stopBtn.onclick = async () => {
        stopBtn.setAttribute("disabled", "");
        await stopInstance(inst.id);
        stopBtn.removeAttribute("disabled");
      };
    }
    list.appendChild(card);
  }
  applyMemBars(list);
}

export function updateInstanceBar() {
  const ready = instances.filter(i => i.modelId === selectedModelId && i.status === "READY");
  const select = $("instance-select");
  select.innerHTML = "";
  for (const inst of ready) {
    const opt = document.createElement("option");
    opt.value = inst.id;
    opt.textContent = `${inst.instanceName || inst.modelId} ｜ ${inst.backend}${inst.device != null ? ":" + inst.device : ""} ｜ ${t("instance.port")} ${inst.port} ｜ #${inst.id}`;
    select.appendChild(opt);
  }
  const has = ready.length > 0 && !instanceFeedStale;
  if (has) {
    if (!ready.some(i => i.id === activeInstanceId)) {
      setActiveInstanceId(ready[0].id);
    }
    select.value = activeInstanceId;
  } else {
    setActiveInstanceId(null);
  }


  select.disabled = !has;
  $("instance-stop").disabled = !has;
  $("instance-detail").disabled = !has;

  if (detailInstanceId) {
    const cur = instances.find(i => i.id === detailInstanceId);
    if (cur) renderInstanceDetail(cur); else closeInstanceDetail();
  }

  const pill = $("instance-pill");
  pill.textContent = instanceFeedStale ? t("instance.pollStale") : has ? t("instance.ready") : t("instance.noReady");
  pill.className = "pill " + (has ? "ok" : "warn");


  const context = $("instance-context");
  if (has || instanceFeedStale) {
    context.classList.add("hidden");
  } else {
    const target = selectedModelId;
    void import("./readiness.js").then(({ renderReadiness }) => {
      if (!instanceFeedStale && selectedModelId === target && !instances.some(i => i.modelId === target && i.status === "READY")) {
        renderReadiness(instances, models, target);
      }
    }).catch(() => { context.classList.add("hidden"); });
  }

  for (const id of SUBMIT_BTNS) {
    const btn = $(id);
    btn.disabled = !has;
    btn.textContent = has ? submitLabel(id) : submitLabel(id) + t("instance.noReadySuffix");
  }
}

export async function stopInstance(id) {
  try {
    await Api.del("/api/instances/{id}", { params: { id } });
  } catch (e) {
    showToast("error", t("instance.stopFailed") + t("common.colon") + (e?.message || String(e)));
  } finally {
    refreshInstances();
  }
}

$("instance-select").onchange = (e) => {
  setActiveInstanceId(e.target.value);
  renderInstanceList();
};

$("instance-stop").onclick = async () => {
  if (!activeInstanceId) return;
  $("instance-stop").disabled = true;
  await stopInstance(activeInstanceId);
};

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
