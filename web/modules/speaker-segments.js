/* Normalize model-emitted speaker turns for display/export without inventing attribution. */
export function normalizeSpeakerTurns(raw) {
  if (!Array.isArray(raw?.speaker_turns)) {
    return { status: "unsupported", segments: [] };
  }
  if (raw.speaker_turns.length === 0) {
    return { status: "ok", segments: [] };
  }
  const rate = raw.sample_rate;
  if (!Number.isSafeInteger(rate) || rate <= 0) {
    return { status: "missing_sample_rate", segments: [] };
  }
  const segments = [];
  for (const turn of raw.speaker_turns) {
    if (!turn || typeof turn !== "object" || Array.isArray(turn)) continue;
    const { start_sample: start, end_sample: end, speaker_id: id } = turn;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || end < start) continue;
    if (!((typeof id === "string" && id.length > 0 && id.length <= 128) ||
          (typeof id === "number" && Number.isSafeInteger(id) && id >= 0))) continue;
    const segment = {
      start: start / rate,
      end: end / rate,
      speakerId: String(id),
      text: typeof turn.text === "string" ? turn.text : null
    };
    if (typeof turn.confidence === "number" && Number.isFinite(turn.confidence) &&
        turn.confidence >= 0 && turn.confidence <= 1) {
      segment.confidence = turn.confidence;
    }
    segments.push(segment);
  }
  // Keep ties/overlaps intact while ensuring readable timeline order.
  segments.sort((a, b) => a.start - b.start || a.end - b.end);
  return {
    status: raw.speaker_turns.length > 0 && segments.length === 0
      ? "invalid_segments" : "ok",
    segments
  };
}
