/* Speaker turns from a real provider, never inferred from transcript text. */
import { $, t } from "./dom.js";

function formatTime(seconds) {
  const tenths = Math.round(seconds * 10);
  const minutes = Math.floor(tenths / 600);
  return minutes + ":" + ((tenths % 600) / 10).toFixed(1).padStart(4, "0");
}

export function renderSpeakerTurns(normalized) {
  const container = $("asr-speaker-turns");
  const panel = $("asr-speaker-timeline");
  container.replaceChildren();
  for (const turn of normalized.segments) {
    const item = document.createElement("li");
    item.className = "history-row";
    const head = document.createElement("div");
    head.className = "history-info";
    const label = document.createElement("span");
    label.className = "history-text";
    label.textContent = t("asr.speaker", { id: turn.speakerId });
    const time = document.createElement("span");
    time.className = "history-meta";
    time.textContent = formatTime(turn.start) + " – " + formatTime(turn.end);
    head.append(label, time);
    item.appendChild(head);
    if (turn.text) {
      const words = document.createElement("p");
      words.className = "history-text";
      words.textContent = turn.text;
      item.appendChild(words);
    }
    container.appendChild(item);
  }
  panel.classList.toggle("hidden", !normalized.segments.length);
}

export async function renderAsrResult(json, { diarizationOnly = false } = {}) {
  const { normalizeSpeakerTurns } = await import("./speaker-segments.js");
  $("asr-text").textContent = json.text || t(diarizationOnly ? "asr.speakerOnly" : "asr.noText");
  const normalized = normalizeSpeakerTurns(json);
  renderSpeakerTurns(normalized);
  const notice = $("asr-diar-status");
  const key = normalized.status === "missing_sample_rate" ? "asr.diarMissingRate"
    : normalized.status === "unsupported" ? "asr.diarUnavailable"
    : normalized.status === "invalid_segments" ? "asr.diarInvalid"
    : normalized.segments.length === 0 ? "asr.diarNoSpeakers" : null;
  notice.textContent = diarizationOnly && key ? t(key) : "";
  notice.classList.toggle("hidden", !diarizationOnly || !key);
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
