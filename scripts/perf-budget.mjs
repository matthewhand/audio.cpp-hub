/* #74 性能预算：对首屏关键资源做 raw + gzip 体积与请求数检查。
   不需要浏览器——按真实工作目录 web/ 的文件与 index.html 的引用计算。
   预算超标时退出码为 1（CI 据此失败）。 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");
const KIB = 1024;

/* 预算（单位 KiB / 次数 / ms）。依据 2026-09 现状留出合理增长余量。 */
export const BUDGETS = {
  jsRawKiB: 280, // 初始 JS 未压缩合计
  jsGzipKiB: 80, // 初始 JS gzip 传输合计
  cssRawKiB: 56, // 初始 CSS 未压缩
  cssGzipKiB: 14, // 初始 CSS gzip 传输
  totalGzipKiB: 96, // JS + CSS gzip 合计（不含 HTML，HTML 很小）
  subresourceRequests: 12, // 初始 <script src> + <link stylesheet> 数量
  ttiTargetMs: 1500 // 目标 TTI（本地/局域网，中端笔电）——浏览器指标，本脚本不测量
};

const JS = ["boot.js", "i18n.js", "wav.js", "file-browser.js", "audio-picker.js", "voice-select.js", "app.js", "voices-panel.js"];
const CSS = ["style.css"];

function bytes(file) {
  return fs.statSync(path.join(WEB, file)).size;
}

function gzipBytes(file) {
  return zlib.gzipSync(fs.readFileSync(path.join(WEB, file))).length;
}

function sum(list, fn) {
  return list.reduce((acc, f) => acc + fn(f), 0);
}

function kib(n) {
  return (n / KIB).toFixed(1);
}

export function measure() {
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  const scriptTags = [...html.matchAll(/<script\b[^>]*\bsrc=/g)].length;
  const cssTags = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"/g)].length;
  return {
    jsRaw: sum(JS, bytes),
    jsGzip: sum(JS, gzipBytes),
    cssRaw: sum(CSS, bytes),
    cssGzip: sum(CSS, gzipBytes),
    subresourceRequests: scriptTags + cssTags
  };
}

export function check(measured = measure()) {
  const results = [
    ["初始 JS raw", measured.jsRaw / KIB, BUDGETS.jsRawKiB, "KiB"],
    ["初始 JS gzip", measured.jsGzip / KIB, BUDGETS.jsGzipKiB, "KiB"],
    ["初始 CSS raw", measured.cssRaw / KIB, BUDGETS.cssRawKiB, "KiB"],
    ["初始 CSS gzip", measured.cssGzip / KIB, BUDGETS.cssGzipKiB, "KiB"],
    ["JS+CSS gzip 合计", (measured.jsGzip + measured.cssGzip) / KIB, BUDGETS.totalGzipKiB, "KiB"],
    ["初始子资源请求数", measured.subresourceRequests, BUDGETS.subresourceRequests, "个"]
  ];
  return results.map(([label, actual, budget, unit]) => ({
    label,
    actual,
    budget,
    unit,
    ok: actual <= budget
  }));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const measured = measure();
  const results = check(measured);
  console.log("性能预算检查（首屏关键资源，web/）");
  console.log("| 指标 | 实测 | 预算 | 结果 |");
  console.log("| --- | --- | --- | --- |");
  for (const r of results) {
    const fmt = r.unit === "KiB" ? `${r.actual.toFixed(1)} ${r.unit}` : `${r.actual} ${r.unit}`;
    const bud = r.unit === "KiB" ? `${r.budget} ${r.unit}` : `${r.budget} ${r.unit}`;
    console.log(`| ${r.label} | ${fmt} | ${bud} | ${r.ok ? "✅" : "❌ 超标"} |`);
  }
  console.log(`\nTTI 目标：≤ ${BUDGETS.ttiTargetMs} ms（本地/局域网，中端笔电；由真实浏览器测量，本脚本不校验）。`);
  console.log(`明细：JS raw ${kib(measured.jsRaw)} KiB / gzip ${kib(measured.jsGzip)} KiB；CSS raw ${kib(measured.cssRaw)} KiB / gzip ${kib(measured.cssGzip)} KiB。`);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`\n✗ ${failed.length} 项超出预算：${failed.map((r) => r.label).join("、")}`);
    process.exit(1);
  }
  console.log("\n✓ 全部在预算内");
}
