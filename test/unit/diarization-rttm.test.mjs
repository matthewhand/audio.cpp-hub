import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  parseRttm,
  scoreSegments,
  turnsToSegments
} from "../../scripts/score-diarization-rttm.mjs";

const directory = new URL("../fixtures/diarization/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", directory), "utf8"));
const cases = ["silence_0spk", "solo_1spk", "overlap_2spk", "overlap_4spk"];

test("all 0/1/2/4 speaker WAV files and RTTMs have recorded checksums and proper PCM headers", () => {
  assert.deepEqual(
    cases.map((c) => manifest.cases[c].speaker_count_scripted),
    [0, 1, 2, 4]
  );
  assert.equal(manifest.human_voice_identity_verified, false);
  assert.equal(manifest.phoneme_boundary_verified, false);
  assert.equal(manifest.source_audio_redistribution_rights_verified, false);
  for (const id of cases) {
    const spec = manifest.cases[id];
    const wav = readFileSync(new URL(`${id}.wav`, directory));
    const rttm = readFileSync(new URL(`${id}.rttm`, directory));
    assert.equal(createHash("sha256").update(wav).digest("hex"), spec.wav_sha256);
    assert.equal(createHash("sha256").update(rttm).digest("hex"), spec.rttm_sha256);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.toString("ascii", 8, 12), "WAVE");
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(wav.readUInt16LE(34), 16);
    const reference = parseRttm(rttm.toString(), id);
    assert.equal(new Set(reference.map((r) => r.speaker)).size, spec.speaker_count_scripted);
    assert.equal(reference.length, spec.tracks.length);
    for (const [index, track] of spec.tracks.entries()) {
      assert.equal(reference[index].speaker, track.speaker_id);
      assert.ok(Math.abs(reference[index].start - track.output_start_sample / 16000) < 1e-9);
      assert.ok(Math.abs(reference[index].end - track.output_end_sample / 16000) < 1e-9);
    }
    const score = scoreSegments(reference, reference, { duration: spec.duration_seconds });
    assert.equal(score.totalErrorSeconds, 0);
    assert.equal(score.der, reference.length ? 0 : null);
  }
});

test("0-speaker case does not misreport an undefined DER as perfect accuracy", () => {
  const zero = parseRttm(readFileSync(new URL("silence_0spk.rttm", directory), "utf8"));
  const score = scoreSegments(zero, [{ start: 2, end: 3, speaker: "model_A" }], { duration: 6 });
  assert.equal(score.der, null);
  assert.equal(score.falseAlarmSeconds, 1);
  assert.equal(score.referenceSpeechSeconds, 0);
  assert.equal(score.emptyReference, true);
});

test("speaker-label permutation does not incur an error, even with overlap", () => {
  const reference = parseRttm(readFileSync(new URL("overlap_4spk.rttm", directory), "utf8"));
  const predictions = reference.map((r) => ({
    ...r,
    speaker: { speaker_1: "Z", speaker_2: "Y", speaker_3: "X", speaker_4: "W" }[r.speaker]
  }));
  const score = scoreSegments(reference, predictions, { duration: 19 });
  assert.equal(score.der, 0);
  assert.equal(score.referenceSpeakers, 4);
  assert.equal(score.hypothesisSpeakers, 4);
});

test("missed speech contributes to miss count and DER", () => {
  const reference = [{ start: 0, end: 2, speaker: "ref" }];
  const hyp = [{ start: 0, end: 1, speaker: "model" }];
  const score = scoreSegments(reference, hyp, { duration: 3 });
  assert.equal(score.missedSeconds, 1);
  assert.equal(score.falseAlarmSeconds, 0);
  assert.equal(score.der, 0.5);
});

test("speech outside reference contributes false alarms", () => {
  const reference = [{ start: 0, end: 2, speaker: "ref" }];
  const hyp = [{ start: 0, end: 3, speaker: "model" }];
  const score = scoreSegments(reference, hyp, { duration: 3 });
  assert.equal(score.falseAlarmSeconds, 1);
  assert.equal(score.missedSeconds, 0);
  assert.equal(score.der, 0.5);
});

test("overlapping speech counts both active reference speakers", () => {
  const reference = [
    { start: 0, end: 2, speaker: "A" },
    { start: 0, end: 2, speaker: "B" }
  ];
  const hyp = [{ start: 0, end: 2, speaker: "prediction" }];
  const score = scoreSegments(reference, hyp, { duration: 3 });
  assert.equal(score.referenceSpeechSeconds, 4);
  assert.equal(score.missedSeconds, 2);
  assert.equal(score.der, 0.5);
});

test("speaker confusion is not hidden by a global label mapping", () => {
  const reference = [
    { start: 0, end: 1, speaker: "A" },
    { start: 1, end: 2, speaker: "B" }
  ];
  const prediction = [{ start: 0, end: 2, speaker: "X" }];
  const score = scoreSegments(reference, prediction, { duration: 2 });
  assert.equal(score.confusionSeconds, 1);
  assert.equal(score.missedSeconds, 0);
  assert.equal(score.der, 0.5);
});

test("RTTM scoring safely maps unusual speaker labels without prototype collisions", () => {
  const reference = [
    { start: 0, end: 1, speaker: "toString" },
    { start: 1, end: 2, speaker: "constructor" }
  ];
  const hypothesis = [
    { start: 0, end: 1, speaker: "__proto__" },
    { start: 1, end: 2, speaker: "hasOwnProperty" }
  ];
  const result = scoreSegments(reference, hypothesis, { duration: 2 });
  assert.equal(result.der, 0);
  assert.equal(result.confusionSeconds, 0);
  assert.equal(result.speakerMapping["__proto__"], "toString");
  assert.equal(result.speakerMapping.hasOwnProperty, "constructor");
});

test("native Sortformer bare JSON requires an explicit sample rate", () => {
  const native = [{ start_sample: 0, end_sample: 16000, speaker_id: "SPEAKER_00", confidence: 0 }];
  assert.throws(() => turnsToSegments(native), /sample_rate/);
  assert.deepEqual(turnsToSegments(native, 16000), [{ start: 0, end: 1, speaker: "SPEAKER_00" }]);
  assert.throws(
    () => turnsToSegments([{ ...native[0], end_sample: -1 }], 16000),
    /invalid samples/
  );
  assert.throws(
    () => turnsToSegments([{ ...native[0], speaker_id: -1 }], 16000),
    /invalid samples/
  );
});

test("RTTM rejects malformed or unlabeled entries instead of guessing", () => {
  assert.throws(() => parseRttm("SPEAKER x 1 0 -1 <NA> <NA> id <NA> <NA>"), /invalid/);
  assert.throws(() => parseRttm("SPEAKER x 1 0 1 <NA> <NA> <NA> <NA> <NA>"), /invalid/);
  assert.throws(() => parseRttm("SPEAKER x 1 0 1 <NA> <NA> id <NA> <NA>", "y"), /recording/);
  assert.throws(() => parseRttm("SPEAKER x 1 0 1"), /10 fields/);
});

test("a hypothesis beyond clip duration fails instead of being clipped", () => {
  assert.throws(
    () => scoreSegments([], [{ start: 0, end: 9, speaker: "A" }], { duration: 6 }),
    /exceeds/
  );
});

test("RTTM CLI rejects missing option values and duplicate flags without stack traces", () => {
  const tool = new URL("../../scripts/score-diarization-rttm.mjs", import.meta.url);
  for (const args of [
    ["--ref"],
    ["--ref", "--hyp", "recording.rttm"],
    ["--ref", "recording.rttm", "--ref", "again.rttm"],
    ["--ref", "recording.rttm", "--hyp", "estimate.rttm", "--duration", "Infinity"],
    ["--ref", "recording.rttm", "--hyp", "estimate.rttm", "--sample-rate", "-1"]
  ]) {
    const processResult = nodeSpawnSync(process.execPath, [tool.pathname, ...args], {
      encoding: "utf8",
      timeout: 4000
    });
    assert.equal(processResult.status, 1, `CLI unexpectedly accepted ${args.join(" ")}`);
    assert.match(processResult.stderr, /RTTM score failed: /);
    assert.doesNotMatch(processResult.stderr, /at node:|at file:/);
  }
});
