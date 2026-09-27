/* audio.cpp-hub 前端入口（ES module）：装配各特性模块、注册全局轮询与初始化。
   拆分说明见 web/core/*、web/features/*；i18n.js / wav.js / file-browser.js /
   audio-picker.js / voice-select.js 仍为经典脚本（提供 window.I18N/WavUtil/... 全局），
   voices-panel.js 亦为经典脚本，由本模块通过 window.closeVoicesPanel 桥接关闭。 */
import { $ } from "./core/dom.js";
import { I18N } from "./core/i18n.js";
import { state, selectedModel } from "./core/state.js";
import { registerOverlay, refreshEvents } from "./core/ui.js";
import { applyLangBtn, applyThemeIcon, syncGeneralPane, rerenderCertStatusIfLoaded } from "./features/settings.js";
import { loadModels, renderModelList, updateQuickLaunchTitle } from "./features/models.js";
import { loadExecutables, renderExecList, updateLaunchExec, renderLaunchProfiles, loadProfiles } from "./features/executables.js";
import { refreshInstances, renderInstanceList, updateInstanceBar } from "./features/instances.js";
import { refreshDownloads, renderDownloadList, renderMdlPackages } from "./features/downloads.js";
import { buildEmotionSliders } from "./features/tts.js";
import { renderWorkspace } from "./features/workspace.js";
import { applyRoute } from "./core/router.js";
import "./features/palette.js";

/* 音色库面板（经典脚本）关闭函数桥接到统一遮罩注册表 */
registerOverlay("voices-panel", () => { if (window.closeVoicesPanel) window.closeVoicesPanel(); });

/* 参考音频选择器（VoiceSelect）：音色库直选，选中即生效；输入音频仍用完整 AudioPicker。
   主音色选中后自动把音色的文本内容回填到参考文本框（用户可再改） */
state.voicePicker = new window.VoiceSelect($("voice-picker"), "picker.speakerRef", {
  onChange: (v) => { const rt = $("tts-reference-text"); if (v && v.text && rt) rt.value = v.text; }
});
state.emotionPicker = new window.VoiceSelect($("emotion-picker"), "picker.emotionRef");
state.asrAudioPicker = new window.AudioPicker($("asr-audio-picker"), "picker.inputRequired");
state.sepAudioPicker = new window.AudioPicker($("sep-audio-picker"), "picker.inputRequired");
state.otherAudioPicker = new window.AudioPicker($("other-audio-picker"), "picker.input");
state.otherVoicePicker = new window.VoiceSelect($("other-voice-picker"), "picker.voiceRef");

function rerenderAll() {
  applyLangBtn();
  applyThemeIcon();
  if (state.models.length) { renderModelList(); updateQuickLaunchTitle(); }
  renderExecList(); updateLaunchExec(); renderLaunchProfiles();
  renderInstanceList(); updateInstanceBar();
  buildEmotionSliders();
  if (selectedModel()) renderWorkspace();
  if (!$("settings-modal").classList.contains("hidden")) {
    syncGeneralPane();
    rerenderCertStatusIfLoaded();
  }
  if (!$("downloads-modal").classList.contains("hidden")) renderDownloadList();
  if (!$("model-dl-modal").classList.contains("hidden") && state.mdlPackages) renderMdlPackages();
  (window.__audioPickers || []).forEach(p => p.refreshLabels && p.refreshLabels());
  (window.__voiceSelects || []).forEach(v => v.refreshLabels && v.refreshLabels());
  if (window.FileBrowser && FileBrowser.relocalize) FileBrowser.relocalize();
}

I18N.onChange(rerenderAll);
I18N.applyI18n();
applyLangBtn();
applyThemeIcon();
buildEmotionSliders();
loadModels();
loadExecutables();
loadProfiles();
refreshInstances();
refreshEvents();
refreshDownloads();
// 应用初始 hash（深链接还原面板 / 选中项）；模型未加载时由 loadModels 补齐
applyRoute();

/* 全局轮询：标签页隐藏时停止，重新可见时立即刷新并恢复，省电省流量 */
let pollTimer = null;
function runPoll() {
  refreshInstances();
  refreshEvents();
  refreshDownloads();
}
function startPolling() {
  if (!pollTimer) pollTimer = setInterval(runPoll, 2000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
startPolling();
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { stopPolling(); return; }
  runPoll();
  startPolling();
});
