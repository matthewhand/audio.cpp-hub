/* web/modules/models.js — 模型列表
 *
 * 左栏按 category 分组渲染模型卡片、「已配置」黯淡态、HF 仓库 / 镜像下拉菜单，
 * 以及快速启动按钮上的当前模型名。数据来自 GET /api/models。
 *
 * 选中模型的两条入口（点击卡片 / 路由 #/model/<id>）都落到 selectModelById，
 * URL 由 routing.js 统一改写，这里只落状态并重画。 */

import { bindMenuKeys, renderEmptyState, renderStateError, showSkeleton } from "./async-ui.js";
import { $, Api, esc, safeHttpUrl, t } from "./dom.js";
import { openModelDlModal } from "./downloads-lazy.js";
import { maybeAutoSelectReadyModel, instances, refreshInstances } from "./instances.js";
import { restoreWeightsPath } from "./launch.js";
import { renderWorkspace } from "./panels.js";
import { getPendingModelId, go, modelRoute, parseRoute, setPendingModelId } from "./routing.js";
import { closeDrawer } from "./shell.js";
import { modelConfigured, models, selectedModel, selectedModelId, setModels, setSelectedModelId } from "./state.js";

export const CATEGORY_ORDER = ["tts", "asr", "sep", "music", "other"];
export function categoryName(cat) {
  return t("category." + cat);
}

/* ---------- 模型区折叠（左栏 <details id="model-panel">） ----------
   模型清单按 category 分组展开有几十张卡片，会把上面的「最近活动」面板挤出屏幕，
   所以整区做成可折叠的 <details>：默认有实例时收起、没有实例时展开（那时候
   模型清单正是要找东西的地方），用户手动开合过就按用户记的来。展开 / 收起
   只改显隐，列表的下载 / HF 菜单、选中、骨架屏等行为一概不变。 */
const MODELS_OPEN_KEY = "hub-models-open";

/** 默认开合：有实例就收起。纯函数。 */
export function defaultModelsOpen(instanceCount) {
  return !(Number(instanceCount) > 0);
}

function modelsPanel() { return $("model-panel"); }

function storedModelsOpen() {
  try {
    if (typeof localStorage !== "undefined") return localStorage.getItem(MODELS_OPEN_KEY);
  } catch { /* private mode */ }
  return null;
}

/** 套用开合状态：用户显式开合过（localStorage 有记录）就按记录的来，否则按默认
    值。模型清单与实例列表谁先到都能得到正确结果，重复调用是幂等的。 */
export function applyModelsPanelState(instanceCount) {
  const panel = modelsPanel();
  if (!panel) return null;
  const stored = storedModelsOpen();
  panel.open = stored === null ? defaultModelsOpen(instanceCount) : stored === "1";
  return panel.open === true;
}

/** 建立模型区的开合记忆 + 首次状态。由 app.js 在启动时调用一次。
    实例列表就绪后会再套一次（那时才知道有没有实例），走已有的
    hub-instances-updated 窗口事件，不新增模块间的 import 边。 */
export function startModelsPanel() {
  const panel = modelsPanel();
  if (panel && panel.addEventListener) {
    panel.addEventListener("toggle", () => {
      try {
        if (typeof localStorage !== "undefined") localStorage.setItem(MODELS_OPEN_KEY, panel.open ? "1" : "0");
      } catch { /* private mode */ }
    });
  }
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("hub-instances-updated", () => applyModelsPanelState(instances.length));
  }
  applyModelsPanelState(instances.length);
}

export async function loadModels() {
  showSkeleton($("model-list"), 5);
  try {
    setModels(await Api.list("/api/models"));
  } catch (e) {
    renderStateError($("model-list"), e, loadModels);
    return;
  }
  // 模型清单可能比实例列表先到：先按当前已知实例数定一次开合状态，
  // 实例列表就绪后由 hub-instances-updated 再确认一次
  applyModelsPanelState(instances.length);
  if (models.length && !selectedModelId) {
    // 路由优先（深链接），其次恢复上次选中的模型（localStorage 仅作默认落地）
    const r = parseRoute(location.hash);
    const wanted = getPendingModelId()
      || (r.view === "model" ? r.id : null)
      || localStorage.getItem("hub-model");
    setSelectedModelId(models.some(m => m.id === wanted) ? wanted : models[0].id);
    setPendingModelId(null);
  }
  // 深链接指向不存在的模型：用 replaceState 修正 URL（不新增历史记录、不触发 hashchange）
  const cur = parseRoute(location.hash);
  if (selectedModelId && cur.view === "model" && cur.id !== selectedModelId) {
    history.replaceState(null, "", modelRoute(selectedModelId));
  }
  renderModelList();
  updateQuickLaunchTitle();
  restoreWeightsPath();
  renderWorkspace();
  // Models may arrive after the first instances poll; finish Ready auto-select then.
  maybeAutoSelectReadyModel();
}

export let hfMenuEl = null;
export let hfMenuAnchor = null;

export function hfMirrorOf(url) {
  return url ? url.replace("https://huggingface.co/", "https://hf-mirror.com/") : null;
}

export function closeHfMenu() {
  if (hfMenuEl) hfMenuEl.classList.remove("open");
  if (hfMenuAnchor) hfMenuAnchor.classList.remove("open");
  hfMenuAnchor = null;
}

export function openHfMenu(anchor, m) {
  if (!hfMenuEl) {
    hfMenuEl = document.createElement("div");
    hfMenuEl.id = "hf-menu";
    document.body.appendChild(hfMenuEl);
    hfMenuEl.setAttribute("role", "menu");
    hfMenuEl.addEventListener("click", (e) => { if (e.target.closest("a")) closeHfMenu(); });
    bindMenuKeys(hfMenuEl, "a");
  }
  const items = [
    { label: t("model.hfMenu.hf"), url: safeHttpUrl(m.hfUrl) },
    { label: t("model.hfMenu.mirror"), url: safeHttpUrl(hfMirrorOf(m.hfUrl)) },
    { label: t("model.hfMenu.gguf"), url: safeHttpUrl(m.ggufUrl) },
    { label: t("model.hfMenu.ggufMirror"), url: safeHttpUrl(hfMirrorOf(m.ggufUrl)) }
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

export function toggleHfMenu(anchor, m) {
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
  // 折叠时 summary 上的计数徽标要跟着清单走（不展开也知道有几个模型）
  const count = $("model-count");
  if (count) count.textContent = I18N.num(models.length);
  list.innerHTML = "";
  if (models.length === 0) {
    renderEmptyState(list, t("model.empty"), { label: t("common.retry"), onClick: loadModels });
    return;
  }
  for (const cat of CATEGORY_ORDER) {
    const group = models.filter(m => m.category === cat);
    if (group.length === 0) continue;
    const title = document.createElement("div");
    title.className = "group-title";
    title.textContent = categoryName(cat);
    list.appendChild(title);
    for (const m of group) {
      const usable = modelConfigured(m);
      const card = document.createElement("div");
      card.className = "card" + (m.id === selectedModelId ? " selected" : "") + (usable ? "" : " unconfigured");
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

/* 经路由选择模型（#/model/<id>）。模型清单尚未到达时先把 id 记进路由意图，
   等 loadModels 拿到清单后由它兑现（见 loadModels 里的 getPendingModelId）。 */
export function selectModelById(id) {
  if (!models.length) { setPendingModelId(id); return; }
  const m = models.find(x => x.id === id);
  if (!m || m.id === selectedModelId) return;
  setSelectedModelId(m.id);
  localStorage.setItem("hub-model", m.id);
  renderModelList();
  updateQuickLaunchTitle();
  restoreWeightsPath();
  refreshInstances();
  renderWorkspace();
  closeDrawer();
}

export function updateQuickLaunchTitle() {
  const m = selectedModel();
  $("quick-launch-model").textContent = m ? I18N.pick(m, "displayName") : "";
}
