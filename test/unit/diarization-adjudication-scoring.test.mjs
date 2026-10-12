// Synthetic scoring expectations for human-adjudicated overlap/boundaries.
// No fixture WAVs, model process, network, or inference.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseRttm, scoreSegments
} from "../../scripts/score-diarization-rttm.mjs";

test("RTTM half-open 50ms boundary difference incurs error (zero collar)", () => {
  const reference = parseRttm("SPEAKER test 1 0.000 1.000 <NA> <NA> spk_01 <NA> <NA>\n", "test");
  const hypothesis = parseRttm("SPEAKER test 1 0.050 0.950 <NA> <NA> model_A <NA> <NA>\n", "test");
  const score = scoreSegments(reference, hypothesis, { duration: 2 });
  assert.ok(Math.abs(score.missedSeconds - 0.05) < 1e-9);
  assert.ok(Math.abs(score.der - 0.05) < 1e-9);
});

test("overlap collapse is a miss, not a speaker permutation", () => {
  const ref = [
    { start: 0, end: 3, speaker: "spk_01" },
    { start: 1, end: 2, speaker: "spk_02" }
  ];
  const hyp = [{ start: 0, end: 3, speaker: "model_A" }];
  const score = scoreSegments(ref, hyp, { duration: 4 });
  assert.equal(score.referenceSpeechSeconds, 4);
  assert.equal(score.missedSeconds, 1);
  assert.equal(score.der, 0.25);
});

test("swapped globally consistent labels preserve adjudicated overlap", () => {
  const ref = [
    { start: 0, end: 2, speaker: "spk_01" },
    { start: 1, end: 3, speaker: "spk_02" }
  ];
  const hyp = [
    { start: 0, end: 2, speaker: "model_Y" },
    { start: 1, end: 3, speaker: "model_X" }
  ];
  const score = scoreSegments(ref, hyp, { duration: 4 });
  assert.equal(score.referenceSpeechSeconds, 4);
  assert.equal(score.totalErrorSeconds, 0);
  assert.equal(score.der, 0);
});

test("empty review remains undefined DER even with a synthetic false alarm", () => {
  const score = scoreSegments([], [{start: 2, end: 3, speaker: "model_X"}], {duration: 6});
  assert.equal(score.emptyReference, true);
  assert.equal(score.der, null);
  assert.equal(score.falseAlarmSeconds, 1);
});
