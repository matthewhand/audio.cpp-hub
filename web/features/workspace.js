/* 工作区：按当前模型 category 切换面板，并在重渲染后刷新侧栏 / 重挂进行中任务。 */
import { $ } from "../core/dom.js";
import { selectedModel } from "../core/state.js";
import { renderTtsPanel } from "./tts.js";
import { renderAsrPanel, renderSepPanel, renderMusicPanel, renderOtherPanel } from "./panels.js";
import { loadHistory } from "./history.js";
import { reattachTasks } from "./tasks.js";

export function renderWorkspace() {
  const m = selectedModel();
  if (!m) return;
  for (const cat of ["tts", "asr", "sep", "music", "other"]) {
    $("panel-" + cat).classList.toggle("hidden", cat !== m.category);
  }
  if (m.category === "tts") renderTtsPanel(m);
  else if (m.category === "asr") renderAsrPanel(m);
  else if (m.category === "sep") renderSepPanel(m);
  else if (m.category === "music") renderMusicPanel(m);
  else renderOtherPanel(m);
  // 面板重渲染后刷新侧栏并重挂该模型的进行中任务（恢复进度显示）
  loadHistory();
  reattachTasks();
}
