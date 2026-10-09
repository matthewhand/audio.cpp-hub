/* web/modules/panels.js — 工作区与任务面板
 *
 * 右侧常驻工作区：按选中模型切换 TTS / ASR / 分离 / 音乐 / 其它五类面板，
 * 从 models.json 的 paramSchema 渲染高级参数与枚举、收集请求体，
 * 以及各面板的提交逻辑（VibeVoice 多说话人、情感向量 / 参考音频 / 文本、
 * YuE2 busy 超时等）。面板自身的表单状态（ttsVariant / emotionMode / speakerPickers…）
 * 都在本模块，因为只有本模块写。
 *
 * 五类面板里所有参考音频 / 说话人入口的 VoiceSelect 与 AudioPicker 实例也在本模块
 * 求值时一次性创建：它们是面板表单的部件，历史「载入」要回填的也正是这批实例，
 * 放在这里才能保证「重渲染后统一刷新标签」只有一个挂载点。
 * 组件本身仍是经典脚本（web/voice-select.js、web/audio-picker.js），本模块不重新实现。
 *
 * 同 sidebar.js：工作区重画要刷新侧栏历史，侧栏的「载入」要回填本模块的 TTS 表单，
 * 两模块之间是一处刻意的循环依赖（只在运行期回调里互相调用）。 */

import { renderCharCount } from "./char-count.js";
import { $, el, esc, t } from "./dom.js";
import { historyRefPath, loadHistory } from "./sidebar.js";
import { activeInstanceId, selectedModel } from "./state.js";
import { clearResult, reattachTasks, submitTask, trackTask } from "./tasks.js";

/* ---------- 表单选择器实例（模块求值时创建一次，仅本模块使用） ---------- */
/* ---------- 表单选择器实例（模块求值时创建一次，仅本模块使用） ---------- */
const voicePicker = new VoiceSelect($("voice-picker"), "picker.speakerRef", {
  onChange: (v) => { const rt = $("tts-reference-text"); if (v && v.text && rt) rt.value = v.text; }
});
const emotionPicker = new VoiceSelect($("emotion-picker"), "picker.emotionRef");
const asrAudioPicker = new AudioPicker($("asr-audio-picker"), "picker.inputRequired");
const sepAudioPicker = new AudioPicker($("sep-audio-picker"), "picker.inputRequired");
const otherAudioPicker = new AudioPicker($("other-audio-picker"), "picker.input");
const otherVoicePicker = new VoiceSelect($("other-voice-picker"), "picker.voiceRef");

export const RESERVED_KEYS = new Set([
  "emotionModes", "emotionLabels", "emotion_alpha",
  "text", "voice_ref", "language", "speaker", "instruct", "instruction", "reference_text", "task_route", "lang", "text_chunk_mode"
]);

export let breezeMode = "voice_design";

export let emotionMode = "none";
export const emotionVector = new Array(8).fill(0);
export let ttsVariant = "base";
export let ttsLanguageSel = null;
export let asrLanguageSel = null;
export let otherLanguageSel = null;
/* VibeVoice 多说话人：每行一个 AudioPicker，第 N 行对应脚本里的 Speaker N（voice_samples 顺序） */
export let speakerPickers = [];
export const VIBEVOICE_MAX_SPEAKERS = 4;

/* ---------- 工作区：按 category 切换面板 ---------- */
export function renderWorkspace() {
  const m = selectedModel();
  if (!m) return;
  for (const cat of ["tts", "asr", "sep", "music", "other"]) {
    $("panel-" + cat).classList.toggle("hidden", cat !== m.category);
  }
  if (m.category === "tts") renderTtsPanel(m);
  else if (m.category === "asr") renderAsrPanel(m);
  else if (m.category === "sep") renderSepPanel(m);
  else if (m.category === "music") renderMusicPanel(m);
  else renderOtherPanel(m);
  // 面板重渲染后刷新侧栏并重挂该模型的进行中任务（恢复进度显示）
  loadHistory();
  reattachTasks();
}

/* ---------- 参数渲染辅助 ---------- */
export function buildLanguageRow(container, m, prefix) {
  container.innerHTML = "";
  if (!m.language) return null;
  const locked = m.language.values.length <= 1;
  const label = el(`<label>${t("common.language")}<select id="${prefix}-language" ${locked ? "disabled" : ""}></select></label>`);
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
    container.appendChild(el(`<div class="hint">${esc(t("common.langLocked", { lang: sel.value }))}</div>`));
  }
  return sel;
}

export function schemaParams(m) {
  const s = m.paramSchema || {};
  return Object.entries(s).filter(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v) && v.type && !RESERVED_KEYS.has(k));
}

export function paramInput(key, p, prefix) {
  // 标签默认用参数键名；paramSchema 可带 label/labelEn 双语显示名（I18N.pick 按语言选用）
  const labelText = I18N.pick(p, "label") || key;
  if (p.type === "boolean") {
    return el(`<label class="checkbox-label"><input type="checkbox" id="${esc(prefix)}-${esc(key)}" ${p.default ? "checked" : ""}> ${esc(labelText)}</label>`);
  }
  if (p.type === "string") {
    const ph = I18N.pick(p, "placeholder");
    return el(`<label>${esc(labelText)}<input type="text" id="${esc(prefix)}-${esc(key)}" value="${esc(p.default ?? "")}"${ph ? ` placeholder="${esc(ph)}"` : ""}></label>`);
  }
  if (p.type === "enum") {
    const label = el(`<label>${esc(labelText)}<select id="${esc(prefix)}-${esc(key)}"></select></label>`);
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
  return el(`<label>${esc(labelText)}<input type="number" id="${esc(prefix)}-${esc(key)}" value="${esc(val)}" ${min} ${max} step="${esc(step)}"></label>`);
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
    const target = (m.id === "qwen3_tts_voicedesign" && key === "seed") ? req : opts;
    if (p.type === "boolean") { target[key] = input.checked; continue; }
    const v = String(input.value).trim();
    if (v === "") continue;
    // enum 与 string 一样按字符串透传（如 index_tts2_5 的 lang），数值类型才做转换
    target[key] = (p.type === "string" || p.type === "enum") ? v : (p.type === "integer" ? parseInt(v, 10) : parseFloat(v));
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
    const target = toOptions ? (req.options || (req.options = {})) : req;
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
    container.appendChild(el(`<label>${labelText}<input type="text" id="${id}" placeholder="${t("common.optional")}"></label>`));
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

export function clearSpeakerRows() {
  for (const sp of speakerPickers) {
    const idx = (window.__voiceSelects || []).indexOf(sp.picker);
    if (idx >= 0) window.__voiceSelects.splice(idx, 1);
    sp.row.remove();
  }
  speakerPickers = [];
}

export function renumberSpeakerRows() {
  speakerPickers.forEach((sp, i) => {
    const n = i + 1;
    sp.label.textContent = "Speaker " + n;
    sp.picker.titleKey = "Speaker " + n;
    sp.picker.$(".picker-title").textContent = "Speaker " + n;
  });
  $("tts-speaker-add").disabled = speakerPickers.length >= VIBEVOICE_MAX_SPEAKERS;
}

export function addSpeakerRow(path) {
  if (speakerPickers.length >= VIBEVOICE_MAX_SPEAKERS) return;
  const n = speakerPickers.length + 1;
  const row = el(`<details class="speaker-row"${n === 1 ? " open" : ""}>
    <summary><span class="speaker-label">Speaker ${n}</span>
      <span class="speaker-actions">
        <button type="button" class="btn-ghost speaker-remove"></button>
      </span>
    </summary>
    <textarea class="speaker-lines" rows="2"></textarea>
    <div class="speaker-picker-mount"></div>
  </details>`);
  const removeBtn = row.querySelector(".speaker-remove");
  const linesTa = row.querySelector(".speaker-lines");
  removeBtn.textContent = t("tts.speakerRemove");
  linesTa.placeholder = t("tts.speakerLinesPlaceholder");
  removeBtn.onclick = () => {
    const i = speakerPickers.findIndex(sp => sp.row === row);
    if (i < 0) return;
    const idx = (window.__voiceSelects || []).indexOf(speakerPickers[i].picker);
    if (idx >= 0) window.__voiceSelects.splice(idx, 1);
    speakerPickers.splice(i, 1);
    row.remove();
    if (!speakerPickers.length) addSpeakerRow();
    renumberSpeakerRows();
  };
  // summary 里的按钮不应触发 details 折叠
  row.querySelector(".speaker-actions").onclick = (e) => e.stopPropagation();
  row.querySelector(".speaker-actions").addEventListener("click", (e) => e.preventDefault());
  const picker = new VoiceSelect(row.querySelector(".speaker-picker-mount"), "Speaker " + n);
  $("tts-speakers-list").appendChild(row);
  speakerPickers.push({ picker, row, label: row.querySelector(".speaker-label"), removeBtn, linesTa });
  renumberSpeakerRows();
  if (path) picker.setByPath(path);
}

export function renderSpeakersBlock(m) {
  const show = m.family === "vibevoice";
  $("tts-speakers-block").classList.toggle("hidden", !show);
  // VibeVoice 的脚本由各说话人行内的台词框组装，主文本框不使用
  $("tts-text-block").classList.toggle("hidden", show);
  // 语言切换等重渲染会重建本区块：先快照已填的音色与台词，重建后还原
  const saved = speakerPickers.map(sp => ({ path: sp.picker.getValue(), lines: sp.linesTa.value }));
  clearSpeakerRows();
  if (!show) return;
  if (!saved.length) { addSpeakerRow(); return; }
  for (const s of saved.slice(0, VIBEVOICE_MAX_SPEAKERS)) {
    addSpeakerRow(s.path);
    speakerPickers[speakerPickers.length - 1].linesTa.value = s.lines;
  }
}

$("tts-speaker-add").onclick = () => addSpeakerRow();

/* 各说话人台词按行号轮流拼接：所有人的第 1 句 → 第 2 句 → …，空行跳过 */
export function buildVibeVoiceScript() {
  const per = speakerPickers.map(sp => sp.linesTa.value.split("\n").map(s => s.trim()).filter(Boolean));
  const maxLen = Math.max(0, ...per.map(a => a.length));
  const out = [];
  for (let k = 0; k < maxLen; k++) {
    for (let i = 0; i < per.length; i++) {
      if (per[i][k]) out.push("Speaker " + (i + 1) + ": " + per[i][k]);
    }
  }
  return out.join("\n");
}

/* qwen3_tts 变体由模型条目决定（拆分后三个独立模型：base/customvoice/voicedesign） */
export function qwen3VariantOf(modelId) {
  if (modelId === "qwen3_tts_customvoice") return "custom_voice";
  if (modelId === "qwen3_tts_voicedesign") return "voice_design";
  return "base";
}

/* ---------- TTS 面板 ---------- */
export function renderTtsPanel(m) {
  $("tts-title").textContent = t("tts.title") + " — " + I18N.pick(m, "displayName");
  buildBreezeInstructionRow($("tts-primary-instruction-row"), m);
  ttsLanguageSel = buildLanguageRow($("tts-language-row"), m, "tts");
  const modeRow = $("tts-mode-row");
  modeRow.innerHTML = "";
  if (m.family === "breeze_tts") {
    const label = el(`<label>${t("tts.modeLabel")}<select id="tts-breeze-mode"></select></label>`);
    const sel = label.querySelector("select");
    for (const mode of ["voice_design", "voice_clone"]) {
      const opt = document.createElement("option");
      opt.value = mode;
      opt.textContent = t("tts.mode." + mode);
      sel.appendChild(opt);
    }
    sel.value = breezeMode;
    sel.onchange = () => {
      breezeMode = sel.value;
      updateTtsBlocks(m);
    };
    modeRow.appendChild(label);
  }

  // qwen3_tts 变体：模型拆分后由条目决定，不再显示下拉
  if (m.family === "qwen3_tts") {
    ttsVariant = qwen3VariantOf(m.id);
  }

  // qwen3_tts CustomVoice 的 speaker 下拉
  const speakerRow = $("tts-speaker-row");
  speakerRow.innerHTML = "";
  if (m.family === "qwen3_tts" && m.paramSchema && m.paramSchema.speaker) {
    speakerRow.appendChild(paramInput("speaker", m.paramSchema.speaker, "tts-spk"));
  }

  buildTextRow($("tts-instruct-row"), m, "instruct", t("tts.instructLabel"), "tts-instruct");
  buildTextRow($("tts-ref-text-row"), m, "reference_text", t("tts.refTextLabel"), "tts-reference-text");
  // OmniVoice 原生克隆要求 reference_text，占位提示不能写"可选"
  const rtInput = $("tts-reference-text");
  if (rtInput && m.family === "omnivoice") {
    rtInput.placeholder = t("tts.refTextPlaceholderRequired");
  }
  // lang 在本行渲染（显眼位置），收集时由 collectEnums 路由进 req.options
  renderEnumRow($("tts-enum-row"), m, "tts-enum", ["language", "speaker"]);

  $("tts-emotion-block").classList.toggle("hidden", !(m.paramSchema && m.paramSchema.emotionModes));

  renderSpeakersBlock(m);

  const hasAdvanced = renderAdvancedGrid($("tts-advanced-grid"), m, "adv");
  $("tts-advanced").classList.toggle("hidden", !hasAdvanced);

  updateTtsBlocks(m);
  $("tts-text").placeholder = t("tts.textPlaceholder");
  $("tts-result").classList.add("hidden");
  $("tts-msg").textContent = "";
  $("tts-stats").textContent = "";
}

export function updateTtsBlocks(m) {
  const isQwen = m.family === "qwen3_tts";
  const voiceRefMode = m.inputs && m.inputs.voiceRef;
  let showVoice = voiceRefMode && voiceRefMode !== "none";
  if (isQwen) showVoice = ttsVariant === "base";
  if (m.family === "breeze_tts") showVoice = breezeMode === "voice_clone";
  $("tts-voice-block").classList.toggle("hidden", !showVoice);
  $("tts-speaker-row").classList.toggle("hidden", !(isQwen && ttsVariant === "custom_voice"));
  if (isQwen) {
    // instruct：Base 不读；reference_text：仅 Base 克隆用（参考音频的转写）
    $("tts-instruct-row").classList.toggle("hidden", ttsVariant === "base");
    $("tts-ref-text-row").classList.toggle("hidden", ttsVariant !== "base");
    // instruct 在 VoiceDesign 下必填，CustomVoice 下可选
    const insInput = $("tts-instruct");
    if (insInput) {
      insInput.placeholder = ttsVariant === "voice_design" ? t("tts.instructPlaceholderRequired") : t("tts.instructPlaceholderOptional");
    }
  }
  if (m.family === "breeze_tts") {
    $("tts-ref-text-row").classList.toggle("hidden", breezeMode !== "voice_clone");
  }
}

$("tts-submit").onclick = async () => {
  const m = selectedModel();
  const msg = $("tts-msg");
  msg.textContent = "";
  $("tts-result").classList.add("hidden");
  if (!activeInstanceId) { msg.textContent = t("instance.noReady"); return; }

  const req = {};
  // VibeVoice 的脚本由各说话人台词框组装；其它模型用主文本框
  req.text = m.family === "vibevoice" ? buildVibeVoiceScript() : $("tts-text").value;
  if (!req.text.trim()) { msg.textContent = t("tts.errNoText"); return; }
  if (ttsLanguageSel && ttsLanguageSel.value) req.language = ttsLanguageSel.value;

  // 声音来源
  if (m.family === "qwen3_tts") {
    if (ttsVariant === "base") {
      const v = voicePicker.getValue();
      if (!v) { msg.textContent = t("tts.errNoVoice"); return; }
      req.voice_ref = v;
      const rt = $("tts-reference-text");
      if (rt && rt.value.trim()) req.reference_text = rt.value.trim();
    } else if (ttsVariant === "custom_voice") {
      req.speaker = $("tts-spk-speaker").value;
      const ins = $("tts-instruct");
      if (ins && ins.value.trim()) req.instruct = ins.value.trim();
    } else {
      const ins = $("tts-instruct");
      if (!ins || !ins.value.trim()) { msg.textContent = t("tts.errNoInstruct"); return; }
      req.instruct = ins.value.trim();
    }
  } else {
    let voiceRefMode = m.inputs && m.inputs.voiceRef;
    if (m.family === "breeze_tts") {
      voiceRefMode = breezeMode === "voice_clone" ? "required" : "none";
    }
    if (voiceRefMode && voiceRefMode !== "none") {
      const v = voicePicker.getValue();
      if (voiceRefMode === "required" && !v) { msg.textContent = t("tts.errNoVoice"); return; }
      if (v) req.voice_ref = v;
    }
    // VibeVoice 多说话人：音色按行序拼成 voice_samples，中间不能有空洞
    // （引擎按下标映射 Speaker 编号，空洞会导致映射错位）
    if (m.family === "vibevoice") {
      const vals = speakerPickers.map(sp => sp.picker.getValue());
      let last = -1;
      vals.forEach((v, i) => { if (v) last = i; });
      if (last >= 0) {
        for (let i = 0; i <= last; i++) {
          if (!vals[i]) { msg.textContent = t("tts.errVibevoiceGap", { n: i + 1 }); return; }
        }
        // 脚本引用的最大 Speaker 编号（引擎按最小编号归一化：min>0 时整体减 1）
        let minId = Infinity, maxId = 0;
        for (const mm of req.text.matchAll(/^Speaker\s+(\d+)\s*:/gim)) {
          const id = parseInt(mm[1], 10);
          if (id < minId) minId = id;
          if (id > maxId) maxId = id;
        }
        const need = maxId > 0 ? (minId > 0 ? maxId : maxId + 1) : 0;
        if (need > last + 1) { msg.textContent = t("tts.errVibevoiceNeedVoices", { n: need }); return; }
        const opts = req.options || (req.options = {});
        opts.voice_samples = vals.slice(0, last + 1).join(",");
      }
    }
    const rt = $("tts-reference-text");
    if (rt && rt.value.trim() && (m.family !== "breeze_tts" || breezeMode === "voice_clone")) {
      req.reference_text = rt.value.trim();
    }
    // OmniVoice 原生克隆：提供了参考音频就必须给出参考文本（引擎侧硬约束）
    if (m.family === "omnivoice" && req.voice_ref && !req.reference_text) {
      msg.textContent = t("tts.errOmnivoiceRef");
      return;
    }
    if (m.family === "breeze_tts" && req.voice_ref && !req.reference_text) {
      msg.textContent = t("tts.errBreezeRef");
      return;
    }
    if (m.family === "breeze_tts") {
      const instruction = $("tts-instruction");
      const value = instruction ? instruction.value.trim() : "";
      if (breezeMode === "voice_design" && !value) {
        msg.textContent = t("tts.errBreezeInstruction");
        return;
      }
      if (value) {
        const opts = req.options || (req.options = {});
        opts.instruction = value;
      }
    }
    const ins = $("tts-instruct");
    if (ins && ins.value.trim()) req.instruct = ins.value.trim();
  }

  collectEnums(m, "tts-enum", req, ["language", "speaker"]);

  // 情感控制（index_tts2 / index_tts2_5；除情感参考音频走顶层 audio 外，其余通过 options 透传给引擎）
  if (m.paramSchema && m.paramSchema.emotionModes) {
    const opts = req.options || (req.options = {});
    if (emotionMode === "emotion_audio") {
      const v = emotionPicker.getValue();
      if (!v) { msg.textContent = t("tts.errNoEmotionAudio"); return; }
      req.audio = v;
    } else if (emotionMode === "emotion_vector") {
      opts.emotion_vector = emotionVector.slice();
      opts.use_random_emotion = false;
    } else if (emotionMode === "emotion_text") {
      opts.use_emotion_text = true;
      const emoText = $("tts-emotion-text").value.trim();
      if (emoText) opts.emotion_text = emoText;
    }
    if (emotionMode !== "none") {
      opts.emotion_alpha = parseFloat($("tts-emotion-alpha").value);
    }
  }

  collectParams(m, "adv", req);

  // 异步任务：提交即返回，排队/执行进度由 trackTask 轮询展示，按钮不再阻塞（允许连续提交排队）
  $("tts-stats").textContent = "";
  try {
    trackTask(await submitTask(req));
  } catch (e) {
    msg.textContent = e.message;
  }
};

/* ---------- 情感模式 Tab（index_tts2 / index_tts2_5） ---------- */
/** @type {HTMLButtonElement[]} */
const emotionTabs = /** @type {HTMLButtonElement[]} */ ([
  ...document.querySelectorAll("#tts-emotion-block .tab")
]);
function selectEmotionTab(tab, { focus = false } = {}) {
  if (!tab) return;
  emotionMode = tab.dataset.mode;
  emotionTabs.forEach(tb => {
    const on = tb === tab;
    tb.classList.toggle("active", on);
    tb.setAttribute("aria-selected", on ? "true" : "false");
    tb.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll("#tts-emotion-block .emotion-pane").forEach(p => p.classList.add("hidden"));
  $("emotion-pane-" + emotionMode).classList.remove("hidden");
  $("emotion-alpha-row").classList.toggle("hidden", emotionMode === "none");
  if (focus) tab.focus();
}
emotionTabs.forEach((tab, i) => {
  tab.onclick = () => selectEmotionTab(tab);
  tab.onkeydown = e => {
    const step = { ArrowRight: 1, ArrowLeft: -1, Home: "first", End: "last" };
    if (!(e.key in step)) return;
    e.preventDefault();
    const next =
      step[e.key] === "first"
        ? 0
        : step[e.key] === "last"
          ? emotionTabs.length - 1
          : (i + step[e.key] + emotionTabs.length) % emotionTabs.length;
    selectEmotionTab(emotionTabs[next], { focus: true });
  };
});

export function buildEmotionSliders() {
  const container = $("emotion-sliders");
  container.innerHTML = "";
  /* emotion.labels 是数组型字典值：I18N.t() 对它返回字符串数组（局部 t() 包装只标了 string） */
  I18N.t("emotion.labels").forEach((label, i) => {
    const row = document.createElement("div");
    row.className = "slider-row";
    row.innerHTML = `<span class="slider-label">${esc(label)}</span>
      <input type="range" min="0" max="1" step="0.05" value="0" data-idx="${i}" aria-label="${esc(label)}">
      <span class="slider-val" id="emotion-val-${i}">0.00</span>`;
    container.appendChild(row);
  });
  container.oninput = (e) => {
    const idx = parseInt(e.target.dataset.idx, 10);
    emotionVector[idx] = parseFloat(e.target.value);
    $("emotion-val-" + idx).textContent = emotionVector[idx].toFixed(2);
  };
}

$("tts-emotion-alpha").addEventListener("input", (e) => {
  $("emotion-alpha-val").textContent = parseFloat(e.target.value).toFixed(2);
});

export function fillTtsForm(m, rec) {
  $("tts-text").value = rec.text || "";
  if (rec.language && ttsLanguageSel &&
      [...ttsLanguageSel.options].some(o => o.value === rec.language)) {
    ttsLanguageSel.value = rec.language;
  }

  const voice = rec.voice || { kind: "default" };
  if (m.family === "breeze_tts") {
    breezeMode = voice.kind === "voice_ref" ? "voice_clone" : "voice_design";
    const modeSel = $("tts-breeze-mode");
    if (modeSel) modeSel.value = breezeMode;
    updateTtsBlocks(m);
  }
  if (m.family === "qwen3_tts") {
    // 变体由模型条目决定（拆分后三个独立模型），历史声音来源与变体一一对应
    ttsVariant = qwen3VariantOf(m.id);
    updateTtsBlocks(m);
    if (voice.kind === "speaker" && voice.speaker) {
      const spk = $("tts-spk-speaker");
      if (spk) spk.value = voice.speaker;
    }
  }
  if (voice.kind === "voice_ref" && voice.voiceRef) {
    // voice_ref 是服务器路径：AudioPicker 没有对外设值接口，
    // 切到"本地路径"页签填入路径并探测（与手动粘贴路径等价，失败时仅提示不透传）
    voicePicker.setByPath(historyRefPath(m, rec, "ref") || voice.voiceRef);
  }
  const rtInput = $("tts-reference-text");
  if (rtInput) rtInput.value = voice.referenceText || "";
  const insInput = $("tts-instruct");
  if (insInput) insInput.value = voice.instruct || "";

  const breezeInstruction = $("tts-instruction");
  if (breezeInstruction) {
    const saved = rec.options && rec.options.instruction;
    const schema = m.paramSchema && m.paramSchema.instruction;
    breezeInstruction.value = saved !== undefined ? String(saved) : String(schema && schema.default || "");
  }

  applyHistoryOptions(m, rec.options || {});

  // VibeVoice：voice_samples 按顺序填回各行音色（本地路径页签 + 探测，与手动粘贴等价），
  // 脚本里的 Speaker N: 行按编号分发回各行台词框（0 起编号上移 1；无 Speaker 行的旧记录整段归入 Speaker 1）
  if (m.family === "vibevoice") {
    const paths = rec.options && rec.options.voice_samples
      ? String(rec.options.voice_samples).split(",").map(s => s.trim()).filter(Boolean)
      : [];
    // 有快照的说话人音色改用快照路径（源文件可能已删除/移动）
    for (let i = 0; i < paths.length; i++) {
      const snap = historyRefPath(m, rec, "spk" + i);
      if (snap) paths[i] = snap;
    }
    const lines = [];
    for (const mm of String(rec.text || "").matchAll(/^Speaker\s+(\d+)\s*:\s*(.*)$/gim)) {
      lines.push({ id: parseInt(mm[1], 10), text: mm[2] });
    }
    const minId = lines.length ? Math.min(...lines.map(x => x.id)) : 1;
    const shift = lines.length && minId === 0 ? 1 : 0;
    const maxRow = Math.max(1, paths.length, ...lines.map(x => x.id + shift));
    clearSpeakerRows();
    for (let i = 0; i < maxRow; i++) addSpeakerRow(paths[i]);
    for (const x of lines) {
      const sp = speakerPickers[x.id + shift - 1];
      if (sp) sp.linesTa.value = (sp.linesTa.value ? sp.linesTa.value + "\n" : "") + x.text;
    }
    if (!lines.length && rec.text && speakerPickers[0]) speakerPickers[0].linesTa.value = rec.text;
  }
  renderCharCount();
}

/* options 里的参数填回 paramSchema 渲染的控件：高级参数网格（adv- 前缀）+ 枚举行 */
export function applyHistoryOptions(m, options) {
  for (const [key, p] of schemaParams(m)) {
    const input = $("adv-" + key);
    if (!input || options[key] === undefined) continue;
    if (p.type === "boolean") { input.checked = !!options[key]; continue; }
    input.value = String(options[key]);
  }
  const s = m.paramSchema || {};
  for (const [key, p] of Object.entries(s)) {
    if (!p || Array.isArray(p) || p.type !== "enum" || ["language", "speaker"].includes(key)) continue;
    const sel = $(`tts-enum-${key}`);
    if (sel && options[key] !== undefined) sel.value = String(options[key]);
  }
}

/* ---------- ASR 面板 ---------- */
export function renderAsrPanel(m) {
  $("asr-title").textContent = t("asr.title") + " — " + I18N.pick(m, "displayName");
  asrLanguageSel = buildLanguageRow($("asr-language-row"), m, "asr");
  const textRow = $("asr-text-row");
  textRow.innerHTML = "";
  if (m.inputs && m.inputs.text === "optional") {
    textRow.appendChild(el(`<label>${t("asr.contextLabel")}<textarea id="asr-text-input" rows="2" placeholder="${t("asr.contextPlaceholder")}"></textarea></label>`));
  }
  const hasAdvanced = renderAdvancedGrid($("asr-advanced-grid"), m, "asr-adv");
  $("asr-advanced").classList.toggle("hidden", !hasAdvanced);
  $("asr-result").classList.add("hidden");
  $("asr-msg").textContent = "";
  $("asr-stats").textContent = "";
}

$("asr-submit").onclick = async () => {
  const m = selectedModel();
  const msg = $("asr-msg");
  msg.textContent = "";
  $("asr-result").classList.add("hidden");
  if (!activeInstanceId) { msg.textContent = t("instance.noReady"); return; }

  const audio = asrAudioPicker.getValue();
  if (!audio) { msg.textContent = t("asr.errNoAudio"); return; }

  const req = { audio };
  if (asrLanguageSel && asrLanguageSel.value) req.language = asrLanguageSel.value;
  const ctxText = $("asr-text-input");
  if (ctxText && ctxText.value.trim()) req.text = ctxText.value.trim();
  collectParams(m, "asr-adv", req);

  // 异步任务：提交即返回，进度/结果由 trackTask 轮询处理
  $("asr-stats").textContent = "";
  try {
    trackTask(await submitTask(req));
  } catch (e) {
    msg.textContent = e.message;
  }
};

$("asr-copy").onclick = () => {
  navigator.clipboard.writeText($("asr-text").textContent);
  $("asr-copy").textContent = t("asr.copied");
  setTimeout(() => { $("asr-copy").textContent = t("asr.copy"); }, 1500);
};

/* ---------- SEP 面板 ---------- */
export function renderSepPanel(m) {
  $("sep-title").textContent = t("sep.title") + " — " + I18N.pick(m, "displayName");
  clearResult($("sep-result"));
  $("sep-msg").textContent = "";
  $("sep-stats").textContent = "";
}

$("sep-submit").onclick = async () => {
  const msg = $("sep-msg");
  msg.textContent = "";
  clearResult($("sep-result"));
  if (!activeInstanceId) { msg.textContent = t("instance.noReady"); return; }

  const audio = sepAudioPicker.getValue();
  if (!audio) { msg.textContent = t("sep.errNoAudio"); return; }

  // 异步任务：提交即返回，进度/结果由 trackTask 轮询处理
  $("sep-stats").textContent = "";
  try {
    trackTask(await submitTask({ audio }));
  } catch (e) {
    msg.textContent = e.message;
  }
};

export const YUE2_BUSY_TIMEOUT_MS = 900000;

export function renderMusicPanel(m) {
  $("music-title").textContent = t("music.title") + " — " + I18N.pick(m, "displayName");
  const cotSel = $("music-cot");
  cotSel.innerHTML = "";
  for (const mode of ["off", "melody", "full"]) {
    const opt = document.createElement("option");
    opt.value = mode;
    opt.textContent = mode + " — " + t("music.cot." + mode);
    cotSel.appendChild(opt);
  }
  cotSel.value = "full";

  const hasAdvanced = renderAdvancedGrid($("music-advanced-grid"), m, "music-adv");
  $("music-advanced").classList.toggle("hidden", !hasAdvanced);

  clearResult($("music-result"));
  $("music-msg").textContent = "";
  $("music-stats").textContent = "";
}

$("music-submit").onclick = async () => {
  const m = selectedModel();
  const msg = $("music-msg");
  msg.textContent = "";
  clearResult($("music-result"));
  if (!activeInstanceId) { msg.textContent = t("instance.noReady"); return; }

  const style = $("music-style").value.trim();
  const lyrics = $("music-lyrics").value.trim();
  const cot = $("music-cot").value;
  const abc = $("music-abc").value.trim();
  if (!style) { msg.textContent = t("music.errNoStyle"); return; }
  if (!lyrics) { msg.textContent = t("music.errNoLyrics"); return; }
  if (abc && cot === "off") { msg.textContent = t("music.errAbcCot"); return; }

  // yue2 全部专属参数放 options；text 既作任务记录预览，也是引擎的歌词回退通道
  const options = { style, lyrics, cot };
  if (abc) options.abc = abc;
  const req = {
    text: lyrics,
    lyrics: lyrics,
    options,
    busy_timeout_ms: YUE2_BUSY_TIMEOUT_MS
  };
  // 种子：超过 2^53 的整数用 JSON number 会丢精度，按协议以字符串传输
  const seed = $("music-seed").value.trim();
  if (seed) req.seed = /^\d+$/.test(seed) && seed.length > 15 ? seed : parseInt(seed, 10);

  // cfg_scale / num_inference_steps / abc_* / semantic_* 由通用收集写入 options
  collectParams(m, "music-adv", req);

  // 异步任务：提交即返回，排队/进度由 trackTask 轮询展示
  $("music-stats").textContent = "";
  try {
    trackTask(await submitTask(req));
  } catch (e) {
    msg.textContent = e.message;
  }
};

/* ---------- OTHER 面板 ---------- */
export function renderOtherPanel(m) {
  $("other-title").textContent = I18N.pick(m, "displayName");
  const inputs = m.inputs || { text: "none", audio: "none", voiceRef: "none" };

  const textRow = $("other-text-row");
  textRow.innerHTML = "";
  if (inputs.text !== "none") {
    textRow.appendChild(el(`<label>${t("other.textLabel")}${inputs.text === "required" ? t("common.required") : t("common.optionalSuffix")}<textarea id="other-text-input" rows="3"></textarea></label>`));
  }
  $("other-audio-block").classList.toggle("hidden", inputs.audio === "none");
  $("other-voice-block").classList.toggle("hidden", inputs.voiceRef === "none");
  otherLanguageSel = buildLanguageRow($("other-language-row"), m, "other");

  // paramSchema 全部字段内联渲染
  const fields = $("other-fields");
  fields.innerHTML = "";
  for (const [key, p] of Object.entries(m.paramSchema || {})) {
    if (!p || Array.isArray(p) || !p.type) continue;
    fields.appendChild(paramInput(key, p, "other-field"));
  }

  clearResult($("other-result"));
  $("other-msg").textContent = "";
  $("other-stats").textContent = "";
}

$("other-submit").onclick = async () => {
  const m = selectedModel();
  const msg = $("other-msg");
  msg.textContent = "";
  clearResult($("other-result"));
  if (!activeInstanceId) { msg.textContent = t("instance.noReady"); return; }
  const inputs = m.inputs || { text: "none", audio: "none", voiceRef: "none" };

  const req = {};
  if (inputs.text !== "none") {
    const txt = $("other-text-input").value.trim();
    if (inputs.text === "required" && !txt) { msg.textContent = t("other.errNoText"); return; }
    if (txt) req.text = txt;
  }
  if (inputs.audio !== "none") {
    const v = otherAudioPicker.getValue();
    if (inputs.audio === "required" && !v) { msg.textContent = t("other.errNoAudio"); return; }
    if (v) req.audio = v;
  }
  if (inputs.voiceRef !== "none") {
    const v = otherVoicePicker.getValue();
    if (inputs.voiceRef === "required" && !v) { msg.textContent = t("other.errNoVoice"); return; }
    if (v) req.voice_ref = v;
  }
  if (otherLanguageSel && otherLanguageSel.value) req.language = otherLanguageSel.value;

  // paramSchema 字段：与 TTS/ASR 面板一致，放进 options 透传（服务端顶层只认白名单，
  // 如 stable_audio 的 negative_prompt 放顶层会被静默丢弃）；
  // RESERVED_KEYS（task_route 等）在服务端有顶层专有映射（task_route→options.route、路径解析等），保持顶层
  for (const [key, p] of Object.entries(m.paramSchema || {})) {
    if (!p || Array.isArray(p) || !p.type) continue;
    const input = $(`other-field-${key}`);
    if (!input) continue;
    const target = RESERVED_KEYS.has(key) ? req : (req.options || (req.options = {}));
    if (p.type === "boolean") { target[key] = input.checked; continue; }
    const v = String(input.value).trim();
    if (v === "") continue;
    target[key] = (p.type === "string" || p.type === "enum") ? v
      : (p.type === "integer" ? parseInt(v, 10) : parseFloat(v));
  }

  // 额外参数 JSON 合并
  const extra = $("other-extra").value.trim();
  if (extra) {
    try {
      Object.assign(req, JSON.parse(extra));
    } catch (e) {
      msg.textContent = t("other.errExtraJson", { msg: e.message });
      return;
    }
  }

  // 异步任务：提交即返回，进度/结果由 trackTask 轮询处理
  $("other-stats").textContent = "";
  try {
    trackTask(await submitTask(req));
  } catch (e) {
    msg.textContent = e.message;
  }
};
