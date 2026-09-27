/* 展示层格式化：状态/分类文案、提交按钮标签、字节数、任务耗时等。 */
import { I18N, t } from "./i18n.js";

export const STATUS_CLASS = {
  STARTING: "starting",
  READY: "ready",
  ERROR: "error",
  STOPPED: "stopped",
};

export function statusText(s) {
  const v = t("instance.status." + s);
  return v === "instance.status." + s ? s : v;
}

export const CATEGORY_ORDER = ["tts", "asr", "sep", "music", "other"];

export function categoryName(cat) {
  return t("category." + cat);
}

export const SUBMIT_BTNS = [
  "tts-submit",
  "asr-submit",
  "sep-submit",
  "music-submit",
  "other-submit",
];
export const SUBMIT_KEYS = {
  "tts-submit": "tts.submit",
  "asr-submit": "asr.submit",
  "sep-submit": "sep.submit",
  "music-submit": "music.submit",
  "other-submit": "other.submit",
};

export function submitLabel(id) {
  return t(SUBMIT_KEYS[id]);
}

/** 字节数 → 可读字符串（下载进度用，随语言本地化）。 */
export function fmtBytes(n) {
  if (n == null || n < 0) return "?";
  return I18N.bytes(n);
}

/** 任务耗时：优先用后端 startedAt→finishedAt，进行中算到当前时刻。 */
export function taskElapsed(task) {
  const end = task.finishedAt || Date.now();
  return ((end - (task.startedAt || task.createdAt)) / 1000).toFixed(1) + "s";
}

/** qwen3_tts 变体由模型条目决定（拆分后三个独立模型：base/customvoice/voicedesign）。 */
export function qwen3VariantOf(modelId) {
  if (modelId === "qwen3_tts_customvoice") return "custom_voice";
  if (modelId === "qwen3_tts_voicedesign") return "voice_design";
  return "base";
}
