/* 单元测试辅助：把仓库里的 classic script 与顶层函数安全地加载进 node:vm，
   无需改动前端（保持浏览器 no-build 语义）。 */
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const webDir = path.join(repoRoot, "web");

export function readWeb(name) {
  return fs.readFileSync(path.join(webDir, name), "utf8");
}

/** 在独立 realm 中执行一段 classic script，返回其 sandbox（可读 window 上的导出）。 */
export function runClassic(source, sandbox = {}, filename = "classic.js") {
  const context = vm.createContext(sandbox);
  new vm.Script(source, { filename }).runInContext(context);
  return sandbox;
}

/**
 * 从源码中抽取顶层/嵌套的 `function NAME(...) { ... }` 声明（含花括号配平），
 * 并以表达式形式在 sandbox 中求值，返回函数引用。用于测试 app.js 里不可导入的纯函数。
 */
export function extractFunction(source, name) {
  const re = new RegExp(`(?:^|\\n)[ \\t]*(function\\s+${name}\\s*\\()`);
  const m = re.exec(source);
  if (!m) throw new Error(`function ${name} not found`);
  const start = m.index + m[0].indexOf("function");
  const open = source.indexOf("{", start);
  const end = matchBrace(source, open);
  return source.slice(start, end + 1);
}

/** 返回与 openIndex 处 `{` 配平的 `}` 下标，跳过字符串 / 模板 / 注释 / 正则字面量。 */
export function matchBrace(source, openIndex) {
  const REGEX_PREFIX = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", ";"]);
  let depth = 0;
  let i = openIndex;
  let mode = null; // "'" | '"' | '`' | "line" | "block" | "regex"
  let prevSig = "";
  for (; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (mode === "line") { if (ch === "\n") mode = null; continue; }
    if (mode === "block") { if (ch === "*" && next === "/") { mode = null; i++; } continue; }
    if (mode === "regex") {
      if (ch === "\\") { i++; continue; }
      if (ch === "[") { while (i + 1 < source.length && source[i + 1] !== "]") { if (source[i + 1] === "\\") i++; i++; } i++; continue; }
      if (ch === "/") { mode = null; prevSig = "x"; }
      continue;
    }
    if (mode) {
      if (ch === "\\") { i++; continue; }
      if (ch === mode) mode = null;
      continue;
    }
    if (ch === "/" && next === "/") { mode = "line"; i++; continue; }
    if (ch === "/" && next === "*") { mode = "block"; i++; continue; }
    if (ch === "/" && (prevSig === "" || REGEX_PREFIX.has(prevSig))) { mode = "regex"; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { mode = ch; prevSig = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return i; }
    if (!/\s/.test(ch)) prevSig = ch;
  }
  throw new Error("unbalanced braces");
}

/** 把抽取出的函数声明求值为函数引用，deps 里的名字会注入 vm 上下文。 */
export function makeFunction(fnSource, deps = {}) {
  const context = vm.createContext({ ...deps });
  return new vm.Script(`(${fnSource})`, { filename: "extracted-fn.js" }).runInContext(context);
}

/** 轻量 localStorage / navigator / document stub，供 i18n.js、wav.js 加载。 */
export function makeBrowserSandbox(overrides = {}) {
  const store = new Map();
  const documentElement = { lang: "" };
  const listeners = [];
  const sandbox = {
    window: {},
    navigator: { language: "zh-CN" },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
      _dump: () => Object.fromEntries(store)
    },
    document: {
      documentElement,
      addEventListener: (evt, cb) => listeners.push([evt, cb]),
      querySelectorAll: () => [],
      hidden: false
    },
    ...overrides
  };
  return sandbox;
}
