/* Keep the history dialog shell available before its content module loads. */
import { focusDialog, isOpen, renderStateError, restoreDialogFocus, showSkeleton } from "./async-ui.js";
import { $ } from "./dom.js";

let historyModule = null;
let loading = null;
let panelRevision = 0;

function ensureHistory() {
  if (!loading) {
    loading = import("./sidebar.js").then(
      module => (historyModule = module),
      error => {
        loading = null;
        throw error;
      }
    );
  }
  return loading;
}

async function refreshHistoryPanel() {
  const revision = panelRevision;
  const list = $("history-list");
  if (!historyModule) showSkeleton(list, 3);
  try {
    const module = await ensureHistory();
    if (revision === panelRevision && isOpen("history-panel")) await module.loadHistory();
  } catch (error) {
    if (revision === panelRevision && isOpen("history-panel")) {
      renderStateError(list, error, refreshHistoryPanel);
    }
  }
}

export function openHistoryPanel() {
  if (isOpen("history-panel")) return;
  const panel = $("history-panel");
  panel.classList.remove("hidden");
  focusDialog(panel);
  return refreshHistoryPanel();
}

export function closeHistoryPanel() {
  panelRevision++;
  $("history-panel").classList.add("hidden");
  restoreDialogFocus();
  window.hubPanelClosed("history");
}

export function wireHistoryButton(goPanel) {
  $("history-btn").onclick = () => goPanel("history");
}

$("history-close").onclick = closeHistoryPanel;
$("history-panel").addEventListener("mousedown", (event) => {
  if (event.target === event.currentTarget) closeHistoryPanel();
});

export function loadHistory() {
  return historyModule?.loadHistory();
}

export function renderSidebarList() {
  historyModule?.renderSidebarList();
}

export function privacyOn() {
  return localStorage.getItem("hub-privacy") === "1";
}

export function rememberHistoryRowText(node, text) {
  historyModule?.rememberHistoryRowText(node, text);
}

export function historyRefPath(model, record, name) {
  return record.refs && record.refs[name]
    ? "data/history/" + model.id + "/" + record.taskId + "." + name + ".wav"
    : null;
}
