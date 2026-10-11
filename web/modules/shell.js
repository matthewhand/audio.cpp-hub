

import { $, t } from "./dom.js";

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

export function openDrawer() {
  $("left").classList.add("open");
  $("drawer-overlay").classList.remove("hidden");
  $("menu-toggle").setAttribute("aria-expanded", "true");
}
export function closeDrawer() {
  $("left").classList.remove("open");
  $("drawer-overlay").classList.add("hidden");
  $("menu-toggle").setAttribute("aria-expanded", "false");
}
$("menu-toggle").onclick = openDrawer;
$("drawer-overlay").onclick = closeDrawer;
