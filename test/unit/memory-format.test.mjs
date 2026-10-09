/* 实例卡片两拨纯逻辑的格式化：忙碌徽标合并（resolveBusy / formatBusyElapsed）与
   内存条（memRowModel / clampPct / formatMiB / memStatsLabel / memAriaText /
   memRowHtml / memBlockHtml）。都从真实源码里抽出来在 node:vm 里求值，
   文案经注入的 t() 桩走英文词典原文（中文由 check:i18n 的 parity 保证存在）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { extractFunction, readWeb } from "./helpers/vm.mjs";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/* 英文词典里与这些函数相关的条目（与 web/i18n.en.js 保持一致） */
const DICT = {
  "instance.generating": "Generating…",
  "instance.memKeyRam": "RAM",
  "instance.memKeyVram": "VRAM",
  "instance.memNow": "now",
  "instance.memStatPeak": "Peak",
  "instance.memStatAvg": "Avg",
  "instance.memStatIdle": "Idle",
  "instance.memAriaRam": "RAM {cur} now, peak {peak}, average {avg} {unit}",
  "instance.memAriaRamIdle": "RAM {cur} now, peak {peak}, average {avg}, idle {idle} {unit}",
  "instance.memAriaVram": "VRAM {cur} now, peak {peak}, average {avg} {unit}",
  "instance.memAriaVramIdle": "VRAM {cur} now, peak {peak}, average {avg}, idle {idle} {unit}",
  "instance.memTipVram": "VRAM {cur} · peak {peak} · avg {avg} ({source})",
  "instance.memTipMeta": "{n} samples · {state}",
  "instance.memSource.drm": "DRM fdinfo",
  "instance.memSource.nvidia-smi": "nvidia-smi",
  "instance.memSource.none": "unknown",
  "instance.memBusy": "generating",
  "instance.memIdle": "idle"
};

const NAMES = [
  // 忙碌徽标
  "resolveBusy", "formatBusyElapsed",
  // 内存条：私有小工具 + 纯函数
  "msOr", "memMiB", "numOr", "opt", "num1", "memUnitFormat",
  "formatMiB", "clampPct", "memRowModel", "memStatsLabel", "memAriaText",
  "memRowHtml", "memBlockHtml"
];

function load() {
  const src = readWeb("modules/instances.js");
  const bundle = NAMES.map(n => extractFunction(src, n)).join("\n");
  const t = (key, params) => {
    let s = DICT[key] || key;
    for (const [k, v] of Object.entries(params || {})) s = s.split("{" + k + "}").join(String(v));
    return s;
  };
  const esc = (v) => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const context = vm.createContext({ t, esc, MEM_MIB: 1024 * 1024 });
  return new vm.Script(`${bundle}\n({ ${NAMES.join(", ")} })`, {
    filename: "instances-pure.js"
  }).runInContext(context);
}

const {
  resolveBusy, formatBusyElapsed, formatMiB, clampPct,
  memRowModel, memStatsLabel, memAriaText, memRowHtml, memBlockHtml
} = load();

/* vm realm 造出来的对象原型与测试 realm 不同。本文件从 node:assert/strict 引入，
   deepEqual 即 deepStrictEqual，原型不等会报
   “Values have same structure but are not reference-equal”。
   JSON 往返摊平回测试 realm（与 api-client.test.mjs 的 plain 同一做法）。 */
const plain = (v) => JSON.parse(JSON.stringify(v));

/* ---------- 忙碌徽标：SSE + 轮询合并 ---------- */

test("resolveBusy：SSE 说在忙就用 SSE，起点取 task.started 的 ts", () => {
  const busy = resolveBusy({ startMs: 1756400000000 }, { taskCount: 0 });
  assert.deepEqual(plain(busy), { busy: true, startMs: 1756400000000, source: "sse" });
  // 事件没带 ts：徽标照常亮，计时省略
  assert.deepEqual(plain(resolveBusy({ startMs: null }, { taskCount: 0 })),
    { busy: true, startMs: null, source: "sse" });
});

test("resolveBusy：没有 SSE 时回退到轮询（taskCount 或采样器 busy）", () => {
  const byCount = resolveBusy(null, { taskCount: 3, runningStartedAt: 1756400001000 });
  assert.deepEqual(plain(byCount), { busy: true, startMs: 1756400001000, source: "poll" });
  const byMemory = resolveBusy(null, { taskCount: 0, memory: { busy: true } });
  assert.deepEqual(plain(byMemory), { busy: true, startMs: null, source: "poll" });
  // 轮询也不知道起点时省略计时（不编一个）
  const noStart = resolveBusy(null, { taskCount: 1, runningStartedAt: "nope" });
  assert.deepEqual(plain(noStart), { busy: true, startMs: null, source: "poll" });
});

test("resolveBusy：不忙时三个字段都干净", () => {
  assert.deepEqual(plain(resolveBusy(null, { taskCount: 0, memory: { busy: false } })),
    { busy: false, startMs: null, source: null });
  assert.deepEqual(plain(resolveBusy(null, null)), { busy: false, startMs: null, source: null });
  // taskCount 不是数字（旧 hub / 异常数据）时不误判成忙碌
  assert.deepEqual(plain(resolveBusy(null, { taskCount: "x" })),
    { busy: false, startMs: null, source: null });
});

test("formatBusyElapsed：60s 内一位小数，之后分秒", () => {
  assert.equal(formatBusyElapsed(3.24), "3.2s");
  assert.equal(formatBusyElapsed(0), "0.0s");
  assert.equal(formatBusyElapsed(59.96), "1m 00s");
  assert.equal(formatBusyElapsed(65), "1m 05s");
  assert.equal(formatBusyElapsed(600.4), "10m 00s");
  assert.equal(formatBusyElapsed(-1), "");
  assert.equal(formatBusyElapsed(Number.NaN), "");
  assert.equal(formatBusyElapsed(undefined), "");
});

/* ---------- 内存条：单位 / 百分比 / 比例尺 ---------- */

test("formatMiB：≥ 1024 MiB 用一位小数 GiB，否则取整 MiB", () => {
  assert.equal(formatMiB(942), "942 MiB");
  assert.equal(formatMiB(1023.6), "1024 MiB");
  assert.equal(formatMiB(1024), "1.0 GiB");
  assert.equal(formatMiB(4.2 * 1024), "4.2 GiB");
  assert.equal(formatMiB(8 * 1024), "8.0 GiB");
  assert.equal(formatMiB(0), "0 MiB");
  assert.equal(formatMiB(-1), "");
  assert.equal(formatMiB(undefined), "");
});

test("clampPct：钳到 0–100 并保留一位小数", () => {
  assert.equal(clampPct(0), 0);
  assert.equal(clampPct(42.35), 42.4);
  assert.equal(clampPct(100), 100);
  assert.equal(clampPct(180), 100);
  assert.equal(clampPct(-5), 0);
  assert.equal(clampPct(Number.NaN), 0);
  assert.equal(clampPct("50"), 0);
});

test("memRowModel：RAM 用 max(峰值, 当前) × 1.4，不设 GPU 总量", () => {
  const row = memRowModel("ram", {
    ramBytes: 942 * MIB,
    ramPeakBytes: 988 * MIB,
    ramAvgBytes: 700 * MIB
  });
  assert.equal(row.kind, "ram");
  assert.equal(row.cur, 942);
  assert.equal(row.peak, 988);
  assert.equal(row.avg, 700);
  assert.equal(row.total, null);
  assert.equal(row.idle, null);
  assert.equal(row.scale, Math.max(988, 942) * 1.4);
  assert.equal(row.fillPct, clampPct((942 / (988 * 1.4)) * 100));
  assert.equal(row.peakPct, clampPct((988 / (988 * 1.4)) * 100));
  assert.equal(row.avgPct, clampPct((700 / (988 * 1.4)) * 100));
  assert.equal(row.hot, false);
});

test("memRowModel：VRAM 已知总量时以总量为比例尺，未知时 × 1.25", () => {
  const withTotal = memRowModel("vram", {
    vramBytes: 4.2 * 1024 * MIB,
    vramPeakBytes: 4.3 * 1024 * MIB,
    vramAvgBytes: 3.7 * 1024 * MIB,
    vramTotalBytes: 8 * GIB
  });
  assert.equal(withTotal.scale, 8192);
  assert.equal(withTotal.total, 8192);
  assert.equal(withTotal.fillPct, clampPct((4.2 * 1024 / 8192) * 100));
  assert.equal(withTotal.hot, false);

  const noTotal = memRowModel("vram", {
    vramBytes: 4 * 1024 * MIB,
    vramPeakBytes: 4.2 * 1024 * MIB
  });
  assert.equal(noTotal.scale, 4.2 * 1024 * 1.25);
  assert.equal(noTotal.total, null);

  // 数据把当前值顶到总量之上（异常读数）时百分比仍钳在 100
  const over = memRowModel("vram", { vramBytes: 9 * GIB, vramTotalBytes: 8 * GIB });
  assert.equal(over.fillPct, 100);
  assert.equal(over.hot, true);
  // ≥ 85% 才用「快满」渐变
  const nearly = memRowModel("vram", { vramBytes: 6.9 * GIB, vramTotalBytes: 8 * GIB });
  assert.equal(nearly.hot, true);
  const roomy = memRowModel("vram", { vramBytes: 5 * GIB, vramTotalBytes: 8 * GIB });
  assert.equal(roomy.hot, false);
});

test("memRowModel：缺失字段（没有 memory / 没有 VRAM / 没有峰值均值）", () => {
  assert.equal(memRowModel("ram", null), null);
  assert.equal(memRowModel("vram", null), null);
  assert.equal(memRowModel("ram", {}), null);
  // VRAM 从未读到：那一行直接不画
  assert.equal(memRowModel("vram", { ramBytes: 100 * MIB }), null);
  // 只有当前值：峰值 / 均值退回当前值，空闲仍是未知
  const bare = memRowModel("ram", { ramBytes: 100 * MIB });
  assert.equal(bare.peak, 100);
  assert.equal(bare.avg, 100);
  assert.equal(bare.idle, null);
  assert.equal(bare.scale, 140);
  // 空闲基线来自后端新增字段，缺失即省略
  const idle = memRowModel("ram", {
    ramBytes: 942 * MIB,
    ramPeakBytes: 988 * MIB,
    ramIdleBytes: 598 * MIB
  });
  assert.equal(idle.idle, 598);
});

test("memRowModel：全 0 的比例尺退到 1 MiB（不除零）", () => {
  const row = memRowModel("ram", { ramBytes: 0 });
  assert.equal(row.scale, 1);
  assert.equal(row.fillPct, 0);
});

/* ---------- 内存条：文案 ---------- */

test("memStatsLabel：整行一个单位，行尾出现一次；Idle 未知则省略", () => {
  const mib = memRowModel("ram", {
    ramBytes: 942 * MIB,
    ramPeakBytes: 988 * MIB,
    ramAvgBytes: 700 * MIB,
    ramIdleBytes: 598 * MIB
  });
  assert.equal(memStatsLabel(mib), "Peak 988 · Avg 700 · Idle 598 MiB");
  const noIdle = memRowModel("ram", {
    ramBytes: 942 * MIB,
    ramPeakBytes: 988 * MIB,
    ramAvgBytes: 700 * MIB
  });
  assert.equal(memStatsLabel(noIdle), "Peak 988 · Avg 700 MiB");
  // 行内最大值 ≥ 1024 MiB：整行换算成 GiB
  const gib = memRowModel("vram", {
    vramBytes: 4.1 * GIB,
    vramPeakBytes: 4.2 * GIB,
    vramAvgBytes: 3.7 * GIB,
    vramIdleBytes: 3.6 * GIB
  });
  assert.equal(memStatsLabel(gib), "Peak 4.2 · Avg 3.7 · Idle 3.6 GiB");
});

test("memAriaText：无障碍名称 / 值文本（有无 idle 两个句式）", () => {
  const ram = memRowModel("ram", {
    ramBytes: 942 * MIB,
    ramPeakBytes: 988 * MIB,
    ramAvgBytes: 700 * MIB
  });
  assert.equal(memAriaText(ram), "RAM 942 MiB now, peak 988, average 700 MiB");
  const ramIdle = memRowModel("ram", {
    ramBytes: 942 * MIB,
    ramPeakBytes: 988 * MIB,
    ramAvgBytes: 700 * MIB,
    ramIdleBytes: 598 * MIB
  });
  assert.equal(memAriaText(ramIdle), "RAM 942 MiB now, peak 988, average 700, idle 598 MiB");
  const vram = memRowModel("vram", {
    vramBytes: 4.1 * GIB,
    vramPeakBytes: 4.2 * GIB,
    vramAvgBytes: 3.7 * GIB,
    vramIdleBytes: 3.6 * GIB,
    vramTotalBytes: 8 * GIB
  });
  assert.equal(memAriaText(vram), "VRAM 4.1 GiB now, peak 4.2, average 3.7, idle 3.6 GiB");
});

/* ---------- 内存条：HTML 形状 ---------- */

test("memRowHtml：role=meter + 填充 / 刻度线（刻度线 aria-hidden）", () => {
  const row = memRowModel("ram", {
    ramBytes: 942 * MIB,
    ramPeakBytes: 988 * MIB,
    ramAvgBytes: 700 * MIB
  });
  const html = memRowHtml(row);
  assert.match(html, /role="meter"/);
  assert.match(html, /aria-valuemin="0"/);
  assert.match(html, /aria-valuemax="1383\.2"/);
  assert.match(html, /aria-valuenow="942"/);
  assert.match(html, /aria-label="RAM 942 MiB now, peak 988, average 700 MiB"/);
  assert.match(html, /class="fill ram"/);
  assert.match(html, /width:68\.1%/);
  assert.match(html, /class="pk"[^>]*aria-hidden="true"/);
  assert.match(html, /class="avg"[^>]*aria-hidden="true"/);
  assert.match(html, /<span class="k">RAM<\/span>/);
  assert.match(html, /<span class="of">now<\/span>/);
  // 没有 GPU 总量就不出现「/ total」
  assert.doesNotMatch(html, /class="of num"/);
});

test("memBlockHtml：只有 RAM / 隐藏条件 / VRAM 总量与 hot 渐变 / 图例一次", () => {
  assert.equal(memBlockHtml(null), "");
  assert.equal(memBlockHtml({}), "");

  const ramOnly = memBlockHtml({
    ramBytes: 600 * MIB,
    ramPeakBytes: GIB,
    ramAvgBytes: 700 * MIB,
    samples: 4
  });
  assert.match(ramOnly, /role="meter"/);
  assert.doesNotMatch(ramOnly, /class="fill vram"/);
  // 图例每张卡片只出现一次
  assert.equal(ramOnly.match(/mem-legend/g).length, 1);
  // title 里保留采样次数明细
  assert.match(ramOnly, /title="[^"]*4 samples/);

  const vram = memBlockHtml({
    ramBytes: 942 * MIB,
    ramPeakBytes: 988 * MIB,
    ramAvgBytes: 700 * MIB,
    vramBytes: 4.2 * GIB,
    vramPeakBytes: 4.3 * GIB,
    vramAvgBytes: 3.7 * GIB,
    vramIdleBytes: 3.6 * GIB,
    vramTotalBytes: 8 * GIB,
    vramSource: "nvidia-smi",
    samples: 12,
    busy: true
  });
  assert.match(vram, /class="fill vram"/);
  // VRAM 总量：标签行「/ 8.0 GiB」+ meter 的 valuemax
  assert.match(vram, /\/ 8\.0 GiB/);
  assert.match(vram, /aria-valuemax="8192"/);
  // 4.1 GiB / 8 GiB = 51%：未到 85%，不用 hot 渐变
  assert.doesNotMatch(vram, /fill hot/);
  assert.match(vram, /title="[^"]*nvidia-smi/);
  assert.match(vram, /12 samples · generating/);
  assert.equal(vram.match(/mem-legend/g).length, 1);
  assert.equal(vram.match(/role="meter"/g).length, 2);

  const hot = memBlockHtml({ ramBytes: MIB, vramBytes: 7.5 * GIB, vramTotalBytes: 8 * GIB });
  assert.match(hot, /class="fill vram hot"/);
});
