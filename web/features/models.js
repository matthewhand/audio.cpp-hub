/* 模型列表（按 category 分组）+ HuggingFace 仓库弹出菜单。 */
import { $, esc, safeHttpUrl, bindMenuKeys } from "../core/dom.js";
import { apiGet } from "../core/api.js";
import { I18N, t } from "../core/i18n.js";
import { state, selectedModel } from "../core/state.js";
import { CATEGORY_ORDER, categoryName } from "../core/format.js";
import { showSkeleton, renderEmptyState, renderStateError, closeDrawer } from "../core/ui.js";
import { go, modelRoute, parseRoute } from "../core/router.js";
import { openModelDlModal } from "./downloads.js";
import { refreshInstances } from "./instances.js";
import { restoreWeightsPath } from "./executables.js";
import { renderWorkspace } from "./workspace.js";

export async function loadModels() {
  showSkeleton($("model-list"), 5);
  try {
    const data = await apiGet("/api/models");
    if (!Array.isArray(data)) throw new Error(t("common.loadFailed"));
    state.models = data;
  } catch (e) {
    renderStateError($("model-list"), e, loadModels);
    return;
  }
  if (state.models.length && !state.selectedModelId) {
    // 路由优先（深链接），其次恢复上次选中的模型（localStorage 仅作默认落地）
    const r = parseRoute(location.hash);
    const wanted = state.pendingModelId
      || (r.view === "model" ? r.id : null)
      || localStorage.getItem("hub-model");
    state.selectedModelId = state.models.some(m => m.id === wanted) ? wanted : state.models[0].id;
    state.pendingModelId = null;
  }
  // 深链接指向不存在的模型：用 replaceState 修正 URL（不新增历史记录、不触发 hashchange）
  const cur = parseRoute(location.hash);
  if (state.selectedModelId && cur.view === "model" && cur.id !== state.selectedModelId) {
    history.replaceState(null, "", modelRoute(state.selectedModelId));
  }
  renderModelList();
  updateQuickLaunchTitle();
  restoreWeightsPath();
  renderWorkspace();
}

/* 经路由选择模型：URL 同步为 #/model/<id>，前进/后退可还原 */
export function selectModelById(id) {
  if (!state.models.length) { state.pendingModelId = id; return; }
  const m = state.models.find(x => x.id === id);
  if (!m || m.id === state.selectedModelId) return;
  state.selectedModelId = m.id;
  localStorage.setItem("hub-model", m.id);
  renderModelList();
  updateQuickLaunchTitle();
  restoreWeightsPath();
  refreshInstances();
  renderWorkspace();
  closeDrawer();
}

/* 已配置 = 任一使用记录（Profile）的权重有效，且当前存在至少一个可用的 audiocpp_server。
   注意：Profile 关联的 executableId 可能已失效（可执行文件被删除/重加），
   但启动弹窗可改选其他可执行文件，所以不把失效的关联当作"未配置"。 */
export function modelConfigured(m) {
  const weightsOk = state.profiles.some(x => x.modelId === m.id && x.weightsPath && x.weightsExists !== false);
  return weightsOk && state.executables.some(e => e.exists);
}

let hfMenuEl = null;
let hfMenuAnchor = null;

function hfMirrorOf(url) {
  return url ? url.replace("https://huggingface.co/", "https://hf-mirror.com/") : null;
}

function closeHfMenu() {
  if (hfMenuEl) hfMenuEl.classList.remove("open");
  if (hfMenuAnchor) hfMenuAnchor.classList.remove("open");
  hfMenuAnchor = null;
}

function openHfMenu(anchor, m) {
  if (!hfMenuEl) {
    hfMenuEl = document.createElement("div");
    hfMenuEl.id = "hf-menu";
    hfMenuEl.setAttribute("role", "menu");
    document.body.appendChild(hfMenuEl);
    hfMenuEl.addEventListener("click", (e) => { if (e.target.closest("a")) closeHfMenu(); });
    bindMenuKeys(hfMenuEl, "a");
  }
  const items = [
    { label: t("model.hfMenu.hf"), url: safeHttpUrl(m.hfUrl) },
    { label: t("model.hfMenu.mirror"), url: safeHttpUrl(hfMirrorOf(m.hfUrl)) },
    { label: t("model.hfMenu.gguf"), url: safeHttpUrl(m.ggufUrl) },
    { label: t("model.hfMenu.ggufMirror"), url: safeHttpUrl(hfMirrorOf(m.ggufUrl)) },
  ].filter(x => x.url);
  hfMenuEl.innerHTML = items.map(x => `<a href="${esc(x.url)}" target="_blank" rel="noopener" role="menuitem">${esc(x.label)}<span class="hf-menu-ext" aria-hidden="true">↗</span></a>`).join("");
  closeHfMenu();
  hfMenuAnchor = anchor;
  anchor.classList.add("open");
  hfMenuEl.classList.add("open");
  const r = anchor.getBoundingClientRect();
  const mw = hfMenuEl.offsetWidth, mh = hfMenuEl.offsetHeight;
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  let right = window.innerWidth - r.right;
  if (right + mw > window.innerWidth - 8) right = 8;
  hfMenuEl.style.top = top + "px";
  hfMenuEl.style.right = right + "px";
  const first = hfMenuEl.querySelector("a");
  if (first) first.focus();
}

function toggleHfMenu(anchor, m) {
  if (hfMenuAnchor === anchor) { closeHfMenu(); return; }
  openHfMenu(anchor, m);
}

document.addEventListener("mousedown", (e) => {
  if (hfMenuAnchor && !e.target.closest("#hf-menu") && !e.target.closest(".hf-link")) closeHfMenu();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeHfMenu(); });
document.addEventListener("scroll", closeHfMenu, true);
window.addEventListener("resize", closeHfMenu);

export function renderModelList() {
  closeHfMenu();
  const list = $("model-list");
  list.removeAttribute("aria-busy");
  list.innerHTML = "";
  if (state.models.length === 0) {
    renderEmptyState(list, t("model.empty"), { label: t("common.retry"), onClick: loadModels });
    return;
  }
  for (const cat of CATEGORY_ORDER) {
    const group = state.models.filter(m => m.category === cat);
    if (group.length === 0) continue;
    const title = document.createElement("div");
    title.className = "group-title";
    title.textContent = categoryName(cat);
    list.appendChild(title);
    for (const m of group) {
      const usable = modelConfigured(m);
      const card = document.createElement("div");
      card.className = "card" + (m.id === state.selectedModelId ? " selected" : "") + (usable ? "" : " unconfigured");
      card.innerHTML = `<div class="card-title">${esc(I18N.pick(m, "displayName"))}${usable ? "" : ` <span class="badge unconfigured">${esc(t("model.unconfigured"))}</span>`}<button class="dl-link" title="${esc(t("dl.cardBtn"))}">⬇</button>${m.hfUrl ? `<button class="hf-link" title="${esc(t("model.hfRepo"))}">HF ▾</button>` : ""}</div>
        <div class="card-family">${esc(m.family)} <span class="cat-badge cat-${cat}">${esc(categoryName(cat))}</span></div>
        <div class="card-desc">${esc(I18N.pick(m, "description"))}</div>`;
      if (!usable) card.title = t("model.unconfiguredTip");
      card.querySelector(".dl-link").onclick = (e) => { e.stopPropagation(); openModelDlModal(m); };
      const hfBtn = card.querySelector(".hf-link");
      if (hfBtn) hfBtn.onclick = (e) => { e.stopPropagation(); toggleHfMenu(hfBtn, m); };
      card.onclick = () => {
        // 经路由选择模型：URL 同步为 #/model/<id>，前进/后退可还原
        go(modelRoute(m.id));
      };
      list.appendChild(card);
    }
  }
}

export function updateQuickLaunchTitle() {
  const m = selectedModel();
  $("quick-launch-model").textContent = m ? I18N.pick(m, "displayName") : "";
}
