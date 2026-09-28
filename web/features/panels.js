/* ASR / 音频分离 / YuE2 音乐生成 / 其它工具面板：渲染、提交与结果展示。
   结果里的 base64 wav 统一转 objectURL 行，并负责回收避免内存泄漏。 */
import { $, el } from "../core/dom.js";
import { I18N, t } from "../core/i18n.js";
import { state, selectedModel } from "../core/state.js";
import {
  buildLanguageRow,
  renderAdvancedGrid,
  collectParams,
  paramInput,
  RESERVED_KEYS,
} from "./params.js";
import { submitTask, trackTask } from "./tasks.js";

/* ---------- 结果通用：base64 → Blob / 轨道行 / 容器清理 ---------- */
function b64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function makeTrackRow(name, b64) {
  const url = URL.createObjectURL(b64ToBlob(b64, "audio/wav"));
  const row = el(`<div class="track-row">
    <span class="track-name"></span>
    <audio controls preload="auto"></audio>
    <a class="btn-ghost"></a>
  </div>`);
  row.dataset.blobUrl = url;
  row.querySelector(".track-name").textContent = name;
  row.querySelector("audio").setAttribute("aria-label", name);
  row.querySelector("audio").src = url;
  const a = row.querySelector("a");
  a.textContent = t("common.download");
  a.href = url;
  a.download = name + ".wav";
  return row;
}

/* 清空结果容器前回收其中 track-row 的 objectURL，避免内存泄漏 */
export function clearResult(container) {
  for (const row of container.querySelectorAll(".track-row[data-blob-url]")) {
    URL.revokeObjectURL(row.dataset.blobUrl);
  }
  container.innerHTML = "";
}

/* ---------- ASR 面板 ---------- */
export function renderAsrPanel(m) {
  $("asr-title").textContent = t("asr.title") + " — " + I18N.pick(m, "displayName");
  state.asrLanguageSel = buildLanguageRow($("asr-language-row"), m, "asr");
  const textRow = $("asr-text-row");
  textRow.innerHTML = "";
  if (m.inputs && m.inputs.text === "optional") {
    textRow.appendChild(
      el(
        `<label>${t("asr.contextLabel")}<textarea id="asr-text-input" rows="2" placeholder="${t("asr.contextPlaceholder")}"></textarea></label>`,
      ),
    );
  }
  const hasAdvanced = renderAdvancedGrid($("asr-advanced-grid"), m, "asr-adv");
  $("asr-advanced").classList.toggle("hidden", !hasAdvanced);
  $("asr-result").classList.add("hidden");
  $("asr-msg").textContent = "";
  $("asr-stats").textContent = "";
}

/* ASR 结果渲染（任务完成后由 renderTaskResult 调用） */
export function renderAsrResult(json) {
  $("asr-text").textContent = json.text || t("asr.noText");
  const details = {};
  for (const k of ["language", "words", "segments", "speaker_turns", "timing"]) {
    if (json[k] !== undefined) details[k] = json[k];
  }
  const det = $("asr-json-details");
  if (Object.keys(details).length > 0) {
    $("asr-json").textContent = JSON.stringify(details, null, 2);
    det.classList.remove("hidden");
  } else {
    det.classList.add("hidden");
  }
  $("asr-result").classList.remove("hidden");
}

$("asr-submit").onclick = async () => {
  const m = selectedModel();
  const msg = $("asr-msg");
  msg.textContent = "";
  $("asr-result").classList.add("hidden");
  if (!state.activeInstanceId) {
    msg.textContent = t("instance.noReady");
    return;
  }

  const audio = state.asrAudioPicker.getValue();
  if (!audio) {
    msg.textContent = t("asr.errNoAudio");
    return;
  }

  const req = { audio };
  if (state.asrLanguageSel && state.asrLanguageSel.value) req.language = state.asrLanguageSel.value;
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
  setTimeout(() => {
    $("asr-copy").textContent = t("asr.copy");
  }, 1500);
};

/* ---------- SEP 面板 ---------- */
export function renderSepPanel(m) {
  $("sep-title").textContent = t("sep.title") + " — " + I18N.pick(m, "displayName");
  clearResult($("sep-result"));
  $("sep-msg").textContent = "";
  $("sep-stats").textContent = "";
}

/* SEP 结果渲染（任务完成后由 renderTaskResult 调用） */
export function renderSepResult(json) {
  const result = $("sep-result");
  // 重渲染前先回收上一轮的 objectURL，避免重复行与内存泄漏
  clearResult(result);
  if (json.named_audio_outputs && json.named_audio_outputs.length > 0) {
    for (const track of json.named_audio_outputs) {
      result.appendChild(makeTrackRow(track.id, track.audio));
    }
  } else if (json.audio) {
    result.appendChild(makeTrackRow("output", json.audio));
  } else {
    $("sep-msg").textContent = t("sep.noTracks") + JSON.stringify(json).substring(0, 300);
  }
}

$("sep-submit").onclick = async () => {
  const msg = $("sep-msg");
  msg.textContent = "";
  clearResult($("sep-result"));
  if (!state.activeInstanceId) {
    msg.textContent = t("instance.noReady");
    return;
  }

  const audio = state.sepAudioPicker.getValue();
  if (!audio) {
    msg.textContent = t("sep.errNoAudio");
    return;
  }

  // 异步任务：提交即返回，进度/结果由 trackTask 轮询处理
  $("sep-stats").textContent = "";
  try {
    trackTask(await submitTask({ audio }));
  } catch (e) {
    msg.textContent = e.message;
  }
};

/* ---------- YuE2 音乐生成面板 ---------- */
/* 单首歌耗时数分钟：请求携带较长的空闲等待超时，避免引擎锁排队时收到 503 server_busy
   （实际生效值受服务端配置上限钳制）。采样参数（abc_* / semantic_*）走通用高级参数网格。 */
const YUE2_BUSY_TIMEOUT_MS = 900000;

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
  if (!state.activeInstanceId) {
    msg.textContent = t("instance.noReady");
    return;
  }

  const style = $("music-style").value.trim();
  const lyrics = $("music-lyrics").value.trim();
  const cot = $("music-cot").value;
  const abc = $("music-abc").value.trim();
  if (!style) {
    msg.textContent = t("music.errNoStyle");
    return;
  }
  if (!lyrics) {
    msg.textContent = t("music.errNoLyrics");
    return;
  }
  if (abc && cot === "off") {
    msg.textContent = t("music.errAbcCot");
    return;
  }

  // yue2 全部专属参数放 options；text 既作任务记录预览，也是引擎的歌词回退通道
  const options = { style, lyrics, cot };
  if (abc) options.abc = abc;
  const req = {
    text: lyrics,
    lyrics: lyrics,
    options,
    busy_timeout_ms: YUE2_BUSY_TIMEOUT_MS,
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

/* 音乐结果：JSON 含 base64 wav 与 timing（wall_ms / audio_duration_ms / rtf） */
export function renderMusicResult(json) {
  const out = $("music-result");
  clearResult(out);
  if (json.audio) {
    out.appendChild(makeTrackRow("music", json.audio));
    const timing = json.timing;
    if (timing) {
      const line = el(`<div class="hint music-timing"></div>`);
      line.textContent = t("music.timingLine", {
        wall: ((timing.wall_ms || 0) / 1000).toFixed(1) + "s",
        dur: ((timing.audio_duration_ms || 0) / 1000).toFixed(1) + "s",
        rtf: timing.rtf != null ? Number(timing.rtf).toFixed(2) : "?",
      });
      out.appendChild(line);
    }
  } else {
    $("music-msg").textContent = t("music.noAudio") + JSON.stringify(json).substring(0, 300);
  }
}

/* ---------- OTHER 面板 ---------- */
export function renderOtherPanel(m) {
  $("other-title").textContent = I18N.pick(m, "displayName");
  const inputs = m.inputs || { text: "none", audio: "none", voiceRef: "none" };

  const textRow = $("other-text-row");
  textRow.innerHTML = "";
  if (inputs.text !== "none") {
    textRow.appendChild(
      el(
        `<label>${t("other.textLabel")}${inputs.text === "required" ? t("common.required") : t("common.optionalSuffix")}<textarea id="other-text-input" rows="3"></textarea></label>`,
      ),
    );
  }
  $("other-audio-block").classList.toggle("hidden", inputs.audio === "none");
  $("other-voice-block").classList.toggle("hidden", inputs.voiceRef === "none");
  state.otherLanguageSel = buildLanguageRow($("other-language-row"), m, "other");

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
  if (!state.activeInstanceId) {
    msg.textContent = t("instance.noReady");
    return;
  }
  const inputs = m.inputs || { text: "none", audio: "none", voiceRef: "none" };

  const req = {};
  if (inputs.text !== "none") {
    const txt = $("other-text-input").value.trim();
    if (inputs.text === "required" && !txt) {
      msg.textContent = t("other.errNoText");
      return;
    }
    if (txt) req.text = txt;
  }
  if (inputs.audio !== "none") {
    const v = state.otherAudioPicker.getValue();
    if (inputs.audio === "required" && !v) {
      msg.textContent = t("other.errNoAudio");
      return;
    }
    if (v) req.audio = v;
  }
  if (inputs.voiceRef !== "none") {
    const v = state.otherVoicePicker.getValue();
    if (inputs.voiceRef === "required" && !v) {
      msg.textContent = t("other.errNoVoice");
      return;
    }
    if (v) req.voice_ref = v;
  }
  if (state.otherLanguageSel && state.otherLanguageSel.value)
    req.language = state.otherLanguageSel.value;

  // paramSchema 字段：与 TTS/ASR 面板一致，放进 options 透传（服务端顶层只认白名单，
  // 如 stable_audio 的 negative_prompt 放顶层会被静默丢弃）；
  // RESERVED_KEYS（task_route 等）在服务端有顶层专有映射（task_route→options.route、路径解析等），保持顶层
  for (const [key, p] of Object.entries(m.paramSchema || {})) {
    if (!p || Array.isArray(p) || !p.type) continue;
    const input = $(`other-field-${key}`);
    if (!input) continue;
    const target = RESERVED_KEYS.has(key) ? req : req.options || (req.options = {});
    if (p.type === "boolean") {
      target[key] = input.checked;
      continue;
    }
    const v = String(input.value).trim();
    if (v === "") continue;
    target[key] =
      p.type === "string" || p.type === "enum"
        ? v
        : p.type === "integer"
          ? parseInt(v, 10)
          : parseFloat(v);
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

/* OTHER 结果渲染（任务完成后由 renderTaskResult 调用） */
export function renderOtherResult(json) {
  const out = $("other-result");
  // 同上：先清空并回收 objectURL，避免「载入」重复追加
  clearResult(out);
  if (json.named_audio_outputs && json.named_audio_outputs.length > 0) {
    for (const track of json.named_audio_outputs) {
      out.appendChild(makeTrackRow(track.id, track.audio));
    }
  }
  if (json.audio) {
    out.appendChild(makeTrackRow("output", json.audio));
  }
  // JSON 摘要（剔除巨大的 base64 字段）
  const summary = {};
  for (const [k, v] of Object.entries(json)) {
    if (k === "audio") continue;
    if (k === "named_audio_outputs") {
      summary[k] = v.map((tr) => ({
        id: tr.id,
        sample_rate: tr.sample_rate,
        channels: tr.channels,
      }));
      continue;
    }
    summary[k] = v;
  }
  if (Object.keys(summary).length > 0 || (!json.audio && !json.named_audio_outputs)) {
    const pre = el(`<pre class="json-pre"></pre>`);
    pre.textContent = JSON.stringify(summary, null, 2);
    out.appendChild(pre);
  }
}
