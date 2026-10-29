/* 回归测试（#210）：TTS 面板枚举参数（voice_id / text_chunk_mode / lang）
 * 1. schemaParams 必须排除枚举参数（RESERVED_KEYS），不能同时在主枚举行与高级参数网格渲染两次；
 * 2. collectEnums 必须按照引擎契约将参数路由到正确位置：
 *    - Kokoro / Magpie: voice_id -> req.options.voice_id（不得放入顶层 req.voice_id）
 *    - Supertonic: voice_id -> req.voice_id（不得放入 req.options.voice_id）
 *    - Magpie / Breeze: text_chunk_mode -> req.options.text_chunk_mode（不得放入顶层）
 *    - Index TTS 2.5: lang -> req.options.lang（不得放入顶层）
 * 3. 避免高级参数的默认值覆盖主控件的用户选择。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadEsModule } from "./helpers/vm.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const allModels = JSON.parse(fs.readFileSync(path.join(repoRoot, "models.json"), "utf8"));

function findModel(id) {
  const m = allModels.find((x) => x.id === id);
  if (!m) throw new Error(`Model not found in models.json: ${id}`);
  return m;
}

function makeDomElement(id = "", tag = "div") {
  const children = [];
  const el = {
    id,
    tagName: tag.toUpperCase(),
    value: "",
    checked: false,
    textContent: "",
    innerHTML: "",
    children,
    parentElement: null,
    appendChild(child) {
      children.push(child);
      child.parentElement = el;
      return child;
    },
    querySelector(sel) {
      if (sel === "select") return children.find((c) => c.tagName === "SELECT") || null;
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
    setAttribute() {},
    classList: {
      toggle() {},
      add() {},
      remove() {},
      contains() {
        return false;
      }
    }
  };
  return el;
}

function setupPanelsModule() {
  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) {
      elements.set(id, makeDomElement(id));
    }
    return elements.get(id);
  };

  class DummyPicker {
    constructor() {
      this.val = "";
    }
    getValue() {
      return this.val;
    }
    setValue(v) {
      this.val = v;
    }
    setByPath(p) {
      this.val = p;
    }
  }

  const sandbox = {
    $: (id) => getEl(id),
    document: {
      querySelectorAll: () => [],
      createElement: (tag) => makeDomElement("", tag),
      getElementById: (id) => getEl(id)
    },
    window: {},
    VoiceSelect: DummyPicker,
    AudioPicker: DummyPicker,
    I18N: {
      pick: (obj, key) => (obj && obj[key] != null ? obj[key] : ""),
      t: (k) => k
    },
    t: (k) => k,
    esc: (s) => String(s ?? ""),
    el: (html) => {
      // 简单创建 dummy 包装节点
      const tagMatch = /^<([a-z0-9]+)/i.exec(html.trim());
      const tag = tagMatch ? tagMatch[1] : "div";
      const idMatch = /id="([^"]+)"/.exec(html);
      const elem = makeDomElement(idMatch ? idMatch[1] : "", tag);
      if (html.includes("<select")) {
        elem.appendChild(makeDomElement(idMatch ? idMatch[1] : "", "select"));
      }
      return elem;
    },
    selectedModel: () => null,
    activeInstanceId: () => "inst-1",
    loadHistory: () => {},
    reattachTasks: () => {},
    clearResult: () => {},
    submitTask: () => {},
    trackTask: () => {},
    historyRefPath: () => ""
  };
  sandbox.globalThis = sandbox;

  const mod = loadEsModule("modules/panels.js", sandbox);
  return { mod, getEl, elements };
}

test("schemaParams 必须排除 voice_id，防止高级参数网格渲染出重复控件 (#210)", () => {
  const { mod } = setupPanelsModule();
  const kokoro = findModel("kokoro_tts");
  const supertonic = findModel("supertonic");
  const magpie = findModel("magpie_tts");

  const kokoroParams = mod.schemaParams(kokoro).map(([k]) => k);
  assert.ok(
    !kokoroParams.includes("voice_id"),
    `kokoro_tts schemaParams 不应包含 voice_id，实际为: ${kokoroParams}`
  );
  assert.ok(kokoroParams.includes("speed"), "kokoro_tts schemaParams 仍应包含非枚举参数 speed");

  const supertonicParams = mod.schemaParams(supertonic).map(([k]) => k);
  assert.ok(
    !supertonicParams.includes("voice_id"),
    `supertonic schemaParams 不应包含 voice_id，实际为: ${supertonicParams}`
  );

  const magpieParams = mod.schemaParams(magpie).map(([k]) => k);
  assert.ok(
    !magpieParams.includes("voice_id"),
    `magpie_tts schemaParams 不应包含 voice_id，实际为: ${magpieParams}`
  );
  assert.ok(
    !magpieParams.includes("text_chunk_mode"),
    `magpie_tts schemaParams 不应包含 text_chunk_mode，实际为: ${magpieParams}`
  );
});

test("collectEnums 路由规则：Kokoro voice_id 进 options，顶层无冲突 (#210)", () => {
  const { mod, getEl } = setupPanelsModule();
  const kokoro = findModel("kokoro_tts");

  const sel = getEl("tts-enum-voice_id");
  sel.value = "jf_alpha";

  const req = {};
  mod.collectEnums(kokoro, "tts-enum", req, ["language", "speaker"]);

  assert.equal(req.options?.voice_id, "jf_alpha", "Kokoro voice_id 必须写入 req.options.voice_id");
  assert.equal(req.voice_id, undefined, "Kokoro 不得在请求顶层写入 voice_id");
});

test("collectEnums 路由规则：Supertonic voice_id 进顶层，options 无冲突 (#210)", () => {
  const { mod, getEl } = setupPanelsModule();
  const supertonic = findModel("supertonic");

  const sel = getEl("tts-enum-voice_id");
  sel.value = "M1";

  const req = {};
  mod.collectEnums(supertonic, "tts-enum", req, ["language", "speaker"]);

  assert.equal(req.voice_id, "M1", "Supertonic voice_id 必须写入请求顶层 req.voice_id");
  assert.equal(req.options?.voice_id, undefined, "Supertonic 不得在 req.options 写入 voice_id");
});

test("collectEnums 路由规则：MagpieTTS voice_id 与 text_chunk_mode 进 options (#210)", () => {
  const { mod, getEl } = setupPanelsModule();
  const magpie = findModel("magpie_tts");

  getEl("tts-enum-voice_id").value = "Jason";
  getEl("tts-enum-text_chunk_mode").value = "tag_aware";

  const req = {};
  mod.collectEnums(magpie, "tts-enum", req, ["language", "speaker"]);

  assert.equal(req.options?.voice_id, "Jason", "Magpie voice_id 必须写入 req.options.voice_id");
  assert.equal(
    req.options?.text_chunk_mode,
    "tag_aware",
    "Magpie text_chunk_mode 必须写入 req.options.text_chunk_mode"
  );
  assert.equal(req.voice_id, undefined, "Magpie 不得在请求顶层写入 voice_id");
  assert.equal(req.text_chunk_mode, undefined, "Magpie 不得在请求顶层写入 text_chunk_mode");
});

test("collectEnums 路由规则：BreezeTTS text_chunk_mode 进 options (#210)", () => {
  const { mod, getEl } = setupPanelsModule();
  const breeze = findModel("breeze-tts");

  getEl("tts-enum-text_chunk_mode").value = "japanese";

  const req = {};
  mod.collectEnums(breeze, "tts-enum", req, ["language", "speaker"]);

  assert.equal(
    req.options?.text_chunk_mode,
    "japanese",
    "Breeze text_chunk_mode 必须写入 req.options.text_chunk_mode"
  );
  assert.equal(req.text_chunk_mode, undefined, "Breeze 不得在请求顶层写入 text_chunk_mode");
});

test("collectEnums 路由规则：Index TTS 2.5 lang 进 options (#210)", () => {
  const { mod, getEl } = setupPanelsModule();
  const index25 = findModel("index_tts2_5");

  getEl("tts-enum-lang").value = "zh";

  const req = {};
  mod.collectEnums(index25, "tts-enum", req, ["language", "speaker"]);

  assert.equal(req.options?.lang, "zh", "Index TTS 2.5 lang 必须写入 req.options.lang");
  assert.equal(req.lang, undefined, "Index TTS 2.5 不得在请求顶层写入 lang");
});

test("applyHistoryOptions 能够正确恢复 voice_id (#210)", () => {
  const { mod, getEl } = setupPanelsModule();
  const kokoro = findModel("kokoro_tts");
  const supertonic = findModel("supertonic");

  const selKokoro = getEl("tts-enum-voice_id");
  selKokoro.value = "af_heart";
  mod.applyHistoryOptions(kokoro, { voice_id: "jf_alpha" });
  assert.equal(selKokoro.value, "jf_alpha", "历史中的 options.voice_id 必须填回 Kokoro 枚举下拉");

  const selSuper = getEl("tts-enum-voice_id");
  selSuper.value = "M1";
  mod.applyHistoryOptions(supertonic, { voice_id: "M2" });
  assert.equal(selSuper.value, "M2", "历史中的 voice_id 必须填回 Supertonic 枚举下拉");
});
