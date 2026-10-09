/* web/modules/char-count.js — 「合成文本」字数
 *
 * Hub 没有最大文本长度常量（task.go 的 preview 上限是结果预览，不是输入），
 * 所以页面上只显示字数。formatCharCount 仍接受正数 max，供「n / max」与单测。 */

import { $, t } from "./dom.js";

/** "{n} chars", or "{n} / {max}" when max is a positive number. */
export function formatCharCount(n, max) {
  const count = Math.max(0, Math.trunc(Number(n) || 0));
  const cap = Number(max);
  if (Number.isFinite(cap) && cap > 0) return t("tts.charCountMax", { n: count, max: Math.trunc(cap) });
  return t("tts.charCount", { n: count });
}

export function renderCharCount() {
  const el = $("tts-char-count");
  if (!el) return;
  const box = $("tts-text");
  const n = box && typeof box.value === "string" ? box.value.length : 0;
  el.textContent = formatCharCount(n);
}

export function startCharCount() {
  const box = $("tts-text");
  if (box && box.addEventListener) box.addEventListener("input", renderCharCount);
  renderCharCount();
}
