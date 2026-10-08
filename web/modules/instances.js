/* web/modules/instances.js — 实例
 *
 * 左栏实例列表、顶部实例状态条（选择 / 停止 / 详情）、实例详情弹窗，
 * 以及 2s 轮询的建立与复用（Api.poll 句柄在模块内保存，单飞 + 可见性语义不变）。 */

import { focusDialog, renderEmptyState, renderListError, restoreDialogFocus, showSkeleton } from "./async-ui.js";
import { $, Api, esc, t } from "./dom.js";
import { openLaunchModal } from "./launch.js";
import { selectModelById } from "./models.js";
import { getPendingInstanceId, go, modelRoute, parseRoute, setPendingInstanceId } from "./routing.js";
import { activeInstanceId, isGenerating, models, selectedModelId, setActiveInstanceId } from "./state.js";

/* 内存字节的展示口径（二进制 1024）：≥ 1 GiB 保留 1 位小数的 GB，
   ≥ 1 MiB 取整为 MB，更小则 KB / B。不足 1 GB 不写成 0.x GB。
   纯函数，供实例卡片与单元测试共用。 */
export function formatMemBytes(n) {
  const kib = 1024;
  const mib = kib * 1024;
  const gib = mib * 1024;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "";
  if (n >= gib) return `${(n / gib).toFixed(1)} GB`;
  if (n >= mib) return `${Math.round(n / mib)} MB`;
  if (n >= kib) return `${Math.round(n / kib)} KB`;
  return `${Math.round(n)} B`;
}

/* 峰值 / 均值与当前值同一单位时去掉单位，得到「3.6 GB · peak 4.1 · avg 3.7」。 */
export function formatMemCompanion(n, cur) {
  const full = formatMemBytes(n);
  if (!full) return "";
  const unitOf = (x) => {
    if (typeof x !== "number" || !Number.isFinite(x) || x < 0) return "";
    if (x >= 1024 * 1024 * 1024) return "GB";
    if (x >= 1024 * 1024) return "MB";
    if (x >= 1024) return "KB";
    return "B";
  };
  if (unitOf(n) && unitOf(n) === unitOf(cur)) return full.slice(0, full.lastIndexOf(" "));
  return full;
}

/* 卡片上的两行文案 + title 明细。没有 memory（旧 hub / 尚未采样）返回 null。
   没有 VRAM 读数时 vram 为空串，调用方不画那一行。 */
export function memoryCardLines(mem) {
  if (!mem || typeof mem.ramBytes !== "number") return null;
  const ram = t("instance.memRam", {
    cur: formatMemBytes(mem.ramBytes),
    peak: formatMemCompanion(mem.ramPeakBytes, mem.ramBytes),
    avg: formatMemCompanion(mem.ramAvgBytes, mem.ramBytes)
  });
  let vram = "";
  if (typeof mem.vramBytes === "number") {
    vram = t("instance.memVram", {
      cur: formatMemBytes(mem.vramBytes),
      peak: formatMemCompanion(mem.vramPeakBytes, mem.vramBytes),
      avg: formatMemCompanion(mem.vramAvgBytes, mem.vramBytes)
    });
  }
  const tip = [
    t("instance.memTipRam", {
      cur: formatMemBytes(mem.ramBytes),
      peak: formatMemBytes(mem.ramPeakBytes),
      avg: formatMemBytes(mem.ramAvgBytes)
    })
  ];
  if (vram) {
    tip.push(t("instance.memTipVram", {
      cur: formatMemBytes(mem.vramBytes),
      peak: formatMemBytes(mem.vramPeakBytes),
      avg: formatMemBytes(mem.vramAvgBytes),
      source: t("instance.memSource." + (mem.vramSource || "none"))
    }));
  }
  tip.push(t("instance.memTipMeta", {
    n: mem.samples != null ? mem.samples : 0,
    state: mem.busy ? t("instance.memBusy") : t("instance.memIdle")
  }));
  return { ram, vram, title: tip.join("\n") };
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
  renderInstanceList();
  updateInstanceBar();
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

export function renderInstanceList() {
  const list = $("instance-list");
  list.removeAttribute("aria-busy");
  // 展示全部实例（不再按选中模型过滤）：就绪 > 启动中 > 其它，可用的始终排在最前
  const order = { READY: 0, STARTING: 1 };
  const sorted = [...instances].sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2));
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
    // 有活跃任务（QUEUED/RUNNING）时追加转圈“工作中”徽标，随 2s 轮询自动出现/消失
    const workingBadge = (inst.taskCount || 0) > 0
      ? ` <span class="badge working">${esc(inst.taskCount > 1 ? t("instance.workingCount", { n: inst.taskCount }) : t("instance.working"))}</span>`
      : "";
    const genBadge = isGenerating(inst.id)
      ? ` <span class="badge generating">${esc(t("instance.generating"))}</span>`
      : "";
    const mem = memoryCardLines(inst.memory);
    const memHtml = mem
      ? `<div class="card-mem" title="${esc(mem.title)}">${esc(mem.ram)}${mem.vram ? "<br>" + esc(mem.vram) : ""}</div>`
      : "";
    let html = `<div class="card-title">${esc(inst.instanceName || inst.modelId)} <span class="badge ${statusClass}">${esc(statusText(inst.status))}</span>${workingBadge}${genBadge}</div>
      <div class="card-family">${esc(modelName)} ｜ #${esc(inst.id)}</div>
      <div class="card-desc">${esc(inst.backend)}${inst.device != null ? ":" + esc(inst.device) : ""} ｜ ${esc(t("instance.port"))} ${esc(inst.port)}${inst.executableName ? " ｜ " + esc(inst.executableName) : ""}</div>${memHtml}`;
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
      stopBtn.onclick = async () => {
        // 停止请求的失败不单独提示：实例状态以下一轮 2s 轮询为准（显式吞掉错误）
        await Api.del("/api/instances/{id}", { params: { id: inst.id } }).catch(() => {});
        refreshInstances();
      };
    }
    list.appendChild(card);
  }
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
  const has = ready.length > 0;
  if (has) {
    if (!ready.some(i => i.id === activeInstanceId)) {
      setActiveInstanceId(ready[0].id);
    }
    select.value = activeInstanceId;
  } else {
    setActiveInstanceId(null);
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

  const pill = $("instance-pill");
  pill.textContent = has ? t("instance.ready") : t("instance.noReady");
  pill.className = "pill " + (has ? "ok" : "warn");

  const gen = $("instance-generating");
  if (gen) {
    gen.textContent = t("instance.generating");
    gen.classList.toggle("hidden", !(has && isGenerating(activeInstanceId)));
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
}

$("instance-select").onchange = (e) => {
  setActiveInstanceId(e.target.value);
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
  const memLines = memoryCardLines(inst.memory);
  if (memLines) {
    const val = document.createElement("span");
    val.className = "kv-val pre";
    val.textContent = memLines.vram ? `${memLines.ram}\n${memLines.vram}` : memLines.ram;
    val.title = memLines.title;
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
