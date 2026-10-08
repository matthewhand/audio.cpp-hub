/* 实例内存行的纯格式化：二进制单位，不足 1 GiB 用整数 MB，
   峰值/均值与当前值同单位时省略单位。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { extractFunction, readWeb } from "./helpers/vm.mjs";

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

function loadFormatters() {
  const src = readWeb("modules/instances.js");
  const bundle = [
    extractFunction(src, "formatMemBytes"),
    extractFunction(src, "formatMemCompanion"),
    extractFunction(src, "memoryCardLines")
  ].join("\n");
  const dict = {
    "instance.memRam": "RAM {cur} · peak {peak} · avg {avg}",
    "instance.memVram": "VRAM {cur} · peak {peak} · avg {avg}",
    "instance.memTipRam": "RAM {cur} / peak {peak} / avg {avg}",
    "instance.memTipVram": "VRAM {cur} / peak {peak} / avg {avg} ({source})",
    "instance.memTipMeta": "{n} samples · {state}",
    "instance.memSource.drm": "DRM fdinfo",
    "instance.memSource.nvidia-smi": "nvidia-smi",
    "instance.memSource.none": "unknown",
    "instance.memBusy": "generating",
    "instance.memIdle": "idle"
  };
  const t = (key, params) => {
    let s = dict[key] || key;
    for (const [k, v] of Object.entries(params || {})) s = s.split("{" + k + "}").join(String(v));
    return s;
  };
  const context = vm.createContext({ t });
  return new vm.Script(`${bundle}\n({ formatMemBytes, formatMemCompanion, memoryCardLines })`, {
    filename: "memory-format.js"
  }).runInContext(context);
}

const { formatMemBytes, formatMemCompanion, memoryCardLines } = loadFormatters();

test("formatMemBytes：MB under 1 GiB, one decimal GB at and above", () => {
  assert.equal(formatMemBytes(0.6 * GIB), "614 MB");
  assert.equal(formatMemBytes(GIB), "1.0 GB");
  assert.equal(formatMemBytes(3.6 * GIB), "3.6 GB");
  assert.equal(formatMemBytes(4.1 * GIB), "4.1 GB");
  assert.equal(formatMemBytes(512 * 1024), "512 KB");
  assert.equal(formatMemBytes(12), "12 B");
  assert.equal(formatMemBytes(-1), "");
  assert.equal(formatMemBytes(Number.NaN), "");
  assert.equal(formatMemBytes(undefined), "");
});

test("formatMemCompanion drops the unit when it matches current", () => {
  assert.equal(formatMemCompanion(4.1 * GIB, 3.6 * GIB), "4.1");
  assert.equal(formatMemCompanion(3.7 * GIB, 3.6 * GIB), "3.7");
  assert.equal(formatMemCompanion(1.5 * GIB, 700 * MIB), "1.5 GB");
  assert.equal(formatMemCompanion(-1, GIB), "");
});

test("memoryCardLines hides when memory is absent and omits VRAM when unknown", () => {
  assert.equal(memoryCardLines(null), null);
  assert.equal(memoryCardLines({}), null);
  const ramOnly = memoryCardLines({
    ramBytes: 0.6 * GIB,
    ramPeakBytes: GIB,
    ramAvgBytes: 700 * MIB,
    samples: 4,
    busy: false
  });
  assert.equal(ramOnly.ram, "RAM 614 MB · peak 1.0 GB · avg 700");
  assert.equal(ramOnly.vram, "");
  assert.match(ramOnly.title, /4 samples · idle/);
  assert.doesNotMatch(ramOnly.title, /VRAM/);
});

test("memoryCardLines renders the VRAM line and names the source", () => {
  const lines = memoryCardLines({
    ramBytes: 0.6 * GIB,
    ramPeakBytes: GIB,
    ramAvgBytes: 0.7 * GIB,
    vramBytes: 3.6 * GIB,
    vramPeakBytes: 4.1 * GIB,
    vramAvgBytes: 3.7 * GIB,
    vramSource: "nvidia-smi",
    samples: 9,
    busy: true
  });
  assert.equal(lines.vram, "VRAM 3.6 GB · peak 4.1 · avg 3.7");
  assert.match(lines.title, /nvidia-smi/);
  assert.match(lines.title, /9 samples · generating/);
});
