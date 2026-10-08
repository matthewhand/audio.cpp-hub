/* web/modules/shell.js — 界面外壳
 *
 * 主题切换（页头 ☀️/🌙，三态 system/light/dark，解析逻辑在 <head> 的 web/boot.js）、
 * 语言切换（页头 EN/中文）、移动端抽屉菜单。
 * 三者都只改 window.HubTheme / localStorage 并刷新自己的按钮，
 * 真正的「重画全站」由 web/app.js 的 rerenderAll 统一触发。 */

import { $, t } from "./dom.js";

export const themeBtn = $("theme-toggle");
/* 页头按钮在「跟随系统 / 浅色 / 深色」之间循环；图标与 title 都取自当前模式（#87）。
   图标是 index.html 头部 Lucide 雪碧图的 <use> 引用：按模式切换 href，
   不再写 textContent（按钮里已没有文字节点） */
const THEME_MODES = ["system", "light", "dark"];
const THEME_ICON_IDS = { system: "i-monitor", light: "i-sun", dark: "i-moon" };
export function applyThemeIcon() {
  const mode = window.HubTheme.mode();
  const use = themeBtn.querySelector("use");
  if (use) use.setAttribute("href", "#" + (THEME_ICON_IDS[mode] || THEME_ICON_IDS.system));
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
/* 语言按钮 = Lucide languages 图标 + #lang-label 短文字（EN / 中文）：
   只改 label 的文字，不动按钮里的 <svg> */
export function applyLangBtn() {
  const label = $("lang-label");
  const text = I18N.lang() === "zh" ? "EN" : "中文";
  if (label) label.textContent = text;
  else langBtn.textContent = text; // 兜底：旧标记里没有 #lang-label
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
