#!/usr/bin/env node
/* 校验 i18n.zh.js / i18n.en.js 的中英键完全一致（issue #70 的 parity check）。
   - 无第三方依赖，node scripts/check-i18n-parity.js
   - 缺失键、占位符不一致会打印并以退出码 1 结束，可接入 CI
   - 本仓库 package.json 声明 "type": "module"（见 #99 的工具链），故此处用 ESM；
     两份词典是挂到 window 上的经典脚本，用 Function 包裹执行以取得其全局对象。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* 在独立作用域里执行经典脚本，取出它挂到 window 上的词典 */
function loadDict(rel) {
  const src = fs.readFileSync(path.resolve(HERE, rel), "utf8");
  const win = {};
  new Function("window", src)(win);
  return win;
}

const zh = loadDict("../web/i18n.zh.js").I18N_ZH || {};
const en = loadDict("../web/i18n.en.js").I18N_EN || {};

/* 源文件里的重复键会被对象字面量静默覆盖：单独扫描文本统计 */
function duplicates(rel) {
  const src = fs.readFileSync(path.resolve(HERE, rel), "utf8");
  const seen = new Map();
  for (const m of src.matchAll(/^\s*"([^"]+)":/gm)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([k, n]) => `${k} ×${n}`);
}
const dupZh = duplicates("../web/i18n.zh.js");
const dupEn = duplicates("../web/i18n.en.js");

/* HTML 里通过 data-i18n* 引用文案键；这些键也必须存在于两份词典中，
   否则用户会直接看到键名（历史上出现过 palette.hint 这类漏配）。
   注意：HTML 引用键独立检查，即便中英两侧同时缺失也要报出来。 */
function htmlReferencedKeys() {
  const keys = new Set();
  const files = ["../web/index.html", "../web/offline.html", "../web/styleguide.html"];
  for (const rel of files) {
    const p = path.resolve(HERE, rel);
    if (!fs.existsSync(p)) continue;
    const html = fs.readFileSync(p, "utf8");
    for (const m of html.matchAll(/data-i18n(?:-placeholder|-title|-aria-label)?="([^"]+)"/g)) {
      keys.add(m[1]);
    }
  }
  return keys;
}
const htmlKeys = htmlReferencedKeys();

const zhKeys = new Set(Object.keys(zh));
const enKeys = new Set(Object.keys(en));

const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k));
const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k));

const placeholder = (v) =>
  typeof v === "string"
    ? [...v.matchAll(/\{(\w+)\}/g)]
        .map((m) => m[1])
        .sort()
        .join(",")
    : "";
const mismatchedParams = [...zhKeys]
  .filter((k) => enKeys.has(k) && placeholder(zh[k]) !== placeholder(en[k]))
  .map((k) => `${k}: zh={${placeholder(zh[k])}} en={${placeholder(en[k])}}`);

/* HTML 引用的键缺失（两处都缺 / 只缺一处） */
const htmlMissingZh = [...htmlKeys].filter((k) => !zhKeys.has(k));
const htmlMissingEn = [...htmlKeys].filter((k) => !enKeys.has(k));

console.log(`zh keys: ${zhKeys.size}  |  en keys: ${enKeys.size}`);
console.log(`HTML 引用键: ${htmlKeys.size}（data-i18n / -placeholder / -title / -aria-label）`);
if (missingInEn.length) {
  console.log(`missing in en (${missingInEn.length}):\n  ` + missingInEn.join("\n  "));
}
if (missingInZh.length) {
  console.log(`missing in zh (${missingInZh.length}):\n  ` + missingInZh.join("\n  "));
}
if (mismatchedParams.length) {
  console.log(
    `placeholder mismatch (${mismatchedParams.length}):\n  ` + mismatchedParams.join("\n  ")
  );
}
if (htmlMissingZh.length) {
  console.log(`HTML 引用键缺失 in zh (${htmlMissingZh.length}):\n  ` + htmlMissingZh.join("\n  "));
}
if (htmlMissingEn.length) {
  console.log(`HTML 引用键缺失 in en (${htmlMissingEn.length}):\n  ` + htmlMissingEn.join("\n  "));
}

if (dupZh.length) console.log(`duplicate keys in zh (${dupZh.length}):\n  ` + dupZh.join("\n  "));
if (dupEn.length) console.log(`duplicate keys in en (${dupEn.length}):\n  ` + dupEn.join("\n  "));

const ok =
  !missingInEn.length &&
  !missingInZh.length &&
  !mismatchedParams.length &&
  !htmlMissingZh.length &&
  !htmlMissingEn.length &&
  !dupZh.length &&
  !dupEn.length;
console.log(ok ? "OK: zh/en parity holds" : "FAIL: zh/en parity broken");
process.exit(ok ? 0 : 1);
