import { test } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert";
import { normalizeSpeakerTurns } from "../../web/modules/speaker-segments.js";

test("speaker turns normalize sample offsets, sort out-of-order data and preserve overlaps", () => {
  const input = {
    sample_rate: 16000,
    speaker_turns: [
      { speaker_id: "speaker_2", start_sample: 32000, end_sample: 48000 },
      { speaker_id: 0, start_sample: 0, end_sample: 32000, text: "Hi", confidence: 0.8 },
      { speaker_id: 1, start_sample: 16000, end_sample: 40000, text: "Overlapping" }
    ]
  };
  const result = normalizeSpeakerTurns(input);
  strictEqual(result.status, "ok");
  deepStrictEqual(result.segments, [
    { start: 0, end: 2, speakerId: "0", text: "Hi", confidence: 0.8 },
    { start: 1, end: 2.5, speakerId: "1", text: "Overlapping" },
    { start: 2, end: 3, speakerId: "speaker_2", text: null }
  ]);
});

test("invalid times and speaker assignments are dropped, not fabricated", () => {
  const result = normalizeSpeakerTurns({
    sample_rate: 48000,
    speaker_turns: [
      { speaker_id: 0, start_sample: 0, end_sample: 0, confidence: -1 },
      { speaker_id: null, start_sample: 0, end_sample: 100 },
      { speaker_id: 1, start_sample: -1, end_sample: 100 },
      { speaker_id: 2, start_sample: 100, end_sample: 90 },
      { speaker_id: 3, start_sample: NaN, end_sample: 90 },
      { speaker_id: 4, start_sample: 0.5, end_sample: 90 },
      { speaker_id: 5, start_sample: 0, end_sample: Infinity }
    ]
  });
  deepStrictEqual(result.segments, [{ start: 0, end: 0, speakerId: "0", text: null }]);
});

test("missing units, unsupported responses and invalid speaker turns are explicit", () => {
  strictEqual(normalizeSpeakerTurns({ speaker_turns: [] }).status, "ok");
  strictEqual(
    normalizeSpeakerTurns({
      sample_rate: 0,
      speaker_turns: [{ speaker_id: 0, start_sample: 0, end_sample: 10 }]
    }).status,
    "missing_sample_rate"
  );
  strictEqual(
    normalizeSpeakerTurns({ sample_rate: 16000, text: "Only ASR" }).status,
    "unsupported"
  );
  strictEqual(normalizeSpeakerTurns({ sample_rate: 16000, speaker_turns: [] }).status, "ok");
  strictEqual(
    normalizeSpeakerTurns({ sample_rate: 16000, speaker_turns: [{ start_sample: 0 }] }).status,
    "invalid_segments"
  );
});

test("four speakers and rapid repeat turns retain recording-local IDs", () => {
  const raw = {
    sample_rate: 16000,
    speaker_turns: [
      { speaker_id: "speaker_3", start_sample: 9600, end_sample: 14400 },
      { speaker_id: "speaker_0", start_sample: 0, end_sample: 3200 },
      { speaker_id: "speaker_1", start_sample: 3200, end_sample: 6400 },
      { speaker_id: "speaker_2", start_sample: 6400, end_sample: 9600 },
      { speaker_id: "speaker_0", start_sample: 14400, end_sample: 17600 }
    ]
  };
  const result = normalizeSpeakerTurns(raw);
  strictEqual(result.status, "ok");
  deepStrictEqual(
    result.segments.map((s) => s.speakerId),
    ["speaker_0", "speaker_1", "speaker_2", "speaker_3", "speaker_0"]
  );
  deepStrictEqual(
    result.segments.map((s) => s.start),
    [0, 0.2, 0.4, 0.6, 0.9]
  );
});
