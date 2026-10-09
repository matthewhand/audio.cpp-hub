/* 「合成文本」字数。Hub 没有最大长度常量，页面只显示字数；formatter 仍接受正数 max。 */
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
  "tts.charCount": "{n} chars",
  "tts.charCountMax": "{n} / {max}"
});
const tZh = makeT({
  "tts.charCount": "{n} 字",
  "tts.charCountMax": "{n} / {max}"
});

function load(t) {
  return loadEsModule("modules/char-count.js", { $: () => null, t });
}

test("formatCharCount：只计字数，正数 max 才写 n / max", () => {
  const en = load(tEn);
  assert.equal(en.formatCharCount(142), "142 chars");
  assert.equal(en.formatCharCount(142.9), "142 chars");
  assert.equal(en.formatCharCount(-3), "0 chars");
  assert.equal(en.formatCharCount("nope"), "0 chars");
  assert.equal(en.formatCharCount(142, 0), "142 chars");
  assert.equal(en.formatCharCount(142, -1), "142 chars");
  assert.equal(en.formatCharCount(142, NaN), "142 chars");
  assert.equal(en.formatCharCount(142, 400), "142 / 400");
  assert.equal(en.formatCharCount(142, 400.8), "142 / 400");

  const zh = load(tZh);
  assert.equal(zh.formatCharCount(142), "142 字");
  assert.equal(zh.formatCharCount(8, 20), "8 / 20");
});

test("renderCharCount：走真实模块，input 后更新", () => {
  const world = createDomWorld();
  const box = world.el('<textarea id="tts-text"></textarea>');
  const out = world.el('<span id="tts-char-count" class="char-count"></span>');
  world.document.body.appendChild(box);
  world.document.body.appendChild(out);
  const mod = loadEsModule("modules/char-count.js", { $: world.$, t: tEn });
  box.value = "hello";
  mod.renderCharCount();
  assert.equal(out.textContent, "5 chars");
  mod.startCharCount();
  box.value = "hello!!";
  world.fire(box, "input");
  assert.equal(out.textContent, "7 chars");
  assert.doesNotMatch(out.innerHTML, /style=/);
});
