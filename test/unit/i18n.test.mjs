/* #72 单元测试：web/i18n.js（插值、兜底、数组值、errText、pick、setLang、中英字典 parity）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readWeb, runClassic, makeBrowserSandbox, makeI18nSandbox } from "./helpers/vm.mjs";

/* 按 index.html 的运行时顺序加载拆分后的词典与框架：
   i18n.zh.js → window.I18N_ZH，i18n.en.js → window.I18N_EN，最后 i18n.js 读取二者。 */
function loadI18n(overrides = {}) {
  const sandbox = makeBrowserSandbox(overrides);
  runClassic(readWeb("i18n.zh.js"), sandbox, "i18n.zh.js");
  runClassic(readWeb("i18n.en.js"), sandbox, "i18n.en.js");
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
  assert.deepEqual(
    [...T.t("emotion.labels")],
    ["高兴", "愤怒", "悲伤", "恐惧", "反感", "低落", "惊讶", "自然"],
  );
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
  const sandbox = loadI18n();
  const titleNode = { dataset: { i18nTitle: "header.settingsTitle" }, title: "" };
  const ariaNode = {
    dataset: { i18nAriaLabel: "header.themeTitle" },
    attrs: {},
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
  };
  const textNode = { dataset: { i18n: "tts.submit" }, textContent: "" };
  const phNode = { dataset: { i18nPlaceholder: "tts.textPlaceholder" }, placeholder: "" };
  sandbox.document.querySelectorAll = (sel) =>
    ({
      "[data-i18n]": [textNode],
      "[data-i18n-placeholder]": [phNode],
      "[data-i18n-title]": [titleNode],
      "[data-i18n-aria-label]": [ariaNode],
    })[sel] || [];
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
    "音色名称已存在（名称需唯一）",
  );
  assert.equal(
    T.errText(
      JSON.stringify({ ok: false, code: "TASK_NOT_FOUND", params: { id: "abc" }, error: "raw" }),
    ),
    "任务不存在: abc",
  );
  // 未知 code → 回退 error 字段
  assert.equal(
    T.errText(JSON.stringify({ ok: false, code: "NOPE", error: "兜底文本" })),
    "兜底文本",
  );
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

/* 词典已拆到 i18n.zh.js / i18n.en.js（window.I18N_ZH / window.I18N_EN），
   运行时按脚本顺序加载后做中英 key 完全对齐校验。 */
test("i18n: 中英字典 key 完全对齐（parity）", () => {
  const sandbox = makeI18nSandbox();
  const zh = new Set(Object.keys(sandbox.window.I18N_ZH || {}));
  const en = new Set(Object.keys(sandbox.window.I18N_EN || {}));
  const missingInEn = [...zh].filter((k) => !en.has(k));
  const missingInZh = [...en].filter((k) => !zh.has(k));
  assert.deepEqual(missingInEn, [], `en 缺少 key: ${missingInEn.slice(0, 10).join(", ")}`);
  assert.deepEqual(missingInZh, [], `zh 缺少 key: ${missingInZh.slice(0, 10).join(", ")}`);
  assert.ok(zh.size > 100, `字典过小（${zh.size}）`);
});
