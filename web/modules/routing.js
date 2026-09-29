/* web/modules/routing.js — hash 路由（#88）
 *
 * 路由表：#/model/<id> #/instance/<id> #/history #/voices #/downloads #/settings
 * 打开/关闭面板与选择模型统一经 go() 改 hash，applyRoute() 是唯一应用视图的地方，
 * 因此浏览器前进/后退可自然还原，深链接刷新后也能恢复面板与选中项。
 *
 * 本模块只持有「路由意图」——待生效的模型 / 实例 / 设置分节（pending*）与路由解析，
 * 不持有任何视图状态。真正开关面板的 closeX/openX 全部从各功能模块 import，因此
 * 这里 ↔ models / instances / settings / sidebar / downloads 之间存在多处循环 import：
 * 这些引用都只出现在**运行期回调**里（hashchange / 面板按钮），没有任何模块在求值期
 * 调用对方，因此 ES 模块的活绑定语义可以安全闭环。
 *
 * goPanel 供页头按钮使用（同一面板再次点击 = 收起）；各 closeX() 里的
 * window.hubPanelClosed 是反向通道：只有当前路由仍指向该面板时才回退，
 * 避免「自动关闭」误导航。 */

import { isOpen } from "./async-ui.js";
import { closeDownloadsModal, openDownloadsModal } from "./downloads.js";
import { closeInstanceDetail, instances, openInstanceDetail } from "./instances.js";
import { selectModelById } from "./models.js";
import { closeSettingsModal, openSettingsModal } from "./settings.js";
import { closeHistoryPanel, openHistoryPanel } from "./sidebar.js";
import { closeStatsPanel, openStatsPanel, wireStatsButton } from "./stats-lazy.js";
import { selectedModelId } from "./state.js";

export const ROUTE_VIEWS = ["history", "voices", "downloads", "stats", "settings"];

let applyingRoute = false; // applyRoute 执行中：关闭函数不得再改 hash（防递归）

/* 路由意图：目标数据尚未加载完成时先记下，等对应模块拿到数据再补齐 */
let pendingModelId = null;
let pendingInstanceId = null;
let pendingSettingsSection = null;

export const getPendingModelId = () => pendingModelId;
export const setPendingModelId = (id) => { pendingModelId = id; };
export const getPendingInstanceId = () => pendingInstanceId;
export const setPendingInstanceId = (id) => { pendingInstanceId = id; };
export const getPendingSettingsSection = () => pendingSettingsSection;
export const setPendingSettingsSection = (s) => { pendingSettingsSection = s; };

export function parseRoute(hash) {
  const s = String(hash || "").replace(/^#\/?/, "");
  const parts = s.split("/").filter(Boolean);
  if (parts[0] === "model" && parts[1]) return { view: "model", id: decodeURIComponent(parts[1]) };
  if (parts[0] === "instance" && parts[1]) return { view: "instance", id: decodeURIComponent(parts[1]) };
  if (ROUTE_VIEWS.includes(parts[0])) return { view: parts[0] };
  return { view: "home" };
}

export function modelRoute(id) {
  const mid = id || selectedModelId;
  return mid ? "#/model/" + encodeURIComponent(mid) : "#/";
}

export function defaultRoute() { return modelRoute(); }

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

// 看板的页头按钮由懒加载外观接线（模块本身要点击后才拉）
wireStatsButton(goPanel);

window.hubNavigate = go;
window.hubTogglePanel = goPanel;
window.hubApplyRoute = applyRoute;

/* 由各 closeX() 调用：仅当当前路由仍指向该面板时才回退（避免自动关闭误导航） */
window.hubPanelClosed = function (view) {
  if (applyingRoute) return;
  if (parseRoute(location.hash).view !== view) return;
  go(defaultRoute());
};

export function applyRoute() {
  if (applyingRoute) return;
  applyingRoute = true;
  try {
    const r = parseRoute(location.hash);
    // 先关闭非目标面板（仅关闭确实打开的，避免误触焦点还原）
    if (r.view !== "history" && isOpen("history-panel")) closeHistoryPanel();
    if (r.view !== "voices" && isOpen("voices-panel") && window.closeVoicesPanel) window.closeVoicesPanel();
    if (r.view !== "downloads" && isOpen("downloads-modal")) closeDownloadsModal();
    if (r.view !== "stats" && isOpen("stats-panel")) closeStatsPanel();
    if (r.view !== "settings" && isOpen("settings-modal")) closeSettingsModal();
    if (r.view !== "instance") {
      pendingInstanceId = null;
      if (isOpen("instance-detail-modal")) closeInstanceDetail();
    }
    // 再打开目标面板
    if (r.view === "history") openHistoryPanel();
    else if (r.view === "voices") { if (window.openVoicesPanel) window.openVoicesPanel(); }
    else if (r.view === "downloads") openDownloadsModal();
    else if (r.view === "stats") openStatsPanel();
    else if (r.view === "settings") {
      openSettingsModal(pendingSettingsSection || "general");
      pendingSettingsSection = null;
    } else if (r.view === "instance") {
      const inst = instances.find(i => i.id === r.id);
      if (inst) { pendingInstanceId = null; openInstanceDetail(inst); }
      else pendingInstanceId = r.id;
    }
    if (r.view === "model") selectModelById(r.id);
  } finally {
    applyingRoute = false;
  }
}

window.addEventListener("hashchange", applyRoute);
