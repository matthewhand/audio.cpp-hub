/* web/modules/char-count.js — character and word count for the TTS text (#177).
   Words use Intl.Segmenter (word granularity, isWordLike) and fall back to
   whitespace splitting. No max length is enforced by the hub, so only counts show. */

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
      /* old engines: fall back to whitespace */
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
