/* Optional ASR speaker-turn renderer. Loaded only for results with speaker turns. */
import { $, t } from "./dom.js";

/* Upstream timestamps are samples, not milliseconds. Never guess the sample rate. */
function formatSpeakerTime(sample, rate) {
  const tenths = Math.round((sample * 10) / rate);
  const minutes = Math.floor(tenths / 600);
  return minutes + ":" + ((tenths % 600) / 10).toFixed(1).padStart(4, "0");
}

export function renderSpeakerTurns(json) {
  const container = $("asr-speaker-turns");
  const panel = $("asr-speaker-timeline");
  container.replaceChildren();
  const rate = json.sample_rate;
  if (!Number.isSafeInteger(rate) || rate <= 0 || !Array.isArray(json.speaker_turns)) {
    panel.classList.add("hidden");
    return;
  }
  for (const turn of json.speaker_turns) {
    if (!turn || typeof turn !== "object") continue;
    const start = turn.start_sample;
    const end = turn.end_sample;
    const id = turn.speaker_id;
    const hasId = (typeof id === "string" && id.length > 0)
      || (typeof id === "number" && Number.isSafeInteger(id) && id >= 0);
    if (!hasId || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) continue;
    const item = document.createElement("li");
    const head = document.createElement("div");
    head.className = "history-info";
    const label = document.createElement("span");
    label.className = "history-text";
    label.textContent = t("asr.speaker", { id });
    const time = document.createElement("span");
    time.className = "history-meta";
    time.textContent = formatSpeakerTime(start, rate) + " – " + formatSpeakerTime(end, rate);
    head.append(label, time);
    item.className = "history-row";
    item.appendChild(head);
    if (typeof turn.text === "string" && turn.text.length > 0) {
      const words = document.createElement("p");
      words.className = "history-text";
      words.textContent = turn.text;
      item.appendChild(words);
    }
    container.appendChild(item);
  }
  container.style.listStyle = "none";
  container.style.padding = "0";
  panel.classList.toggle("hidden", !container.childElementCount);
}

/* ASR 结果渲染（任务完成后由 renderTaskResult 调用） */
export async function renderAsrResult(json) {
  $("asr-text").textContent = json.text || t("asr.noText");
  const timeline = $("asr-speaker-timeline");
  timeline.classList.add("hidden");
  $("asr-speaker-turns").replaceChildren();
  if (Array.isArray(json.speaker_turns) && json.speaker_turns.length > 0) {
    const { renderSpeakerTurns } = await import("./diarization-lazy.js");
    renderSpeakerTurns(json);
  }
  const details = {};
  for (const k of ["language", "words", "segments", "speaker_turns", "sample_rate", "timing"]) {
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
