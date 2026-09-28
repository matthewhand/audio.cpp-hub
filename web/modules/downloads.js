/* web/modules/downloads.js — 模型权重下载
 *
 * 页头 ⬇️ 的下载管理面板（进度、暂停/续传/删除、角标计数）与模型卡片上的
 * 「按模型下载」弹窗（下载源 / 包 / token / 覆盖）。下载任务状态只服务本面板，
 * 因此 download 列表与按模型弹窗状态都留在本模块。 */

import { focusDialog, isOpen, renderEmptyState, renderStateError, restoreDialogFocus, showSkeleton, showToast } from "./async-ui.js";
import { $, Api, el, esc, markRowEnter, t } from "./dom.js";
import { go, goPanel } from "./routing.js";
import { models, selectedModelId } from "./state.js";

/* ---------- 下载管理（任务列表 + 模型下载弹窗） ---------- */
export let downloads = [];
export let mdlPackages = null;
export let mdlModel = null;

export function fmtBytes(n) {
  if (n == null || n < 0) return "?";
  return I18N.bytes(n);
}

export const DL_STATUS_CLASS = { RUNNING: "starting", PENDING: "starting", PAUSED: "stopped", DONE: "ready", FAILED: "error" };
export let downloadsPoller = null;
let downloadsLoaded = false;   // 首次成功拉取前才显示骨架屏 / 失败时才给可见错误

export function applyDownloads(data) {
  downloadsLoaded = true;
  downloads = data;
  updateDlBadge();
  if (isOpen("downloads-modal")) renderDownloadList();
}
/* 失败处理：已加载过一次就静默（下载列表是 2s 轮询的附属信息，瞬时失败下轮自愈）；
   从未加载成功且面板正开着时，给可见错误 + 重试，避免只剩骨架屏。 */
export function onDownloadsError(e) {
  if (downloadsLoaded) return;
  if (isOpen("downloads-modal")) renderStateError($("dl-list"), e, refreshDownloads);
}
/* 立即拉一次：复用轮询句柄（可 await），轮询未建立时直接请求一次 */
export function refreshDownloads() {
  if (downloadsPoller) return downloadsPoller.refresh();
  return Api.list("/api/downloads").then(applyDownloads).catch(onDownloadsError);
}

/* 建立 2s 轮询（由 web/app.js 在启动时调用一次）。句柄只在本模块持有。 */
export function startDownloadsPolling() {
  downloadsPoller = Api.poll("/api/downloads", applyDownloads, { list: true, onError: onDownloadsError });
  return downloadsPoller;
}

/* 页头角标：进行中的任务数 */
export function updateDlBadge() {
  const running = downloads.filter(d => d.status === "RUNNING" || d.status === "PENDING").length;
  const badge = $("dl-badge");
  badge.textContent = running;
  badge.classList.toggle("hidden", running === 0);
}

export function openDownloadsModal() {
  // 首次数据尚未返回时显示骨架并立即拉取
  if (!downloadsLoaded) { showSkeleton($("dl-list"), 3); refreshDownloads(); }
  renderDownloadList();
  $("downloads-modal").classList.remove("hidden");
  focusDialog($("downloads-modal"));
}
export function closeDownloadsModal() {
  $("downloads-modal").classList.add("hidden");
  restoreDialogFocus();
  window.hubPanelClosed("downloads");
}
$("downloads-btn").onclick = () => goPanel("downloads");
$("downloads-modal-close").onclick = closeDownloadsModal;
$("downloads-modal").onclick = (e) => { if (e.target === $("downloads-modal")) closeDownloadsModal(); };

export function renderDownloadList() {
  const list = $("dl-list");
  list.innerHTML = "";
  list.removeAttribute("aria-busy");
  if (downloads.length === 0) {
    renderEmptyState(list, t("dl.empty"));
    return;
  }
  for (const d of downloads) {
    const model = d.modelId ? models.find(m => m.id === d.modelId) : null;
    const title = model ? I18N.pick(model, "displayName") : d.targetDir;
    // 百分比来自服务端，做数值化 + 钳制后再拼进 style，杜绝属性注入
    const pct = Number(d.percent);
    const pctOk = Number.isFinite(pct);
    const pctShown = pctOk ? Math.max(0, Math.min(100, pct)) : 100;
    const row = document.createElement("div");
    row.className = "dl-row";
    let html = `<div class="dl-row-head">
      <span class="dl-row-title">${esc(title)} <span class="dl-row-dir">models/${esc(d.targetDir)}</span></span>
      <span class="badge ${DL_STATUS_CLASS[d.status] || "stopped"}">${esc(t("dl.status." + d.status))}</span>
    </div>
    <div class="dl-progress"><div class="dl-progress-fill${!pctOk || pct < 0 ? " indeterminate" : ""}" style="width:${pctShown}%"></div></div>
    <div class="dl-row-meta">${esc(fmtBytes(d.downloadedBytes))} / ${esc(fmtBytes(d.totalBytes))}${pctOk && pct >= 0 ? ` ｜ ${esc(I18N.percent(pctShown))}` : ""}${d.status === "RUNNING" && d.speedBps > 0 ? ` ｜ ${esc(fmtBytes(d.speedBps))}/s` : ""} ｜ ${esc(t("dl.fileProgress", { done: d.completedFiles, n: d.fileCount }))}</div>`;
    if (d.status === "FAILED" && d.error) {
      html += `<div class="error-text">${esc(d.error)}</div>`;
    }
    html += `<div class="card-actions">`;
    if (d.status === "RUNNING" || d.status === "PENDING") {
      html += `<button class="stop-btn dl-act" data-act="pause">${t("dl.pause")}</button>`;
    }
    if (d.status === "PAUSED" || d.status === "FAILED") {
      html += `<button class="stop-btn dl-act" data-act="resume">${t(d.status === "FAILED" ? "dl.retry" : "dl.resume")}</button>`;
    }
    if (d.status === "DONE" && d.modelId) {
      html += `<button class="stop-btn dl-fill">${t("dl.fillWeights")}</button>`;
    }
    html += `<button class="stop-btn dl-del">${t("dl.delete")}</button></div>`;
    row.innerHTML = html;
    for (const btn of row.querySelectorAll(".dl-act")) {
      btn.onclick = async () => {
        const res = await fetch(`/api/downloads/${d.id}/${btn.dataset.act}`, { method: "POST" });
        if (!res.ok) showToast("error", I18N.errText(await res.text()));
        refreshDownloads();
      };
    }
    const fillBtn = row.querySelector(".dl-fill");
    if (fillBtn) {
      fillBtn.onclick = () => {
        const path = "models/" + d.targetDir;
        localStorage.setItem("hub-weights-" + d.modelId, path);
        if (selectedModelId === d.modelId) $("launch-weights").value = path;
        showToast("info", t("dl.weightsFilled", { path }));
      };
    }
    row.querySelector(".dl-del").onclick = async () => {
      if (!window.confirm(t("dl.confirmDelete"))) return;
      const res = await fetch(`/api/downloads/${d.id}?purge=true`, { method: "DELETE" });
      if (!res.ok) showToast("error", I18N.errText(await res.text()));
      refreshDownloads();
    };
    markRowEnter(row, "d:" + d.id);
    list.appendChild(row);
  }
}

/* 模型下载弹窗：包选择 + token + 覆盖 */
export function openModelDlModal(m) {
  mdlModel = m;
  mdlPackages = null;
  $("mdl-dl-model").textContent = I18N.pick(m, "displayName");
  $("mdl-msg").textContent = "";
  $("mdl-package-list").innerHTML = `<div class="hint">${t("dl.loading")}</div>`;
  $("model-dl-modal").classList.remove("hidden");
  focusDialog($("model-dl-modal"));
  loadMdlPackages(m);
}
export function closeModelDlModal() {
  $("model-dl-modal").classList.add("hidden");
  restoreDialogFocus();
}
$("model-dl-modal-close").onclick = closeModelDlModal;
$("model-dl-modal").onclick = (e) => { if (e.target === $("model-dl-modal")) closeModelDlModal(); };

export async function loadMdlPackages(m) {
  try {
    const res = await fetch(`/api/models/${m.id}/packages`);
    const text = await res.text();
    if (!res.ok) throw new Error(I18N.errText(text));
    mdlPackages = JSON.parse(text);
    renderMdlPackages();
  } catch (e) {
    const box = el(`<div class="hint"></div>`);
    box.textContent = t("dl.loadFailed") + t("common.colon") + e.message;
    $("mdl-package-list").innerHTML = "";
    $("mdl-package-list").appendChild(box);
  }
}

export function renderMdlPackages() {
  const c = $("mdl-package-list");
  c.innerHTML = "";
  const pkgs = (mdlPackages && mdlPackages.packages) || [];
  if (pkgs.length === 0) {
    c.innerHTML = `<div class="hint">${t("dl.noPackages")}</div>`;
    return;
  }
  pkgs.forEach((p, i) => {
    const row = el(`<label class="dl-package-row">
      <input type="radio" name="mdl-package" value="${esc(p.id)}"${p.default || (!pkgs.some(x => x.default) && i === 0) ? " checked" : ""}>
      <span class="dl-package-text">
        <span class="dl-package-name"></span>
        <span class="dl-package-meta">${esc([p.format, p.precision].filter(Boolean).join(" ｜ "))} → models/${esc(p.targetDir)} ｜ ${esc(I18N.plural("dl.fileCount", (p.files || []).length))}</span>
      </span>
    </label>`);
    const name = row.querySelector(".dl-package-name");
    name.textContent = p.displayName || p.id;
    if (p.default) name.appendChild(el(` <span class="badge ready">${t("dl.recommended")}</span>`));
    if (p.gated) name.appendChild(el(` <span class="badge stopped">gated</span>`));
    c.appendChild(row);
  });
}

$("mdl-start").onclick = async () => {
  const msg = $("mdl-msg");
  msg.textContent = "";
  const sel = document.querySelector('input[name="mdl-package"]:checked');
  if (!sel || !mdlModel) {
    msg.textContent = t("dl.noPackages");
    return;
  }
  const body = {
    modelId: mdlModel.id,
    packageId: sel.value,
    overwrite: $("mdl-overwrite").checked
  };
  const token = $("mdl-token").value.trim();
  if (token) body.token = token;
  const endpoint = $("mdl-endpoint").value;
  if (endpoint === "modelscope") body.source = "modelscope";
  else if (endpoint) body.endpoint = endpoint;
  const btn = $("mdl-start");
  btn.disabled = true;
  try {
    const res = await fetch("/api/downloads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) {
      msg.textContent = t("dl.startFailed") + t("common.colon") + I18N.errText(text);
      return;
    }
    closeModelDlModal();
    showToast("info", t("dl.started"));
    await refreshDownloads();
    go("#/downloads");
  } catch (e) {
    msg.textContent = t("dl.startFailed") + t("common.colon") + e.message;
  } finally {
    btn.disabled = false;
  }
};
