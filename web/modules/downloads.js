/* web/modules/downloads.js — 下载面板渲染（**懒加载 chunk**）
 *
 * 页头 ⬇️ 的下载管理面板（进度、暂停/续传/删除、角标计数）与模型卡片上的
 * 「按模型下载」弹窗（下载源 / 包 / token / 覆盖）。两者都只在用户点开后用得上，
 * 因此本模块**不在首屏模块图**里：调用方（routing.js / models.js / app.js）走
 * 首屏外观层 modules/downloads-lazy.js，由它 import("./downloads.js") 按需拉取。
 *
 * 下载数据（轮询、角标、2s 轮询句柄）留在外观层——角标在首屏就要动。本模块只负责
 * 两个弹窗的 DOM：列表渲染、包清单渲染与「开始下载」提交。
 *
 * 本模块曾以静态 import 参与首屏（那时连轮询与角标也在这里），随 perf:budget 的
 * 棘轮改成懒加载 chunk，实测表见 scripts/perf-budget.mjs 顶注。 */

import { focusDialog, renderEmptyState, restoreDialogFocus, showSkeleton, showToast } from "./async-ui.js";
import { $, Api, el, esc, markRowEnter, t } from "./dom.js";
import { getDownloads, hasDownloadsLoaded, refreshDownloads } from "./downloads-lazy.js";
import { go } from "./routing.js";
import { models, selectedModelId } from "./state.js";

let mdlPackages = null;
let mdlModel = null;

export function fmtBytes(n) {
  if (n == null || n < 0) return "?";
  return I18N.bytes(n);
}

const DL_STATUS_CLASS = { RUNNING: "starting", PENDING: "starting", PAUSED: "stopped", DONE: "ready", FAILED: "error" };

/* ---------- 下载管理弹窗 ---------- */
export function openDownloadsModal() {
  // 首次数据尚未返回时显示骨架并立即拉取（数据在外观层，拉到后回调这里重画）
  if (!hasDownloadsLoaded()) { showSkeleton($("dl-list"), 3); refreshDownloads(); }
  renderDownloadList();
}
export function closeDownloadsModal() {
  $("downloads-modal").classList.add("hidden");
  restoreDialogFocus();
  window.hubPanelClosed("downloads");
}
$("downloads-modal-close").onclick = closeDownloadsModal;
$("downloads-modal").onclick = (e) => { if (e.target === $("downloads-modal")) closeDownloadsModal(); };

export function renderDownloadList() {
  const downloads = getDownloads();
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
    <div class="dl-row-meta">${esc(fmtBytes(d.downloadedBytes))} / ${esc(fmtBytes(d.totalBytes))}${pctOk && pct >= 0 ? ` ｜ ${esc(I18N.percent(pctShown))}` : ""}${d.status === "RUNNING" && d.speedBps > 0 ? ` ｜ ${esc(t("dl.speed", { v: fmtBytes(d.speedBps) }))}` : ""} ｜ ${esc(t("dl.fileProgress", { done: d.completedFiles, n: d.fileCount }))}</div>`;
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
        try {
          await Api.post("/api/downloads/{id}/{act}", undefined, {
            params: { id: d.id, act: btn.dataset.act }
          });
        } catch (e) {
          showToast("error", e.message);
        }
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
      try {
        await Api.del("/api/downloads/{id}", { params: { id: d.id }, query: { purge: "true" } });
      } catch (e) {
        showToast("error", e.message);
      }
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

async function loadMdlPackages(m) {
  try {
    // 包清单是对象（{packages:[...]}）而不是数组，用 get 而非 list
    mdlPackages = await Api.get("/api/models/{id}/packages", { params: { id: m.id } });
    renderMdlPackages();
  } catch (e) {
    const box = el(`<div class="hint"></div>`);
    box.textContent = t("dl.loadFailed") + t("common.colon") + e.message;
    $("mdl-package-list").innerHTML = "";
    $("mdl-package-list").appendChild(box);
  }
}

function renderMdlPackages() {
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
    if (p.gated) name.appendChild(el(` <span class="badge stopped">${t("dl.gated")}</span>`));
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
    await Api.post("/api/downloads", body);
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

/* 语言切换重画（由外观层 downloads-lazy.js 转发，只在弹窗已开时调）：
   两个弹窗的可见文案都来自 t()，切换语言后按原条件重画。 */
export function relocalize() {
  if (!$("downloads-modal").classList.contains("hidden")) renderDownloadList();
  if (!$("model-dl-modal").classList.contains("hidden") && mdlPackages) renderMdlPackages();
}
