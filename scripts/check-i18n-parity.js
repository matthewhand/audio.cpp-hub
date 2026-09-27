#!/usr/bin/env node
/* 校验 i18n.zh.js / i18n.en.js 的中英键完全一致（issue #70 的 parity check）。
   - 无第三方依赖，node scripts/check-i18n-parity.js
   - 缺失键、占位符不一致会打印并以退出码 1 结束，可接入 CI */
const path = require("path");

global.window = {};
require(path.resolve(__dirname, "../web/i18n.zh.js"));
require(path.resolve(__dirname, "../web/i18n.en.js"));

const zh = global.window.I18N_ZH || {};
const en = global.window.I18N_EN || {};

/* 源文件里的重复键会被对象字面量静默覆盖：单独扫描文本统计 */
function duplicates(file) {
  const src = require("fs").readFileSync(path.resolve(__dirname, file), "utf8");
  const seen = new Map();
  for (const m of src.matchAll(/^\s*"([^"]+)":/gm)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([k, n]) => `${k} ×${n}`);
}
const dupZh = duplicates("../web/i18n.zh.js");
const dupEn = duplicates("../web/i18n.en.js");

const zhKeys = new Set(Object.keys(zh));
const enKeys = new Set(Object.keys(en));

const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k));
const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k));

const placeholder = (v) =>
  typeof v === "string" ? [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",") : "";
const mismatchedParams = [...zhKeys]
  .filter((k) => enKeys.has(k) && placeholder(zh[k]) !== placeholder(en[k]))
  .map((k) => `${k}: zh={${placeholder(zh[k])}} en={${placeholder(en[k])}}`);

console.log(`zh keys: ${zhKeys.size}  |  en keys: ${enKeys.size}`);
if (missingInEn.length) console.log(`missing in en (${missingInEn.length}):\n  ` + missingInEn.join("\n  "));
if (missingInZh.length) console.log(`missing in zh (${missingInZh.length}):\n  ` + missingInZh.join("\n  "));
if (mismatchedParams.length) console.log(`placeholder mismatch (${mismatchedParams.length}):\n  ` + mismatchedParams.join("\n  "));

if (dupZh.length) console.log(`duplicate keys in zh (${dupZh.length}):\n  ` + dupZh.join("\n  "));
if (dupEn.length) console.log(`duplicate keys in en (${dupEn.length}):\n  ` + dupEn.join("\n  "));

const ok = !missingInEn.length && !missingInZh.length && !mismatchedParams.length &&
  !dupZh.length && !dupEn.length;
console.log(ok ? "OK: zh/en parity holds" : "FAIL: zh/en parity broken");
process.exit(ok ? 0 : 1);
