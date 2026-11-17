/* audio.cpp-hub application bootstrap: native module assembly, rerendering, dialog focus,
   visibility-aware polling and initial route restoration. See web/README.md for the
   ordering constraints and the preload/service-worker module graph invariants. */

import { FOCUSABLE_SEL, focusDialog, parseApiError, renderEmptyState, renderStateError, restoreDialogFocus, showToast, startEventsPolling, topmostOverlay } from "./modules/async-ui.js";
import { closeCommandPalette } from "./modules/command-palette-lazy.js";
import { $ } from "./modules/dom.js";
import { closeDownloadsModal, closeModelDlModal, relocalizeDownloads, startDownloadsPolling } from "./modules/downloads-lazy.js";
import { cancelFileBrowser, relocalizeFileBrowser } from "./modules/file-browser-lazy.js";
import { closeInstanceDetail, renderInstanceList, startInstancePolling, updateInstanceBar } from "./modules/instances.js";
import { closeLaunchModal, loadProfiles, renderLaunchProfiles } from "./modules/launch.js";
import { loadModels, renderModelList, updateQuickLaunchTitle } from "./modules/models.js";
import { buildEmotionSliders, renderWorkspace } from "./modules/panels.js";
import { applyRoute } from "./modules/routing.js";
import { closeSettingsModal, loadExecutables, relocalizeSettings, updateLaunchExec } from "./modules/settings-lazy.js";
import { applyLangBtn, applyThemeIcon, closeDrawer } from "./modules/shell.js";
import { closeHistoryPanel } from "./modules/sidebar.js";
import { closeRequestsPanel, reloadRequests } from "./modules/requests-lazy.js";
import { closeStatsPanel, reloadStats } from "./modules/stats-lazy.js";
import { models, selectedModel } from "./modules/state.js";
import { closeVoicesPanel } from "./modules/voices-panel-lazy.js";

/* 回填经典脚本侧的转发器：audio-picker.js 的 toast 与 $ / el 在模块求值前就已从
   window 拿到（桥见 web/legacy-globals.js），#88 的三态原语 window.parseApiError /
   renderStateError / renderEmptyState 同理；真实实现在 async-ui.js。 */
Object.assign(window.AudioCppHubApp, {
  showToast, focusDialog, restoreDialogFocus, parseApiError, renderStateError, renderEmptyState
});

/* 语言切换后重画全站：静态文案由 I18N.applyI18n 批量替换，动态区域逐个重渲染。
   各模块的 showXxx 只在对应弹窗可见时才调用，避免无谓重建。
   下载 / 设置 / 音色库三块是懒加载的，交给各自外观层转发（chunk 未加载即空转）。 */
function rerenderAll() {
  applyLangBtn();
  applyThemeIcon();
  if (models.length) { renderModelList(); updateQuickLaunchTitle(); }
  updateLaunchExec(); renderLaunchProfiles();
  updateInstanceBar(); renderInstanceList();
  buildEmotionSliders();
  if (selectedModel()) renderWorkspace();
  relocalizeSettings();
  relocalizeDownloads();
  if (!$("stats-panel").classList.contains("hidden")) reloadStats();
  if (!$("requests-panel").classList.contains("hidden")) reloadRequests();
  (window.__audioPickers || []).forEach(p => p.refreshLabels && p.refreshLabels());
  (window.__voiceSelects || []).forEach(v => v.refreshLabels && v.refreshLabels());
  relocalizeFileBrowser();
}

function closeTopmostOverlay() {
  const overlay = topmostOverlay();
  if (!overlay) return;
  if (overlay.id === "history-panel") closeHistoryPanel();
  else if (overlay.id === "voices-panel") closeVoicesPanel();
  else if (overlay.id === "settings-modal") closeSettingsModal();
  else if (overlay.id === "launch-modal") closeLaunchModal();
  else if (overlay.id === "downloads-modal") closeDownloadsModal();
  else if (overlay.id === "stats-panel") closeStatsPanel();
  else if (overlay.id === "requests-panel") closeRequestsPanel();
  else if (overlay.id === "model-dl-modal") closeModelDlModal();
  else if (overlay.id === "instance-detail-modal") closeInstanceDetail();
  else if (overlay.id === "command-palette") closeCommandPalette();
  else if (overlay.id === "fb-overlay") cancelFileBrowser();
  else if (overlay.id === "busy-overlay") { return; } // 忙碌遮罩不允许 Esc 关闭
  else { overlay.classList.add("hidden"); restoreDialogFocus(); }
}

/* Tab 焦点锁定在当前最上层弹窗内，防止键盘用户 Tab 到遮罩后的页面 */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const overlay = topmostOverlay();
  if (!overlay) return;
  const items = [...overlay.querySelectorAll(FOCUSABLE_SEL)].filter(el => el.offsetParent !== null);
  if (!items.length) { e.preventDefault(); return; }
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

/* Esc：只关最上层弹窗；焦点在可编辑字段时不关闭，避免误丢表单输入 */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const overlay = topmostOverlay();
  if (!overlay) { closeDrawer(); return; }
  const ae = document.activeElement;
  if (ae && overlay.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
  closeTopmostOverlay();
});

I18N.onChange(rerenderAll);
I18N.applyI18n();
applyLangBtn();
buildEmotionSliders();

/* 全局轮询（2s）：实例 / 事件 / 下载三条独立轮询，由 Api.poll 托管（list:true 带数组守卫）。
   Api.poll 保证：上一轮结束才排下一轮（不叠加请求）、标签页隐藏时不发请求、
   重新可见立即补一次；实例与下载的句柄由各自模块持有（refresh 时复用）。 */
startInstancePolling();
startEventsPolling();
startDownloadsPolling();

loadModels();
loadExecutables();
loadProfiles();

// 应用初始 hash（深链接还原面板 / 选中项）；模型未加载时由 loadModels 补齐
applyRoute();
