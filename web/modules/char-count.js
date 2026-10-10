/* web/modules/char-count.js — 「合成文本」字数与词数
 *
 * Hub 没有最大文本长度常量（task.go 的 preview 上限是结果预览，不是输入），
 * 所以页面上只显示计数。formatCharCount 仍接受正数 max，供「n / max」与单测。
 *
 * 词数优先走 Intl.Segmenter（granularity "word"，只数 isWordLike 的段）：
 * 拉丁文本按空白 / 标点切词，中文一段连续汉字会被切成一个或多个词段，比
 * 「按空白切」更接近人对词数的直觉。运行环境没有 Segmenter（旧内核）或构造
 * 失败时退回按空白切分——中文会退化成「整段一个词」，但不报错、不崩。 */

import { $, t } from "./dom.js";

/** 词数：Intl.Segmenter(word) 的 isWordLike 段数，缺失时按空白切分。纯函数。 */
export function countWords(text) {
  const s = typeof text === "string" ? text : "";
  const Seg = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function" ? Intl.Segmenter : null;
  if (Seg) {
    try {
      let n = 0;
      for (const part of new Seg(undefined, { granularity: "word" }).segment(s)) {
        if (part.isWordLike) n++;
      }
      return n;
    } catch (e) {
      /* 旧内核 / 受限环境：退回空白切分 */
    }
  }
  return s.split(/\s+/).filter(Boolean).length;
}

/** "{n} chars · {m} words", or "{n} / {max} chars · {m} words" for a positive max. */
export function formatCharCount(text, max) {
  const s = typeof text === "string" ? text : "";
  const cap = Number(max);
  const words = t("tts.wordCount", { n: I18N.num(countWords(s)) });
  if (Number.isFinite(cap) && cap > 0) {
    return t("tts.charCountMax", { n: I18N.num(s.length), max: I18N.num(Math.trunc(cap)), words });
  }
  return t("tts.charCount", { n: I18N.num(s.length), words });
}

export function renderCharCount() {
  const el = $("tts-char-count");
  if (!el) return;
  const box = $("tts-text");
  const n = box && typeof box.value === "string" ? box.value : "";
  el.textContent = formatCharCount(n);
}

export function startCharCount() {
  const box = $("tts-text");
  if (box && box.addEventListener) box.addEventListener("input", renderCharCount);
  renderCharCount();
}
