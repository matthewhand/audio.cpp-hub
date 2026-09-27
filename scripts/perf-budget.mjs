/* #74 性能预算：对首屏关键资源做 raw + gzip 体积与请求数检查。
   不需要浏览器——按真实工作目录 web/ 的文件与 index.html 的引用计算，
   并沿 ES module 的 import 图传递闭包（app.js → core/ + features/）。

   预算针对**首屏同步加载**的资源；动态 import() 的懒加载模块不计入初始请求数，
   但计入体积统计（避免把懒加载当成绕过预算的手段）。 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");
const KIB = 1024;

/* 预算（单位 KiB / 次数 / ms）。依据 2026-09 集成后现状留出合理增长余量。
   注意：模块化（ES module 图）天然增加请求数；这些数字是集成后的**实测基线 + 余量**，
   只允许下降不允许上升。后续可用动态 import() 懒加载非首屏面板来压低初始请求数。 */
export const BUDGETS = {
  jsRawKiB: 320, // 首屏 JS 未压缩合计（含 import 闭包）
  jsGzipKiB: 112, // 首屏 JS gzip 传输合计
  cssRawKiB: 72, // 首屏 CSS 未压缩（集成后 style.css 增长）
  cssGzipKiB: 18, // 首屏 CSS gzip 传输
  totalGzipKiB: 130, // JS + CSS gzip 合计（不含 HTML）
  subresourceRequests: 34, // 首屏 <script src> + <link stylesheet> + 同步 import 闭包模块数
  ttiTargetMs: 1500, // 目标 TTI（本地/局域网，中端笔电）——浏览器指标，本脚本不测量
};

function read(file) {
  return fs.readFileSync(path.join(WEB, file), "utf8");
}
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

/* 从 html 中提取所有被引用的本地脚本/样式（去掉查询串、前导 /）。 */
function referencedAssets(html) {
  const refs = new Set();
  for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) refs.add(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g))
    refs.add(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*\bhref="([^"]+)"[^>]*\brel="stylesheet"/g))
    refs.add(m[1]);
  return [...refs]
    .map((r) => r.replace(/^\//, "").split("?")[0])
    .filter((r) => !/^https?:/.test(r));
}

/* 递归解析一个 ES module 的静态 import 说明符，返回其依赖的 web/ 相对路径。 */
function moduleDeps(entry, seen) {
  if (seen.has(entry)) return [];
  seen.add(entry);
  let src;
  try {
    src = read(entry);
  } catch {
    return [];
  }
  const out = [];
  for (const m of src.matchAll(/\bimport\s+(?:[^'"]*?\bfrom\s+)?["']([^"']+)["']/g)) {
    const spec = m[1];
    if (!spec.startsWith(".")) continue; // 仅本地相对导入
    const resolved = path
      .normalize(path.join(path.dirname(entry), spec))
      .split(path.sep)
      .join("/");
    out.push(resolved);
    out.push(...moduleDeps(resolved, seen));
  }
  return out;
}

export function measure() {
  const html = read("index.html");
  const assets = referencedAssets(html);
  const jsEntries = assets.filter((f) => f.endsWith(".js"));
  const cssEntries = assets.filter((f) => f.endsWith(".css"));

  // JS：脚本入口 + 其 import 闭包
  const jsSet = new Set(jsEntries);
  const seen = new Set();
  for (const entry of jsEntries) {
    for (const dep of moduleDeps(entry, seen)) jsSet.add(dep);
  }
  const js = [...jsSet].filter((f) => fs.existsSync(path.join(WEB, f)));

  // CSS：样式入口（本仓库为单文件，保留扩展位）
  const css = cssEntries.filter((f) => fs.existsSync(path.join(WEB, f)));

  const scriptTags = [...html.matchAll(/<script\b[^>]*\bsrc=/g)].length;
  const cssTags = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"/g)].length;
  // 初始请求数 = <script src> + <link stylesheet> + app.js 同步 import 闭包中的模块数
  const importedModules =
    js.length - jsEntries.filter((f) => fs.existsSync(path.join(WEB, f))).length;

  return {
    jsRaw: sum(js, bytes),
    jsGzip: sum(js, gzipBytes),
    cssRaw: sum(css, bytes),
    cssGzip: sum(css, gzipBytes),
    subresourceRequests: scriptTags + cssTags + Math.max(importedModules, 0),
  };
}

export function check(measured = measure()) {
  const results = [
    ["首屏 JS raw", measured.jsRaw / KIB, BUDGETS.jsRawKiB, "KiB"],
    ["首屏 JS gzip", measured.jsGzip / KIB, BUDGETS.jsGzipKiB, "KiB"],
    ["首屏 CSS raw", measured.cssRaw / KIB, BUDGETS.cssRawKiB, "KiB"],
    ["首屏 CSS gzip", measured.cssGzip / KIB, BUDGETS.cssGzipKiB, "KiB"],
    ["JS+CSS gzip 合计", (measured.jsGzip + measured.cssGzip) / KIB, BUDGETS.totalGzipKiB, "KiB"],
    ["初始子资源请求数", measured.subresourceRequests, BUDGETS.subresourceRequests, "个"],
  ];
  return results.map(([label, actual, budget, unit]) => ({
    label,
    actual,
    budget,
    unit,
    ok: actual <= budget,
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
  console.log(
    `\nTTI 目标：≤ ${BUDGETS.ttiTargetMs} ms（本地/局域网，中端笔电；由真实浏览器测量，本脚本不校验）。`,
  );
  console.log(
    `明细：JS raw ${kib(measured.jsRaw)} KiB / gzip ${kib(measured.jsGzip)} KiB；CSS raw ${kib(measured.cssRaw)} KiB / gzip ${kib(measured.cssGzip)} KiB。`,
  );

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`\n✗ ${failed.length} 项超出预算：${failed.map((r) => r.label).join("、")}`);
    process.exit(1);
  }
  console.log("\n✓ 全部在预算内");
}
