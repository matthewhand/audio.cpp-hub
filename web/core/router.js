/* Hash 路由（#67）：URL 为视图状态来源，localStorage 仅作默认落地。
   路由表：#/model/<id> #/instance/<id> #/history #/voices #/downloads #/settings
   打开/关闭面板与选择模型统一经 go() 改 hash，applyRoute() 是唯一应用视图的地方，
   因此浏览器前进/后退可自然还原，深链接刷新后也能恢复面板与选中项。
   为避免核心层反向 import 特性层造成的求值顺序问题，本模块在运行时才调用各面板函数。 */
import { state } from "./state.js";
import { isOpen } from "./ui.js";
import { selectModelById } from "../features/models.js";
import { openHistoryPanel, closeHistoryPanel } from "../features/history.js";
import { openDownloadsModal, closeDownloadsModal } from "../features/downloads.js";
import { openSettingsModal, closeSettingsModal } from "../features/settings.js";
import { openInstanceDetail, closeInstanceDetail } from "../features/instances.js";

const ROUTE_VIEWS = ["history", "voices", "downloads", "settings"];
let applyingRoute = false;      // applyRoute 执行中：关闭函数不得再改 hash（防递归）

export function parseRoute(hash) {
  const s = String(hash || "").replace(/^#\/?/, "");
  const parts = s.split("/").filter(Boolean);
  if (parts[0] === "model" && parts[1]) return { view: "model", id: decodeURIComponent(parts[1]) };
  if (parts[0] === "instance" && parts[1]) return { view: "instance", id: decodeURIComponent(parts[1]) };
  if (ROUTE_VIEWS.includes(parts[0])) return { view: parts[0] };
  return { view: "home" };
}
export function modelRoute(id) {
  const mid = id || state.selectedModelId;
  return mid ? "#/model/" + encodeURIComponent(mid) : "#/";
}
function defaultRoute() { return modelRoute(); }
/* 改 hash 触发 hashchange → applyRoute；同 hash 时直接重放（用于重试） */
export function go(hash) {
  if (location.hash === hash) { applyRoute(); return; }
  location.hash = hash;
}
/* 页头按钮：同一面板再次点击则收起（回到默认模型路由） */
export function goPanel(route) {
  const target = "#/" + route;
  go(location.hash === target ? defaultRoute() : target);
}
/* 由各 closeX() 调用：仅当当前路由仍指向该面板时才回退（避免自动关闭误导航） */
export function hubPanelClosed(view) {
  if (applyingRoute) return;
  if (parseRoute(location.hash).view !== view) return;
  go(defaultRoute());
}

export function applyRoute() {
  if (applyingRoute) return;
  applyingRoute = true;
  try {
    const r = parseRoute(location.hash);
    // 先关闭非目标面板（仅关闭确实打开的，避免误触焦点还原）
    if (r.view !== "history" && isOpen("history-panel")) closeHistoryPanel();
    if (r.view !== "voices" && isOpen("voices-panel") && window.closeVoicesPanel) window.closeVoicesPanel();
    if (r.view !== "downloads" && isOpen("downloads-modal")) closeDownloadsModal();
    if (r.view !== "settings" && isOpen("settings-modal")) closeSettingsModal();
    if (r.view !== "instance") {
      state.pendingInstanceId = null;
      if (isOpen("instance-detail-modal")) closeInstanceDetail();
    }
    // 再打开目标面板
    if (r.view === "history") openHistoryPanel();
    else if (r.view === "voices") { if (window.openVoicesPanel) window.openVoicesPanel(); }
    else if (r.view === "downloads") openDownloadsModal();
    else if (r.view === "settings") {
      openSettingsModal(state.pendingSettingsSection || "general");
      state.pendingSettingsSection = null;
    } else if (r.view === "instance") {
      const inst = state.instances.find(i => i.id === r.id);
      if (inst) { state.pendingInstanceId = null; openInstanceDetail(inst); }
      else state.pendingInstanceId = r.id;
    }
    if (r.view === "model") selectModelById(r.id);
  } finally {
    applyingRoute = false;
  }
}

window.hubNavigate = go;
window.hubTogglePanel = goPanel;
window.hubApplyRoute = applyRoute;
window.hubPanelClosed = hubPanelClosed;
window.addEventListener("hashchange", applyRoute);
