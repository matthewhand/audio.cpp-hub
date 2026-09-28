/* web/modules/dom.js — 全站基元（依赖图里唯一的叶子）
 *
 * 只放「每个功能模块都要用」的最底层出口：
 *   - $ / el：绑定经典脚本 web/legacy-globals.js 挂在 window 上的实现（模块侧不再有第二份）；
 *   - esc / safeHttpUrl：服务端或用户可控字符串进 HTML / href 之前的统一出口；
 *   - markRowEnter：让列表行只在首次出现时播进入动画（2s 轮询重建时不重播）；
 *   - t：绑定 i18n.js 的 window.I18N.t，各模块统一入口，不各写一份 I18N.t；
 *   - Api：绑定 api-client.js 的 window.AudioCppHub.api（集中 fetch / 错误信封 /
 *     Api.poll 的唯一出口），新增请求一律走它，不要直接 fetch。
 *
 * 刻意**零 import**：所有功能模块都依赖本模块，它一旦再 import 别的模块，
 * 依赖图就会被拉成环（弹窗焦点栈与异步状态两块已经因为互相调用过一次）。
 * UI 原语（弹窗焦点栈 / 列表三态 / toast）都在 async-ui.js，它们单向依赖本模块。
 *
 * $ / el 用 JSDoc 标注返回 any：调用点会立刻访问 .value / .checked / .dataset /
 * .onclick 等「只有具体标签才声明」的成员，逐点加断言等于重写（见 web/README.md 已知降级）。 */

/* 实现只有这一份，在经典脚本 web/legacy-globals.js 里（模块求值前就已在 window 上） */
const $ = window.$;
const el = window.el;
export { $, el };

/* i18n：不复制任何字典逻辑，语言切换 / errText / pick 仍走 I18N 本身 */
export const t = (k, p) => I18N.t(k, p);

/* HTTP：api-client.js（经典脚本）挂在 window 上的对象，这里只绑定一次再导出 */
export const Api = window.AudioCppHub.api;

/* 服务端/用户可控字符串插入 HTML（文本或属性）前统一转义，防存储型 XSS */
export function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
/* 仅放行 http(s) 链接，其余返回空串（用于 href 等 URL 属性） */
export function safeHttpUrl(url) {
  const s = typeof url === "string" ? url.trim() : "";
  return /^https?:\/\//i.test(s) ? s : "";
}

export const enteredRows = new Set();
export function markRowEnter(node, key) {
  if (!enteredRows.has(key)) {
    enteredRows.add(key);
    node.classList.add("row-enter");
  }
  return node;
}
