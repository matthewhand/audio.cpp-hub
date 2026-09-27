#!/usr/bin/env node
/*
 * tsc-ratchet.mjs — dev/CI-only TypeScript ratchet for the no-build web/ frontend.
 *
 * The web/ scripts are plain browser JS (no build step, Node never runs at
 * runtime). This script lets `tsc --checkJs` be enforced incrementally:
 *   - it runs the local `tsc`,
 *   - counts the reported type errors,
 *   - compares against the ceiling stored in tsc-ratchet-baseline.txt,
 *   - exits non-zero only if the count EXCEEDS the baseline.
 *
 * So the count may go down (ratchet tightens) but never up. To record an
 * intentional improvement (or a deliberate, reviewed increase) run:
 *   node scripts/web-quality/tsc-ratchet.mjs --update
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const baselineFile = path.join(root, "tsc-ratchet-baseline.txt");
const tscBin = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsc.cmd" : "tsc",
);

if (!existsSync(tscBin)) {
  console.error(
    "[tsc-ratchet] local tsc not found — run `npm install` first " + `(expected ${tscBin}).`,
  );
  process.exit(1);
}

const result = spawnSync(tscBin, ["--noEmit", "--pretty", "false"], {
  cwd: root,
  encoding: "utf8",
});

if (result.error) {
  console.error(`[tsc-ratchet] failed to run tsc: ${result.error.message}`);
  process.exit(1);
}

const output = `${result.stdout || ""}\n${result.stderr || ""}`;
const matches = output.match(/error TS\d+:/g) || [];
const count = matches.length;

if (process.argv.includes("--update")) {
  writeFileSync(baselineFile, `${count}\n`);
  console.log(`[tsc-ratchet] baseline updated to ${count} type error(s).`);
  process.exit(0);
}

if (!existsSync(baselineFile)) {
  console.error(
    `[tsc-ratchet] baseline file missing (${path.relative(root, baselineFile)}). ` +
      "Create it with `node scripts/web-quality/tsc-ratchet.mjs --update`.",
  );
  process.exit(1);
}

const rawBaseline = readFileSync(baselineFile, "utf8").trim();
const baselineMatch = rawBaseline.match(/\d+/);
if (!baselineMatch) {
  console.error(`[tsc-ratchet] baseline file has no count: ${path.relative(root, baselineFile)}`);
  process.exit(1);
}
const baseline = Number(baselineMatch[0]);

if (count > baseline) {
  console.error(
    `[tsc-ratchet] type error count ${count} exceeds baseline ${baseline} ` +
      `(+${count - baseline}).\n` +
      "Fix the new errors, or, if the increase is intentional and reviewed, " +
      "run `node scripts/web-quality/tsc-ratchet.mjs --update`.",
  );
  process.exit(1);
}

console.log(
  `[tsc-ratchet] type error count ${count} <= baseline ${baseline} — OK` +
    (count < baseline ? " (consider tightening the baseline)." : "."),
);
process.exit(0);
