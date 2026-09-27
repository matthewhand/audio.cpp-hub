/* TTS 面板：多说话人（VibeVoice）/ 情感控制 / 参数渲染与提交 / 历史记录回填表单。 */
import { $, el, esc } from "../core/dom.js";
import { I18N, t } from "../core/i18n.js";
import { state, selectedModel, VIBEVOICE_MAX_SPEAKERS } from "../core/state.js";
import { qwen3VariantOf } from "../core/format.js";
import {
  buildLanguageRow, renderEnumRow, renderAdvancedGrid, collectParams, collectEnums,
  buildTextRow, buildBreezeInstructionRow, paramInput, schemaParams
} from "./params.js";
import { submitTask, trackTask } from "./tasks.js";
import { historyRefPath } from "./history.js";

/* ---------- VibeVoice 多说话人块 ---------- */
/* 行号即 Speaker 编号：每个说话人一个元素，内含台词框（每行一句）+ 音色选择器。
   提交时按行号轮流把各说话人的台词拼成 Speaker N: 脚本，音色按行序拼成 voice_samples。 */
function clearSpeakerRows() {
  for (const sp of state.speakerPickers) {
    const idx = (window.__voiceSelects || []).indexOf(sp.picker);
    if (idx >= 0) window.__voiceSelects.splice(idx, 1);
    sp.row.remove();
  }
  state.speakerPickers = [];
}

function renumberSpeakerRows() {
  state.speakerPickers.forEach((sp, i) => {
    const n = i + 1;
    sp.label.textContent = "Speaker " + n;
    sp.picker.titleKey = "Speaker " + n;
    sp.picker.$(".picker-title").textContent = "Speaker " + n;
  });
  $("tts-speaker-add").disabled = state.speakerPickers.length >= VIBEVOICE_MAX_SPEAKERS;
}

function addSpeakerRow(path) {
  if (state.speakerPickers.length >= VIBEVOICE_MAX_SPEAKERS) return;
  const n = state.speakerPickers.length + 1;
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
    const i = state.speakerPickers.findIndex(sp => sp.row === row);
    if (i < 0) return;
    const idx = (window.__voiceSelects || []).indexOf(state.speakerPickers[i].picker);
    if (idx >= 0) window.__voiceSelects.splice(idx, 1);
    state.speakerPickers.splice(i, 1);
    row.remove();
    if (!state.speakerPickers.length) addSpeakerRow();
    renumberSpeakerRows();
  };
  // summary 里的按钮不应触发 details 折叠
  row.querySelector(".speaker-actions").onclick = (e) => e.stopPropagation();
  row.querySelector(".speaker-actions").addEventListener("click", (e) => e.preventDefault());
  const picker = new VoiceSelect(row.querySelector(".speaker-picker-mount"), "Speaker " + n);
  $("tts-speakers-list").appendChild(row);
  state.speakerPickers.push({ picker, row, label: row.querySelector(".speaker-label"), removeBtn, linesTa });
  renumberSpeakerRows();
  if (path) picker.setByPath(path);
}

function renderSpeakersBlock(m) {
  const show = m.family === "vibevoice";
  $("tts-speakers-block").classList.toggle("hidden", !show);
  // VibeVoice 的脚本由各说话人行内的台词框组装，主文本框不使用
  $("tts-text-block").classList.toggle("hidden", show);
  // 语言切换等重渲染会重建本区块：先快照已填的音色与台词，重建后还原
  const saved = state.speakerPickers.map(sp => ({ path: sp.picker.getValue(), lines: sp.linesTa.value }));
  clearSpeakerRows();
  if (!show) return;
  if (!saved.length) { addSpeakerRow(); return; }
  for (const s of saved.slice(0, VIBEVOICE_MAX_SPEAKERS)) {
    addSpeakerRow(s.path);
    state.speakerPickers[state.speakerPickers.length - 1].linesTa.value = s.lines;
  }
}

$("tts-speaker-add").onclick = () => addSpeakerRow();

/* 各说话人台词按行号轮流拼接：所有人的第 1 句 → 第 2 句 → …，空行跳过 */
function buildVibeVoiceScript() {
  const per = state.speakerPickers.map(sp => sp.linesTa.value.split("\n").map(s => s.trim()).filter(Boolean));
  const maxLen = Math.max(0, ...per.map(a => a.length));
  const out = [];
  for (let k = 0; k < maxLen; k++) {
    for (let i = 0; i < per.length; i++) {
      if (per[i][k]) out.push("Speaker " + (i + 1) + ": " + per[i][k]);
    }
  }
  return out.join("\n");
}

/* ---------- TTS 面板 ---------- */
export function renderTtsPanel(m) {
  $("tts-title").textContent = t("tts.title") + " — " + I18N.pick(m, "displayName");
  buildBreezeInstructionRow($("tts-primary-instruction-row"), m);
  state.ttsLanguageSel = buildLanguageRow($("tts-language-row"), m, "tts");
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
    sel.value = state.breezeMode;
    sel.onchange = () => {
      state.breezeMode = sel.value;
      updateTtsBlocks(m);
    };
    modeRow.appendChild(label);
  }

  // qwen3_tts 变体：模型拆分后由条目决定，不再显示下拉
  if (m.family === "qwen3_tts") {
    state.ttsVariant = qwen3VariantOf(m.id);
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

function updateTtsBlocks(m) {
  const isQwen = m.family === "qwen3_tts";
  const voiceRefMode = m.inputs && m.inputs.voiceRef;
  let showVoice = voiceRefMode && voiceRefMode !== "none";
  if (isQwen) showVoice = state.ttsVariant === "base";
  if (m.family === "breeze_tts") showVoice = state.breezeMode === "voice_clone";
  $("tts-voice-block").classList.toggle("hidden", !showVoice);
  $("tts-speaker-row").classList.toggle("hidden", !(isQwen && state.ttsVariant === "custom_voice"));
  if (isQwen) {
    // instruct：Base 不读；reference_text：仅 Base 克隆用（参考音频的转写）
    $("tts-instruct-row").classList.toggle("hidden", state.ttsVariant === "base");
    $("tts-ref-text-row").classList.toggle("hidden", state.ttsVariant !== "base");
    // instruct 在 VoiceDesign 下必填，CustomVoice 下可选
    const insInput = $("tts-instruct");
    if (insInput) {
      insInput.placeholder = state.ttsVariant === "voice_design" ? t("tts.instructPlaceholderRequired") : t("tts.instructPlaceholderOptional");
    }
  }
  if (m.family === "breeze_tts") {
    $("tts-ref-text-row").classList.toggle("hidden", state.breezeMode !== "voice_clone");
  }
}

$("tts-submit").onclick = async () => {
  const m = selectedModel();
  const msg = $("tts-msg");
  msg.textContent = "";
  $("tts-result").classList.add("hidden");
  if (!state.activeInstanceId) { msg.textContent = t("instance.noReady"); return; }

  const req = {};
  // VibeVoice 的脚本由各说话人台词框组装；其它模型用主文本框
  req.text = m.family === "vibevoice" ? buildVibeVoiceScript() : $("tts-text").value;
  if (!req.text.trim()) { msg.textContent = t("tts.errNoText"); return; }
  if (state.ttsLanguageSel && state.ttsLanguageSel.value) req.language = state.ttsLanguageSel.value;

  // 声音来源
  if (m.family === "qwen3_tts") {
    if (state.ttsVariant === "base") {
      const v = state.voicePicker.getValue();
      if (!v) { msg.textContent = t("tts.errNoVoice"); return; }
      req.voice_ref = v;
      const rt = $("tts-reference-text");
      if (rt && rt.value.trim()) req.reference_text = rt.value.trim();
    } else if (state.ttsVariant === "custom_voice") {
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
      voiceRefMode = state.breezeMode === "voice_clone" ? "required" : "none";
    }
    if (voiceRefMode && voiceRefMode !== "none") {
      const v = state.voicePicker.getValue();
      if (voiceRefMode === "required" && !v) { msg.textContent = t("tts.errNoVoice"); return; }
      if (v) req.voice_ref = v;
    }
    // VibeVoice 多说话人：音色按行序拼成 voice_samples，中间不能有空洞
    // （引擎按下标映射 Speaker 编号，空洞会导致映射错位）
    if (m.family === "vibevoice") {
      const vals = state.speakerPickers.map(sp => sp.picker.getValue());
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
    if (rt && rt.value.trim() && (m.family !== "breeze_tts" || state.breezeMode === "voice_clone")) {
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
      if (state.breezeMode === "voice_design" && !value) {
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
    if (state.emotionMode === "emotion_audio") {
      const v = state.emotionPicker.getValue();
      if (!v) { msg.textContent = t("tts.errNoEmotionAudio"); return; }
      req.audio = v;
    } else if (state.emotionMode === "emotion_vector") {
      opts.emotion_vector = state.emotionVector.slice();
      opts.use_random_emotion = false;
    } else if (state.emotionMode === "emotion_text") {
      opts.use_emotion_text = true;
      const emoText = $("tts-emotion-text").value.trim();
      if (emoText) opts.emotion_text = emoText;
    }
    if (state.emotionMode !== "none") {
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
document.querySelectorAll("#tts-emotion-block .tab").forEach(tab => {
  tab.onclick = () => {
    state.emotionMode = tab.dataset.mode;
    document.querySelectorAll("#tts-emotion-block .tab").forEach(tb => {
      const on = tb === tab;
      tb.classList.toggle("active", on);
      tb.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll("#tts-emotion-block .emotion-pane").forEach(p => p.classList.add("hidden"));
    $("emotion-pane-" + state.emotionMode).classList.remove("hidden");
    $("emotion-alpha-row").classList.toggle("hidden", state.emotionMode === "none");
  };
});

export function buildEmotionSliders() {
  const container = $("emotion-sliders");
  container.innerHTML = "";
  t("emotion.labels").forEach((label, i) => {
    const row = document.createElement("div");
    row.className = "slider-row";
    row.innerHTML = `<span class="slider-label">${esc(label)}</span>
      <input type="range" min="0" max="1" step="0.05" value="0" data-idx="${i}" aria-label="${esc(label)}">
      <span class="slider-val" id="emotion-val-${i}">0.00</span>`;
    container.appendChild(row);
  });
  container.oninput = (e) => {
    const idx = parseInt(e.target.dataset.idx, 10);
    state.emotionVector[idx] = parseFloat(e.target.value);
    $("emotion-val-" + idx).textContent = state.emotionVector[idx].toFixed(2);
  };
}

$("tts-emotion-alpha").addEventListener("input", (e) => {
  $("emotion-alpha-val").textContent = parseFloat(e.target.value).toFixed(2);
});

/* ---------- 历史记录回填 TTS 表单 ---------- */
export function fillTtsForm(m, rec) {
  $("tts-text").value = rec.text || "";
  if (rec.language && state.ttsLanguageSel &&
      [...state.ttsLanguageSel.options].some(o => o.value === rec.language)) {
    state.ttsLanguageSel.value = rec.language;
  }

  const voice = rec.voice || { kind: "default" };
  if (m.family === "breeze_tts") {
    state.breezeMode = voice.kind === "voice_ref" ? "voice_clone" : "voice_design";
    const modeSel = $("tts-breeze-mode");
    if (modeSel) modeSel.value = state.breezeMode;
    updateTtsBlocks(m);
  }
  if (m.family === "qwen3_tts") {
    // 变体由模型条目决定（拆分后三个独立模型），历史声音来源与变体一一对应
    state.ttsVariant = qwen3VariantOf(m.id);
    updateTtsBlocks(m);
    if (voice.kind === "speaker" && voice.speaker) {
      const spk = $("tts-spk-speaker");
      if (spk) spk.value = voice.speaker;
    }
  }
  if (voice.kind === "voice_ref" && voice.voiceRef) {
    // voice_ref 是服务器路径：VoiceSelect 用 setByPath 载入（库外路径走「外部路径」兜底）
    state.voicePicker.setByPath(historyRefPath(m, rec, "ref") || voice.voiceRef);
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
      const sp = state.speakerPickers[x.id + shift - 1];
      if (sp) sp.linesTa.value = (sp.linesTa.value ? sp.linesTa.value + "\n" : "") + x.text;
    }
    if (!lines.length && rec.text && state.speakerPickers[0]) state.speakerPickers[0].linesTa.value = rec.text;
  }
}

/* options 里的参数填回 paramSchema 渲染的控件：高级参数网格（adv- 前缀）+ 枚举行 */
function applyHistoryOptions(m, options) {
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
