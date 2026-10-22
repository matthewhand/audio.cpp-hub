/* 「合成文本」字数与词数。Hub 没有最大长度常量，页面显示计数；formatter 仍接受正数 max。
   词数优先走 Intl.Segmenter，旧内核退回空白切分——两条路径都用注入的桩钉住。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDomWorld } from "./helpers/dom-stub.mjs";
import { loadEsModule } from "./helpers/vm.mjs";

function makeT(dict) {
  return (key, params) => {
    let s = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
    for (const [k, v] of Object.entries(params || {})) {
      s = s.split("{" + k + "}").join(String(v));
    }
    return s;
  };
}

const tEn = makeT({
  "tts.charCount": "{n} chars · {words}",
  "tts.charCountMax": "{n} / {max} chars · {words}",
  "tts.wordCount": "{n} words"
});
const tZh = makeT({
  "tts.charCount": "{n} 字 · {words}",
  "tts.charCountMax": "{n} / {max} 字 · {words}",
  "tts.wordCount": "{n} 词"
});

/* Intl.Segmenter 桩：按给定分段表喂段（不匹配的段跳过），isWordLike 由表里第二项决定 */
function segmenterStub(parts) {
  class Segmenter {
    constructor() {
      this.granularity = "word";
    }
    segment(text) {
      const out = [];
      let rest = String(text);
      for (const [seg, wordLike] of parts) {
        if (!rest.startsWith(seg)) continue; // 另一段文本用不到的段
        out.push({ segment: seg, isWordLike: wordLike });
        rest = rest.slice(seg.length);
      }
      if (rest) throw new Error("stub: unsegmented remainder " + rest);
      return out;
    }
  }
  return { Segmenter };
}

function load(t, extra = {}) {
  return loadEsModule("modules/char-count.js", {
    $: () => null,
    t,
    I18N: { num: (n) => String(n) },
    ...extra
  });
}

test("countWords：有 Intl.Segmenter 时只数 isWordLike 的段", () => {
  const mod = load(tEn, {
    Intl: segmenterStub([
      ["Welcome", true],
      [" ", false],
      ["back", true],
      ["!", false],
      ["你好", true],
      ["世界", true]
    ])
  });
  // 拉丁文本按词切，中文连续汉字被切成多个 word-like 段
  assert.equal(mod.countWords("Welcome back"), 2);
  assert.equal(mod.countWords("你好世界"), 2);
  assert.equal(mod.countWords("Welcome back!你好世界"), 4);
  assert.equal(mod.countWords("   "), 0);
  assert.equal(mod.countWords(""), 0);
  assert.equal(mod.countWords(undefined), 0);
});

test("countWords：没有 Intl.Segmenter 时退回空白切分", () => {
  const mod = load(tEn, { Intl: {} });
  assert.equal(mod.countWords("Welcome back to the briefing"), 5);
  assert.equal(mod.countWords("  padded   out  "), 2);
  assert.equal(mod.countWords(""), 0);
  // 中文没有空白：整段算一个词（退化但可用，不报错）
  assert.equal(mod.countWords("你好世界"), 1);
});

test("countWords：Segmenter 构造失败时也退回空白切分", () => {
  const mod = load(tEn, {
    Intl: {
      Segmenter: class {
        constructor() {
          throw new Error("nope");
        }
      }
    }
  });
  assert.equal(mod.countWords("one two three"), 3);
});

test("formatCharCount：字 + 词，正数 max 才写 n / max", () => {
  const en = load(tEn, {
    Intl: segmenterStub([
      ["Welcome", true],
      [" ", false],
      ["back", true]
    ])
  });
  assert.equal(en.formatCharCount("Welcome back"), "12 chars · 2 words");
  assert.equal(en.formatCharCount("Welcome back", 400), "12 / 400 chars · 2 words");
  assert.equal(en.formatCharCount("Welcome back", 400.8), "12 / 400 chars · 2 words");
  assert.equal(en.formatCharCount("", 400), "0 / 400 chars · 0 words");
  assert.equal(en.formatCharCount("x", 0), "1 chars · 1 words");
  assert.equal(en.formatCharCount("x", -1), "1 chars · 1 words");
  assert.equal(en.formatCharCount("x", NaN), "1 chars · 1 words");
  assert.equal(en.formatCharCount(42), "0 chars · 0 words", "非字符串入参按空文本计");
  assert.equal(en.formatCharCount(null), "0 chars · 0 words");

  const zh = load(tZh, { Intl: segmenterStub([["你好", true]]) });
  assert.equal(zh.formatCharCount("你好"), "2 字 · 1 词");
  assert.equal(zh.formatCharCount("你好", 20), "2 / 20 字 · 1 词");
});

test("renderCharCount：走真实模块，input 后更新", () => {
  const world = createDomWorld();
  const box = world.el('<textarea id="tts-text"></textarea>');
  const out = world.el('<span id="tts-char-count" class="char-count"></span>');
  world.document.body.appendChild(box);
  world.document.body.appendChild(out);
  const mod = loadEsModule("modules/char-count.js", {
    $: world.$,
    t: tEn,
    I18N: { num: (n) => String(n) },
    // 这个用例只验证接线，用可预期的桩分段
    Intl: segmenterStub([
      ["hello", true],
      ["!", false]
    ])
  });
  box.value = "hello";
  mod.renderCharCount();
  assert.equal(out.textContent, "5 chars · 1 words");
  mod.startCharCount();
  box.value = "hello!!";
  world.fire(box, "input");
  assert.equal(out.textContent, "7 chars · 1 words");
  assert.doesNotMatch(out.innerHTML, /style=/);
});

test("真实运行环境：Intl.Segmenter 存在与否都不抛错，词数为非负整数", () => {
  const mod = load(tEn);
  const text = "Welcome back to the morning briefing. 今天看点三件事。";
  const n = mod.countWords(text);
  assert.ok(Number.isInteger(n) && n >= 0, "word count is a non-negative integer");
  assert.match(mod.formatCharCount(text), /· \d+ words$/);
  assert.doesNotMatch(mod.formatCharCount(text), /style=/);
});
