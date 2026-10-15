#!/usr/bin/env node
/** Dependency-free, permutation-invariant RTTM diarization scoring.
 * Independent of any model. Times are seconds; spans are half-open.
 * Overlap included, no collar by default. Zero-reference DER is null, not zero.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function valid(x) {
  return Number.isFinite(x) && x >= 0;
}

export function parseRttm(text, recording) {
  const rows = [];
  for (const [i, source] of String(text).split(/\r?\n/).entries()) {
    const line = source.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    if (fields.length !== 10 || fields[0] !== "SPEAKER") {
      throw new Error(`RTTM line ${i + 1}: expected SPEAKER and 10 fields`);
    }
    if (recording && fields[1] !== recording) {
      throw new Error(`RTTM line ${i + 1}: expected recording ${recording}`);
    }
    const start = Number(fields[3]);
    const duration = Number(fields[4]);
    const speaker = fields[7];
    if (
      !valid(start) ||
      !(duration > 0) ||
      !Number.isFinite(duration) ||
      !speaker ||
      speaker === "<NA>"
    ) {
      throw new Error(`RTTM line ${i + 1}: invalid time or speaker`);
    }
    rows.push({ start, end: start + duration, speaker });
  }
  return rows.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function turnsToSegments(value, rateOverride) {
  const turns = Array.isArray(value) ? value : value?.speaker_turns;
  const rate = rateOverride ?? value?.sample_rate;
  if (!Array.isArray(turns) || !Number.isSafeInteger(rate) || rate <= 0) {
    throw new Error("Expected speaker_turns and a positive integer sample_rate");
  }
  return turns.map((turn, i) => {
    const a = turn?.start_sample;
    const b = turn?.end_sample;
    const speaker = turn?.speaker_id;
    if (
      !Number.isSafeInteger(a) ||
      !Number.isSafeInteger(b) ||
      a < 0 ||
      b <= a ||
      !(
        (typeof speaker === "string" && speaker.length > 0 && speaker.length <= 128) ||
        (Number.isSafeInteger(speaker) && speaker >= 0)
      )
    ) {
      throw new Error(`Turn ${i + 1}: invalid samples or speaker_id`);
    }
    return { start: a / rate, end: b / rate, speaker: String(speaker) };
  });
}

function normalizedSegments(rows, duration) {
  if (!Array.isArray(rows)) throw new Error("Segments must be an array");
  return rows.map((row) => {
    const { start, end, speaker } = row;
    if (
      !valid(start) ||
      !Number.isFinite(end) ||
      end <= start ||
      (duration !== undefined && end > duration + 1e-7) ||
      !speaker ||
      typeof speaker !== "string"
    ) {
      throw new Error("Invalid segment or segment exceeds recording duration");
    }
    return { start, end, speaker };
  });
}

function bestMapping(refIds, hypIds, weights) {
  if (refIds.length > 4 || hypIds.length > 4) {
    throw new Error("Four-speaker score limit exceeded");
  }
  let highest = -1;
  let winner = {};
  function search(index, assigned, map, total) {
    if (index === hypIds.length) {
      if (total > highest) {
        highest = total;
        winner = { ...map };
      }
      return;
    }
    const id = hypIds[index];
    // A model speaker can be unmatched if it is a false alarm or a split.
    search(index + 1, assigned, map, total);
    for (const ref of refIds) {
      if (assigned.has(ref)) continue;
      map[id] = ref;
      assigned.add(ref);
      search(index + 1, assigned, map, total + (weights[id]?.[ref] ?? 0));
      assigned.delete(ref);
      delete map[id];
    }
  }
  search(0, new Set(), Object.create(null), 0);
  return winner;
}

export function scoreSegments(reference, hypothesis, options = {}) {
  const all = [...reference, ...hypothesis];
  const inferredDuration = Math.max(0, ...all.map((s) => s.end));
  const duration = options.duration ?? inferredDuration;
  if (!valid(duration)) throw new Error("Recording duration must be finite and nonnegative");
  const refs = normalizedSegments(reference, duration);
  const hyps = normalizedSegments(hypothesis, duration);
  const refIds = [...new Set(refs.map((s) => s.speaker))].sort();
  const hypIds = [...new Set(hyps.map((s) => s.speaker))].sort();
  const boundary = [...new Set([0, duration, ...all.flatMap((s) => [s.start, s.end])])].sort(
    (a, b) => a - b
  );
  const pieces = [];
  // Speaker labels are data, not object property names: do not inherit
  // constructor / toString or interpret __proto__ as a prototype setter.
  const weights = Object.fromEntries(hypIds.map((h) => [h, Object.create(null)]));
  for (let i = 1; i < boundary.length; i++) {
    const dt = boundary[i] - boundary[i - 1];
    if (dt <= 0) continue;
    const midpoint = (boundary[i] + boundary[i - 1]) / 2;
    const activeRef = new Set(
      refs.filter((r) => r.start <= midpoint && r.end > midpoint).map((r) => r.speaker)
    );
    const activeHyp = new Set(
      hyps.filter((r) => r.start <= midpoint && r.end > midpoint).map((r) => r.speaker)
    );
    for (const h of activeHyp) {
      for (const r of activeRef) weights[h][r] = (weights[h][r] ?? 0) + dt;
    }
    pieces.push({ dt, activeRef, activeHyp });
  }
  const mapping = bestMapping(refIds, hypIds, weights);
  let referenceSpeechSeconds = 0;
  let missedSeconds = 0;
  let falseAlarmSeconds = 0;
  let confusionSeconds = 0;
  for (const { dt, activeRef, activeHyp } of pieces) {
    const nRef = activeRef.size;
    const nHyp = activeHyp.size;
    const correct = [...activeHyp].filter((h) => activeRef.has(mapping[h])).length;
    referenceSpeechSeconds += nRef * dt;
    missedSeconds += Math.max(0, nRef - nHyp) * dt;
    falseAlarmSeconds += Math.max(0, nHyp - nRef) * dt;
    confusionSeconds += (Math.min(nRef, nHyp) - correct) * dt;
  }
  const numerator = missedSeconds + falseAlarmSeconds + confusionSeconds;
  const precision = (n) => Number(n.toFixed(8));
  return {
    recordingDurationSeconds: precision(duration),
    referenceSpeakers: refIds.length,
    hypothesisSpeakers: hypIds.length,
    speakerMapping: mapping,
    scoringPolicy: {
      collarSeconds: 0,
      overlappingSpeechIncluded: true,
      denominator: "reference speaker-seconds"
    },
    referenceSpeechSeconds: precision(referenceSpeechSeconds),
    missedSeconds: precision(missedSeconds),
    falseAlarmSeconds: precision(falseAlarmSeconds),
    confusionSeconds: precision(confusionSeconds),
    totalErrorSeconds: precision(numerator),
    der: referenceSpeechSeconds > 0 ? numerator / referenceSpeechSeconds : null,
    emptyReference: referenceSpeechSeconds === 0
  };
}

function main(args) {
  const cfg = {};
  const allowed = new Set([
    "--ref",
    "--hyp",
    "--hyp-json",
    "--recording",
    "--duration",
    "--sample-rate"
  ]);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!allowed.has(flag)) throw new Error(`Unknown option: ${flag}`);
    if (i + 1 >= args.length || !args[i + 1] || args[i + 1].startsWith("--")) {
      throw new Error(`Missing argument for ${flag}`);
    }
    const name = flag.slice(2);
    if (Object.hasOwn(cfg, name)) throw new Error(`Duplicate option: ${flag}`);
    cfg[name] = args[++i];
  }
  if (
    cfg.duration !== undefined &&
    (!Number.isFinite(Number(cfg.duration)) || Number(cfg.duration) <= 0)
  ) {
    throw new Error("--duration must be a positive finite number of seconds");
  }
  if (
    cfg["sample-rate"] !== undefined &&
    (!Number.isSafeInteger(Number(cfg["sample-rate"])) || Number(cfg["sample-rate"]) <= 0)
  ) {
    throw new Error("--sample-rate must be a positive integer");
  }
  if (!cfg.ref || !(cfg.hyp || cfg["hyp-json"]) || !!cfg.hyp === !!cfg["hyp-json"]) {
    throw new Error(
      "Usage: node scripts/score-diarization-rttm.mjs --ref case.rttm --hyp prediction.rttm [--recording ID] [--duration seconds] OR --hyp-json raw-turns.json --sample-rate 16000"
    );
  }
  const ref = parseRttm(readFileSync(cfg.ref, "utf8"), cfg.recording);
  const hyp = cfg["hyp-json"]
    ? turnsToSegments(
        JSON.parse(readFileSync(cfg["hyp-json"], "utf8")),
        cfg["sample-rate"] === undefined ? undefined : Number(cfg["sample-rate"])
      )
    : parseRttm(readFileSync(cfg.hyp, "utf8"), cfg.recording);
  const score = scoreSegments(ref, hyp, {
    duration: cfg.duration === undefined ? undefined : Number(cfg.duration)
  });
  process.stdout.write(JSON.stringify(score, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`RTTM score failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
