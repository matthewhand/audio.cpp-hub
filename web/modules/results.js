/* web/modules/results.js — 推理结果渲染
 *
 * ASR / 分离 / 音乐 / 其它四类结果与「已完成任务结果」的统一落版：
 * renderTaskResult 按任务类别分派到对应面板，其余是它们共用的
 * clearResult / makeTrackRow（多轨音频行）/ b64ToBlob。
 * 本模块不认识任务队列与面板表单，因此不会反向依赖它们。 */

import { $, el } from "./dom.js";
import { t } from "./i18n-bridge.js";

/* DONE 结果渲染：TTS 直接引用历史 wav URL（不碰 base64）；其余拉取 /result JSON 走原渲染分支 */
export async function renderTaskResult(task) {
  if (task.category === "tts") {
    const url = "/api/history/" + task.modelId + "/" + task.id + "/audio";
    $("tts-player").src = url;
    const download = $("tts-download");
    download.href = url;
    download.download = "tts-" + task.id + ".wav";
    $("tts-result").classList.remove("hidden");
    return;
  }
  try {
    const res = await fetch("/api/tasks/" + task.id + "/result");
    const text = await res.text();
    if (!res.ok) throw new Error(I18N.errText(text));
    const json = JSON.parse(text);
    if (task.category === "asr") renderAsrResult(json);
    else if (task.category === "sep") renderSepResult(json);
    else if (task.category === "music") renderMusicResult(json);
    else renderOtherResult(json);
  } catch (e) {
    const msg = $(task.category + "-msg");
    if (msg) msg.textContent = t("task.resultFailed") + t("common.colon") + e.message;
  }
}

export function b64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function makeTrackRow(name, b64) {
  const url = URL.createObjectURL(b64ToBlob(b64, "audio/wav"));
  const row = el(`<div class="track-row">
    <span class="track-name"></span>
    <audio controls preload="auto"></audio>
    <a class="btn-ghost"></a>
  </div>`);
  row.dataset.blobUrl = url;
  row.querySelector(".track-name").textContent = name;
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
        rtf: timing.rtf != null ? Number(timing.rtf).toFixed(2) : "?"
      });
      out.appendChild(line);
    }
  } else {
    $("music-msg").textContent = t("music.noAudio") + JSON.stringify(json).substring(0, 300);
  }
}

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
      summary[k] = v.map(tr => ({ id: tr.id, sample_rate: tr.sample_rate, channels: tr.channels }));
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
