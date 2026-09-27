/* DOM 小工具：元素查询 / 模板构造 / HTML 转义 / URL 白名单 / 列表错误占位。 */
import { t } from "./i18n.js";

export const $ = (id) => document.getElementById(id);

export const el = (html) => {
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  return tpl.content.firstChild;
};

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

/* 只给「首次出现」的列表行加进入动画：记录已展示过的行键，
   2s 轮询重建/复用行时不再重播，避免整列表反复闪动 */
const enteredRows = new Set();
export function markRowEnter(node, key) {
  if (!enteredRows.has(key)) {
    enteredRows.add(key);
    node.classList.add("row-enter");
  }
  return node;
}

/* 列表加载失败的可见提示 + 重试按钮（替代空白列表） */
export function renderListError(container, message, retry) {
  if (!container) return;
  container.innerHTML = "";
  const box = el(`<div class="hint load-error"><span></span><button type="button" class="btn-ghost"></button></div>`);
  box.querySelector("span").textContent = message;
  const btn = box.querySelector("button");
  btn.textContent = t("common.retry");
  btn.onclick = retry;
  container.appendChild(box);
}
