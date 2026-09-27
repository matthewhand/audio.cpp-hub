/* 参数渲染辅助：语言行 / paramSchema 控件 / 高级参数网格 / 枚举行 / 参数收集。
   供 TTS / ASR / 音乐 / 其它面板共用。 */
import { $, el, esc } from "../core/dom.js";
import { I18N, t } from "../core/i18n.js";

/* 不从 paramSchema 自动渲染为高级参数的键（有专属 UI 或语义特殊）；
   lang 在 TTS 枚举行渲染、收集时路由进 options（见 collectEnums） */
export const RESERVED_KEYS = new Set([
  "emotionModes",
  "emotionLabels",
  "emotion_alpha",
  "text",
  "voice_ref",
  "language",
  "speaker",
  "instruct",
  "instruction",
  "reference_text",
  "task_route",
  "lang",
  "text_chunk_mode",
]);

export function buildLanguageRow(container, m, prefix) {
  container.innerHTML = "";
  if (!m.language) return null;
  const locked = m.language.values.length <= 1;
  const label = el(
    `<label>${t("common.language")}<select id="${prefix}-language" ${locked ? "disabled" : ""}></select></label>`,
  );
  const sel = label.querySelector("select");
  for (const v of m.language.values) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    sel.appendChild(opt);
  }
  sel.value = m.language.default || m.language.values[0];
  container.appendChild(label);
  if (locked) {
    container.appendChild(
      el(`<div class="hint">${esc(t("common.langLocked", { lang: sel.value }))}</div>`),
    );
  }
  return sel;
}

export function schemaParams(m) {
  const s = m.paramSchema || {};
  return Object.entries(s).filter(
    ([k, v]) => v && typeof v === "object" && !Array.isArray(v) && v.type && !RESERVED_KEYS.has(k),
  );
}

export function paramInput(key, p, prefix) {
  // 标签默认用参数键名；paramSchema 可带 label/labelEn 双语显示名（I18N.pick 按语言选用）
  const labelText = I18N.pick(p, "label") || key;
  if (p.type === "boolean") {
    return el(
      `<label class="checkbox-label"><input type="checkbox" id="${esc(prefix)}-${esc(key)}" ${p.default ? "checked" : ""}> ${esc(labelText)}</label>`,
    );
  }
  if (p.type === "string") {
    const ph = I18N.pick(p, "placeholder");
    return el(
      `<label>${esc(labelText)}<input type="text" id="${esc(prefix)}-${esc(key)}" value="${esc(p.default ?? "")}"${ph ? ` placeholder="${esc(ph)}"` : ""}></label>`,
    );
  }
  if (p.type === "enum") {
    const label = el(
      `<label>${esc(labelText)}<select id="${esc(prefix)}-${esc(key)}"></select></label>`,
    );
    const sel = label.querySelector("select");
    for (const v of p.values) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      sel.appendChild(opt);
    }
    sel.value = p.default ?? p.values[0];
    return label;
  }
  const step = p.step ?? (p.type === "integer" ? 1 : 0.05);
  const min = p.min != null ? `min="${esc(p.min)}"` : "";
  const max = p.max != null ? `max="${esc(p.max)}"` : "";
  const val = p.default != null ? p.default : "";
  return el(
    `<label>${esc(labelText)}<input type="number" id="${esc(prefix)}-${esc(key)}" value="${esc(val)}" ${min} ${max} step="${esc(step)}"></label>`,
  );
}

export function renderAdvancedGrid(container, m, prefix) {
  container.innerHTML = "";
  for (const [key, p] of schemaParams(m)) {
    container.appendChild(paramInput(key, p, prefix));
  }
  return container.children.length > 0;
}

export function collectParams(m, prefix, req) {
  for (const [key, p] of schemaParams(m)) {
    const input = $(`${prefix}-${key}`);
    if (!input) continue;
    // 放进 options 嵌套对象：服务端 /v1/tasks/run 对 options 全量透传，
    // 顶层字段只认白名单（emotion_*、interval_silence_ms 等会被静默丢弃）
    const opts = req.options || (req.options = {});
    // qwen3_tts_voicedesign 的 seed 引擎要求放请求顶层（其余模型 seed 走 options 透传）
    const target = m.id === "qwen3_tts_voicedesign" && key === "seed" ? req : opts;
    if (p.type === "boolean") {
      target[key] = input.checked;
      continue;
    }
    const v = String(input.value).trim();
    if (v === "") continue;
    // enum 与 string 一样按字符串透传（如 index_tts2_5 的 lang），数值类型才做转换
    target[key] =
      p.type === "string" || p.type === "enum"
        ? v
        : p.type === "integer"
          ? parseInt(v, 10)
          : parseFloat(v);
  }
}

export function collectEnums(m, prefix, req, exclude) {
  const s = m.paramSchema || {};
  for (const [key, p] of Object.entries(s)) {
    if (!p || Array.isArray(p) || p.type !== "enum" || exclude.includes(key)) continue;
    const sel = $(`${prefix}-${key}`);
    if (!sel) continue;
    // lang 与 BreezeTTS 的 text_chunk_mode 是引擎 request option（服务端顶层白名单无这些字段），放进 options 透传；
    // 其余 enum（如 supertonic 的 voice_id）维持顶层路径不变
    const toOptions = key === "lang" || (m.family === "breeze_tts" && key === "text_chunk_mode");
    const target = toOptions ? req.options || (req.options = {}) : req;
    target[key] = sel.value;
  }
}

export function renderEnumRow(container, m, prefix, exclude) {
  container.innerHTML = "";
  const s = m.paramSchema || {};
  for (const [key, p] of Object.entries(s)) {
    if (!p || Array.isArray(p) || p.type !== "enum" || exclude.includes(key)) continue;
    container.appendChild(paramInput(key, p, prefix));
  }
}

export function buildTextRow(container, m, key, labelText, id) {
  container.innerHTML = "";
  const p = m.paramSchema && m.paramSchema[key];
  if (p && !Array.isArray(p)) {
    container.appendChild(
      el(
        `<label>${labelText}<input type="text" id="${id}" placeholder="${t("common.optional")}"></label>`,
      ),
    );
    return true;
  }
  return false;
}

export function buildBreezeInstructionRow(container, m) {
  container.innerHTML = "";
  if (m.family !== "breeze_tts") return;
  const p = m.paramSchema && m.paramSchema.instruction;
  if (!p || Array.isArray(p)) return;
  const labelText = I18N.pick(p, "label") || "instruction";
  const placeholder = I18N.pick(p, "placeholder") || "";
  const label = document.createElement("label");
  const title = document.createElement("span");
  const textarea = document.createElement("textarea");
  title.textContent = labelText;
  textarea.id = "tts-instruction";
  textarea.rows = 3;
  textarea.value = p.default ?? "";
  textarea.placeholder = placeholder;
  label.append(title, textarea);
  container.appendChild(label);
}
