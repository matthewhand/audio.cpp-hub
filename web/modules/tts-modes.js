/* web/modules/tts-modes.js — TTS 分段控件的纯逻辑（概念稿 .seg）
 *
 * 「声音设计 / 克隆 / 音色库」这三颗分段是**视图**：它们只操作面板上真实存在的
 * 「合成模式」下拉（#tts-mode-row 里的 <select>）与音色选择器（#voice-picker），
 * 不新建请求字段、不改变任何请求体的拼法。本模块因此是纯函数——不认识 DOM，
 * 单测直接调用，渲染路径由 panels.js 的 renderTtsSegments 负责。
 *
 * 三个入口（签名即契约）：
 *   segmentsFor(modeOptions, caps)      当前模型**真实支持**的分段（见下方映射）
 *   activeSegment(currentModeValue, caps)  当前下拉值对应哪颗分段（高亮）
 *   targetFor(segmentId, modeOptions)   点这颗分段要选中的**真实选项值**
 *
 * 映射规则（按选项 value + label 的小写子串匹配，中文同规则）：
 *   design  选项提到 design | instruct | prompt | 描述 | 设计
 *   clone   选项提到 clone | reference | ref | 克隆 | 参考（需要参考音频的那个模式）
 *   library 选项提到 library | voice | preset | 音色库 | 预设；若没有这种模式，
 *           而模型带音色选择器（caps.hasVoicePicker），该分段解析为
 *           modeValue = null——点击只聚焦 / 滚动到音色选择器，不改模式。
 *
 * 两个刻意的设计：
 *   1) **认领制**：design → clone → library 依次匹配，一个选项只会被一颗分段认领。
 *      library 的词最宽（裸 "voice"），放在最后，否则 BreezeTTS 的 voice_design /
 *      voice_clone 会被它抢先，两颗分段指向同一个模式。
 *   2) **少于两颗分段就没有控件**：调用方（panels.js）在 segments.length < 2 时
 *      整块隐藏——只有一种模式可切时，分段控件不提供任何信息。
 * 输入一律防御：modeOptions 不是数组、选项没有 value / label、值不是字符串，
 * 都当作「这颗分段不解析」，绝不抛异常。 */

/** 三颗分段的稳定 id（渲染与单测都用它，不用显示文案）。 */
export const SEGMENT_IDS = ["design", "clone", "library"];

/** 分段 id → 词典 key（显示文案 / 无障碍名）。 */
export const SEGMENT_LABEL_KEYS = {
  design: "tts.seg.design",
  clone: "tts.seg.clone",
  library: "tts.seg.library"
};

/* 匹配顺序即认领优先级：design 最具体，library 最宽（见文件头 2）。 */
/** @type {Array<[string, RegExp]>} */
const MATCHERS = [
  ["design", /design|instruct|prompt|描述|设计/i],
  ["clone", /clone|reference|ref|克隆|参考/i],
  ["library", /library|voice|preset|音色库|预设/i]
];

/** 选项文本 = value + label（任一命中即算）。缺失 / 非字符串一律按 "" 处理。 */
function optionText(opt) {
  if (!opt || typeof opt !== "object") return "";
  return String(opt.value == null ? "" : opt.value) + " " + String(opt.label == null ? "" : opt.label);
}

/** 规范化下拉选项：只留可用的 {value,label}，value 一律转成字符串。 */
function normalizeOptions(modeOptions) {
  if (!Array.isArray(modeOptions)) return [];
  const out = [];
  for (const opt of modeOptions) {
    if (!opt || typeof opt !== "object") continue;
    const value = String(opt.value == null ? "" : opt.value);
    if (!value) continue; // 没有 value 的选项没法被 select 选中
    out.push({ value, label: String(opt.label == null ? "" : opt.label) });
  }
  return out;
}

/**
 * 当前模型真实支持的分段。
 *
 * @param {Array<{value:string,label?:string}>} modeOptions 「合成模式」下拉的真实选项
 * @param {{hasVoicePicker?:boolean}} [caps] 模型能力；只有 library 会读
 *        hasVoicePicker（没有 library 模式但带音色选择器时，library 分段解析为
 *        null——点击只聚焦选择器）。
 * @returns {Array<{id:string, modeValue:string|null}>} 按 design → clone → library 排序；
 *          modeValue 为 null 表示这颗分段不改模式（音色库快捷键）。
 */
export function segmentsFor(modeOptions, caps) {
  const options = normalizeOptions(modeOptions);
  const claimed = new Set();
  const out = [];
  for (const [id, re] of MATCHERS) {
    const hit = options.find((o) => !claimed.has(o.value) && re.test(optionText(o)));
    if (hit) {
      claimed.add(hit.value);
      out.push({ id, modeValue: hit.value });
    } else if (id === "library" && caps && caps.hasVoicePicker) {
      out.push({ id, modeValue: null });
    }
  }
  return out;
}

/**
 * 当前下拉值落在哪颗分段上（高亮）。没有下拉、值不在任何分段里、或当前是
 * library 快捷键（modeValue = null）时返回 null。
 *
 * @param {string|null|undefined} currentModeValue 真实 <select> 的当前值
 * @param {{modeOptions?:Array, hasVoicePicker?:boolean, segments?:Array}} [caps]
 *        capsules 已由 segmentsFor 算好的分段（segments）时不必再算一遍；
 *        否则传 { modeOptions, hasVoicePicker }。
 * @returns {string|null}
 */
export function activeSegment(currentModeValue, caps) {
  const c = caps || {};
  const segments = Array.isArray(c.segments)
    ? c.segments
    : segmentsFor(c.modeOptions, c);
  const current = String(currentModeValue == null ? "" : currentModeValue);
  if (!current) return null;
  const hit = segments.find((s) => s.modeValue === current);
  return hit ? hit.id : null;
}

/**
 * 点某颗分段要选中的真实选项值。这颗分段没解析（或 library 是「聚焦选择器」
 * 快捷键）时返回 null——调用方据此知道「不要动模式」。
 *
 * @param {string} segmentId design | clone | library
 * @param {Array<{value:string,label?:string}>} modeOptions 同 segmentsFor
 * @returns {string|null}
 */
export function targetFor(segmentId, modeOptions) {
  const hit = segmentsFor(modeOptions, {}).find((s) => s.id === segmentId);
  return hit ? hit.modeValue : null;
}
