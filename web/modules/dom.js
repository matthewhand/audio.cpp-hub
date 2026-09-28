/* web/modules/dom.js — DOM 基元
 *
 * $ / el 的唯一实现定义在经典脚本 web/legacy-globals.js（模块求值前就已在 window 上，
 * 供同目录的经典组件脚本共用），这里只做绑定与再导出，避免出现第二份实现。
 * esc / safeHttpUrl 是「服务端或用户可控字符串进 HTML / href 之前」的统一出口；
 * markRowEnter 让列表行只在首次出现时播进入动画（2s 轮询重建时不重播）。
 * renderListError 只是 async-ui.js 的 renderStateError 的旧签名薄封装。
 *
 * $ / el 用 JSDoc 标注返回 any：调用点会立刻访问 .value / .checked / .dataset /
 * .onclick 等「只有具体标签才声明」的成员，逐点加断言等于重写（见 web/README.md 已知降级）。 */

import { renderStateError } from "./async-ui.js";

/* 实现只有这一份，在经典脚本 web/legacy-globals.js 里（模块求值前就已在 window 上） */
const $ = window.$;
const el = window.el;
export { $, el };
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
/* 列表加载失败的可见提示 + 重试按钮（替代空白列表）。
   message 已组装好，因此走 renderStateError 的 raw 分支。 */
export function renderListError(container, message, retry) {
  if (!container) return;
  renderStateError(container, new Error(message), retry, true);
}
