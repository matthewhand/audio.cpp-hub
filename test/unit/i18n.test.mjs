/* #72 单元测试：web/i18n.js（插值、兜底、数组值、errText、pick、setLang、中英字典 parity）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readWeb, runClassic, makeBrowserSandbox } from "./helpers/vm.mjs";

function loadI18n(overrides = {}) {
  const sandbox = makeBrowserSandbox(overrides);
  runClassic(readWeb("i18n.js"), sandbox, "i18n.js");
  return sandbox;
}

test("i18n: 语言探测优先级（localStorage > navigator）", () => {
  const a = loadI18n();
  assert.equal(a.window.I18N.lang(), "zh"); // navigator zh-CN 默认

  const b = makeBrowserSandbox({ navigator: { language: "en-US" } });
  runClassic(readWeb("i18n.js"), b, "i18n.js");
  assert.equal(b.window.I18N.lang(), "en");

  const c = makeBrowserSandbox({ navigator: { language: "en-US" } });
  c.localStorage.setItem("hub-lang", "zh");
  runClassic(readWeb("i18n.js"), c, "i18n.js");
  assert.equal(c.window.I18N.lang(), "zh");
});

test("i18n: t 插值、数组值、缺失 key 原样返回", () => {
  const { window } = loadI18n();
  const T = window.I18N;
  assert.equal(T.t("tts.submit"), "合成");
  assert.equal(T.t("history.groupCount", { n: 3 }), "3 条");
  assert.equal(T.t("history.groupCount", { n: 3 }).includes("3"), true);
  assert.deepEqual([...T.t("emotion.labels")], ["高兴", "愤怒", "悲伤", "恐惧", "反感", "低落", "惊讶", "自然"]);
  assert.equal(T.t("no.such.key"), "no.such.key");
  // 缺参时占位符原样保留
  assert.match(T.t("history.groupCount"), /\{n\}/);
});

test("i18n: 切换语言后 t 使用新字典", () => {
  const { window } = loadI18n();
  const T = window.I18N;
  T.setLang("en");
  assert.equal(T.lang(), "en");
  assert.equal(T.t("tts.submit"), "Synthesize");
  T.setLang("zh");
  assert.equal(T.t("tts.submit"), "合成");
  // 非法语言被忽略
  T.setLang("fr");
  assert.equal(T.lang(), "zh");
});

test("i18n: setLang 持久化并触发 onChange", () => {
  const { window, localStorage, document } = loadI18n();
  const seen = [];
  window.I18N.onChange((l) => seen.push(l));
  window.I18N.setLang("en");
  assert.deepEqual(seen, ["en"]);
  assert.equal(localStorage.getItem("hub-lang"), "en");
  assert.equal(document.documentElement.lang, "en");
});

test("i18n: applyI18n 替换 data-i18n* 属性", () => {
  const sandbox = makeBrowserSandbox();
  const titleNode = { dataset: { i18nTitle: "header.settingsTitle" }, title: "" };
  const ariaNode = { dataset: { i18nAriaLabel: "header.themeTitle" }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const textNode = { dataset: { i18n: "tts.submit" }, textContent: "" };
  const phNode = { dataset: { i18nPlaceholder: "tts.textPlaceholder" }, placeholder: "" };
  sandbox.document.querySelectorAll = (sel) => ({
    "[data-i18n]": [textNode],
    "[data-i18n-placeholder]": [phNode],
    "[data-i18n-title]": [titleNode],
    "[data-i18n-aria-label]": [ariaNode]
  }[sel] || []);
  runClassic(readWeb("i18n.js"), sandbox, "i18n.js");
  sandbox.window.I18N.applyI18n();
  assert.equal(textNode.textContent, "合成");
  assert.equal(titleNode.title, "设置");
  assert.equal(ariaNode.attrs["aria-label"], "切换主题");
  assert.notEqual(phNode.placeholder, "");
});

test("i18n: errText 解析后端 code/params 并翻译", () => {
  const { window } = loadI18n();
  const T = window.I18N;
  assert.equal(T.errText(""), "");
  assert.equal(
    T.errText(JSON.stringify({ ok: false, code: "VOICE_NAME_EXISTS", error: "raw" })),
    "音色名称已存在（名称需唯一）"
  );
  assert.equal(
    T.errText(JSON.stringify({ ok: false, code: "TASK_NOT_FOUND", params: { id: "abc" }, error: "raw" })),
    "任务不存在: abc"
  );
  // 未知 code → 回退 error 字段
  assert.equal(T.errText(JSON.stringify({ ok: false, code: "NOPE", error: "兜底文本" })), "兜底文本");
  // 非 JSON → 原文
  assert.equal(T.errText("plain failure"), "plain failure");
});

test("i18n: pick 英文字段优先且缺失回退", () => {
  const { window } = loadI18n();
  const T = window.I18N;
  const obj = { displayName: "中文名", displayNameEn: "English" };
  assert.equal(T.pick(obj, "displayName"), "中文名");
  T.setLang("en");
  assert.equal(T.pick(obj, "displayName"), "English");
  assert.equal(T.pick({ displayName: "只有中文" }, "displayName"), "只有中文");
  assert.equal(T.pick(null, "displayName"), "");
});

/* 从源码块抽取字典顶层 key（跳过数组值里的字符串） */
function dictKeys(source, varName) {
  const start = source.indexOf(`const ${varName} = {`);
  const end = source.indexOf("\n  };", start);
  assert.ok(start >= 0 && end > start, `缺少 ${varName} 字典块`);
  const block = source.slice(start, end);
  const keys = [];
  let objDepth = 0;
  let arrDepth = 0;
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    const km = /^"([^"]+)"\s*:/.exec(line);
    if (objDepth === 1 && arrDepth === 0 && km) keys.push(km[1]);
    const stripped = line.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    for (const ch of stripped) {
      if (ch === "{") objDepth++;
      else if (ch === "}") objDepth--;
      else if (ch === "[") arrDepth++;
      else if (ch === "]") arrDepth--;
    }
  }
  return keys;
}

test("i18n: 中英字典 key 完全对齐（parity）", () => {
  const src = readWeb("i18n.js");
  const zh = new Set(dictKeys(src, "zh"));
  const en = new Set(dictKeys(src, "en"));
  const missingInEn = [...zh].filter((k) => !en.has(k));
  const missingInZh = [...en].filter((k) => !zh.has(k));
  assert.deepEqual(missingInEn, [], `en 缺少 key: ${missingInEn.slice(0, 10).join(", ")}`);
  assert.deepEqual(missingInZh, [], `zh 缺少 key: ${missingInZh.slice(0, 10).join(", ")}`);
  assert.ok(zh.size > 100, `字典过小（${zh.size}）`);
});
