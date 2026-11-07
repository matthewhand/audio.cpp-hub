

import { $, t } from "./dom.js";
import { showToast } from "./async-ui.js";

export const themeBtn = $("theme-toggle");

const THEME_MODES = ["system", "light", "dark"];
const THEME_ICONS = { system: "i-monitor", light: "i-sun", dark: "i-moon" };
export function applyThemeIcon() {
  const mode = window.HubTheme.mode();
  themeBtn.querySelector("use").setAttribute("href", "#" + (THEME_ICONS[mode] || THEME_ICONS.system));
  themeBtn.title = t("settings.general.theme") + "：" + t("settings.theme." + mode);
}
themeBtn.onclick = () => {
  const mode = window.HubTheme.mode();
  const next = THEME_MODES[(THEME_MODES.indexOf(mode) + 1) % THEME_MODES.length];
  window.HubTheme.setMode(next);
  applyThemeIcon();
  window.dispatchEvent(new Event("themechange"));
};
applyThemeIcon();

export const langBtn = $("lang-toggle");
export function applyLangBtn() {
  $("lang-label").textContent = I18N.lang() === "zh" ? "EN" : "中文";
}
langBtn.onclick = () => I18N.setLang(I18N.lang() === "zh" ? "en" : "zh");

const mobile = matchMedia("(max-width:1100px)");
let sidebarHadFocus = false, menuHadFocus = false;
document.addEventListener("focusin", e => {
  sidebarHadFocus = $("left").contains(e.target);
  menuHadFocus = e.target === $("menu-toggle");
});
function drawer(open) {
  const l = $("left"), m = $("menu-toggle");
  open = mobile.matches && open;
  if (!open && mobile.matches && (l.contains(document.activeElement) || sidebarHadFocus)) m.focus();
  l.classList.toggle("open", open);
  l.inert = mobile.matches && !open;
  if (l.inert) l.setAttribute("aria-hidden", "true");
  else l.removeAttribute("aria-hidden");
  $("drawer-overlay").classList.toggle("hidden", !open);
  m.setAttribute("aria-expanded", String(open));
  if (open) { const list = $("model-list"); list.tabIndex = -1; list.focus(); }
  if (!mobile.matches && (document.activeElement === m || menuHadFocus)) {
    (l.querySelector(".model-select-target[aria-current]") || l.querySelector("button") || $("main-content")).focus();
  }
}
export function openDrawer() { drawer(true); }
export function closeDrawer() { drawer(false); }
mobile.addEventListener("change", () => drawer(false));
drawer(false);
// Classic is the zero-additional-module default; load alternate views only on use.
let interfaceLoadFailures = 0;
async function openInterfaceMode(mode) {
  try {
    const loading = interfaceLoadFailures ?
      import(`./interface-modes.js?retry=${interfaceLoadFailures}`) : import("./interface-modes.js");
    const { initInterfaceModes, setInterfaceMode } = await loading;
    initInterfaceModes();
    setInterfaceMode(mode);
  } catch {
    // Keep Classic usable and let the next click retry a failed module fetch.
    interfaceLoadFailures++;
    showToast("error", t("common.loadFailed"));
  }
}
for (const [id, mode] of [["studio-create", "classic"], ["studio-flow", "flow"], ["studio-operate", "cockpit"]]) {
  $(id).onclick = () => void openInterfaceMode(mode);
}
try {
  const saved = localStorage.getItem("hub-interface-mode");
  if (saved === "flow" || saved === "cockpit") void openInterfaceMode(saved);
} catch { /* storage is optional */ }
$("activity-queue-open").onclick = async () => (await import("./activity-queue.js")).toggleActivityQueue();
$("menu-toggle").onclick = openDrawer;
$("drawer-overlay").onclick = closeDrawer;
