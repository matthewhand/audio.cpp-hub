/* Three interface modes; same DOM, state, routes and API. No mode-specific polling. */
import { $ } from "./dom.js";
import { instanceFeedState, instances } from "./instances.js";
import { modelConfigured, models, selectedModel } from "./state.js";

const FLOW_TRANSLATIONS = {
  "en": {
    "flow.kicker": "FLOW STUDIO",
    "flow.heading": "What would you like to do?",
    "flow.intro": "Choose a local audio task. Your model, editor and results are shared with Classic.",
    "flow.actionsLabel": "Audio tasks",
    "flow.tts": "Synthesize speech",
    "flow.ttsHelp": "Open a local TTS model",
    "flow.asr": "Transcribe audio",
    "flow.asrHelp": "Open a local ASR model",
    "flow.voices": "Voice library",
    "flow.voicesHelp": "Browse saved voices",
    "flow.models": "Browse models",
    "flow.modelsHelp": "Find and prepare a model",
    "flow.unavailable": "No locally available model in this category",
    "flow.unconfigured": "No ready or configured local model in this category. Browse models to prepare one.",
    "flow.selected": "Selected model: {model}",
    "flow.noModels": "Model catalog has not loaded. Try again shortly.",
    "cockpit.loadError": "Cockpit could not load. Your editor and tasks are unchanged.",
    "cockpit.retry": "Retry Cockpit"
  },
  "zh": {
    "flow.kicker": "流程工作室",
    "flow.heading": "您想完成什么任务？",
    "flow.intro": "选择本地音频任务。模型、编辑器和结果与经典模式共享。",
    "flow.actionsLabel": "音频任务",
    "flow.tts": "语音合成",
    "flow.ttsHelp": "打开本地语音合成模型",
    "flow.asr": "音频转写",
    "flow.asrHelp": "打开本地语音识别模型",
    "flow.voices": "音色库",
    "flow.voicesHelp": "浏览保存的音色",
    "flow.models": "浏览模型",
    "flow.modelsHelp": "查找并准备模型",
    "flow.unavailable": "当前分类没有可用的本地模型",
    "flow.unconfigured": "此分类没有就绪或已配置的本地模型。请浏览模型并完成配置。",
    "flow.selected": "已选择模型：{model}",
    "flow.noModels": "模型目录尚未加载，请稍后重试。",
    "cockpit.loadError": "驾驶舱加载失败。编辑器和任务未受影响。",
    "cockpit.retry": "重试驾驶舱"
  }
};
function flowT(key, params = {}) {
  const value = FLOW_TRANSLATIONS[I18N.lang()]?.[key] || key;
  return value.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ""));
}
function relocalizeFlow() {
  for (const el of document.querySelectorAll("[data-flow-i18n]")) {
    el.textContent = flowT(el.dataset.flowI18n);
  }
  for (const el of document.querySelectorAll("[data-flow-i18n-aria-label]")) {
    el.setAttribute("aria-label", flowT(el.dataset.flowI18nAriaLabel));
  }
}

export const INTERFACE_MODES = Object.freeze(["classic", "flow", "cockpit"]);
const STORAGE_KEY = "hub-interface-mode";
let current = "classic";
let initialized = false;
let operatorRequest = 0;
let operatorRetryIndex = 0;
let flowDrawerReturnFocus = null;

function showOperatorLoadFailure() {
  const pane = $("operator-workspace");
  let notice = $("operator-load-error");
  if (!notice) {
    notice = document.createElement("div");
    notice.id = "operator-load-error";
    notice.className = "card";
    notice.setAttribute("role", "alert");
    const message = document.createElement("p");
    message.dataset.flowI18n = "cockpit.loadError";
    const retry = document.createElement("button");
    retry.id = "operator-retry";
    retry.type = "button";
    retry.className = "btn-ghost";
    retry.dataset.flowI18n = "cockpit.retry";
    retry.addEventListener("click", () => loadOperatorStudio(true));
    notice.append(message, retry);
    pane.querySelector(".operator-metrics").before(notice);
  }
  $("operator-retry").disabled = false;
  pane.querySelectorAll(".operator-metrics, .operator-content, .operator-routing")
    .forEach(el => el.classList.add("hidden"));
  relocalizeFlow();
}

function loadOperatorStudio(retry = false) {
  const request = ++operatorRequest;
  if ($("operator-retry")) $("operator-retry").disabled = true;
  // A distinct URL retries a browser-cached failed dynamic import.
  const loading = retry ? import(`./operator-studio.js?retry=${++operatorRetryIndex}`) :
    import("./operator-studio.js");
  void loading.then(({ activateOperatorStudio }) => {
    if (request !== operatorRequest || current !== "cockpit") return;
    $("operator-load-error")?.remove();
    $("operator-workspace").querySelectorAll(".operator-metrics, .operator-content, .operator-routing")
      .forEach(el => el.classList.remove("hidden"));
    activateOperatorStudio();
  }).catch(() => {
    if (request === operatorRequest && current === "cockpit") showOperatorLoadFailure();
  });
}

export function interfaceMode() { return current; }

export function setInterfaceMode(mode, { persist = true } = {}) {
  if (!INTERFACE_MODES.includes(mode)) return false;
  if (!document.getElementById("interface-mode-styles")) {
    const stylesheet = document.createElement("link");
    stylesheet.id = "interface-mode-styles";
    stylesheet.rel = "stylesheet";
    stylesheet.href = "/interface-modes.css";
    document.head.append(stylesheet);
  }
  current = mode;
  const workspace = $("workspace");
  workspace.dataset.interfaceMode = mode;
  for (const [id, choice] of [["studio-create", "classic"], ["studio-flow", "flow"], ["studio-operate", "cockpit"]]) {
    $(id).setAttribute("aria-pressed", String(mode === choice));
  }

  // The existing composer and all task modules stay mounted. Never reset form
  // values, selected model, active instance, results or polling when switching.
  for (const child of workspace.children) {
    if (["studio-mode-switch", "activity-queue-panel"].includes(child.id)) continue;
    const visible = child.id === "operator-workspace" ? mode === "cockpit" :
      child.id === "flow-workspace" ? mode === "flow" : mode !== "cockpit";
    child.inert = !visible;
  }
  $("flow-workspace").classList.toggle("hidden", mode !== "flow");
  $("operator-workspace").classList.toggle("hidden", mode !== "cockpit");

  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* private mode */ }
  }
  if (mode === "cockpit") loadOperatorStudio();
  else operatorRequest++;
  return true;
}

function chooseCategory(category) {
  if (!models.length) {
    $("flow-feedback").textContent = flowT("flow.noModels");
    return;
  }
  const candidates = models.filter(model => model.category === category);
  if (!candidates.length) {
    $("flow-feedback").textContent = flowT("flow.unavailable");
    return;
  }
  const feed = instanceFeedState();
  const usable = model => modelConfigured(model) ||
    (feed.loaded && !feed.stale &&
      instances.some(inst => inst.modelId === model.id && inst.status === "READY"));
  const selected = selectedModel();
  const target = selected?.category === category && usable(selected) ? selected :
    candidates.find(usable);
  if (!target) {
    $("flow-feedback").textContent = flowT("flow.unconfigured");
    return;
  }
  $("flow-feedback").textContent = flowT("flow.selected", { model: I18N.pick(target, "displayName") });
  // Preserve the existing route as the sole model-selection writer. Focus
  // only after its change has rendered, and never steal focus on a newer route.
  const route = "#/model/" + encodeURIComponent(target.id);
  const focusEditor = () => requestAnimationFrame(() => {
    if (current !== "flow" || location.hash !== route || selectedModel()?.id !== target.id) return;
    const editor = $("panel-" + category);
    if (!editor || editor.classList.contains("hidden") || editor.inert) return;
    const heading = document.getElementById(category + "-title");
    if (!heading) return;
    heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: true });
    editor.scrollIntoView({ block: "start", behavior: "instant" });
  });
  const routeChanged = location.hash !== route;
  if (routeChanged) window.addEventListener("hashchange", focusEditor, { once: true });
  window.hubNavigate(route);
  if (!routeChanged) focusEditor();
}

function browseModels() {
  const list = $("model-list");
  // The mobile drawer must receive focus, then restore it when closed.
  if (getComputedStyle($("menu-toggle")).display !== "none") {
    flowDrawerReturnFocus = document.activeElement;
    if (!$("left").classList.contains("open")) $("menu-toggle").click();
    list.setAttribute("tabindex", "-1");
    list.focus({ preventScroll: true });
  }
  list.scrollIntoView({ block: "start", behavior: "instant" });
}

export function initInterfaceModes() {
  if (initialized) return;
  initialized = true;
  $("flow-tts").addEventListener("click", () => chooseCategory("tts"));
  $("flow-asr").addEventListener("click", () => chooseCategory("asr"));
  $("flow-voices").addEventListener("click", () => $("voices-btn").click());
  $("flow-models").addEventListener("click", browseModels);
  new MutationObserver(() => {
    if (!flowDrawerReturnFocus || $("left").classList.contains("open")) return;
    const origin = flowDrawerReturnFocus;
    flowDrawerReturnFocus = null;
    if (origin.isConnected && !origin.closest("[inert]")) origin.focus({ preventScroll: true });
  }).observe($("left"), { attributes: true, attributeFilter: ["class"] });
  // Keep keyboard traversal in the Flow-opened drawer, not behind its backdrop.
  $("left").addEventListener("keydown", e => {
    if (e.key !== "Tab" || !flowDrawerReturnFocus || !$("left").classList.contains("open")) return;
    const controls = [...$("left").querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]')]
      .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden");
    if (!controls.length) return;
    const first = controls[0], last = controls[controls.length - 1];
    const outsideControls = !controls.includes(document.activeElement);
    if (e.shiftKey && (document.activeElement === first || outsideControls)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || outsideControls)) {
      e.preventDefault();
      first.focus();
    }
  });
  I18N.onChange(() => {
    relocalizeFlow();
    $("flow-feedback").textContent = "";
  });
  relocalizeFlow();
}
