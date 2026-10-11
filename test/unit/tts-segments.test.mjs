/* TTS 头部分段控件（概念稿 .seg → .panel-head + .seg）的渲染路径。
 *
 * 用桩 schema（family breeze_tts，两个真实模式选项）挂 DOM 桩，走真实的
 * panels.js renderWorkspace → renderTtsPanel → updateTtsBlocks → renderTtsSegments：
 *   - design+clone 的模型出现两颗分段，标题旁有模型小胶囊；
 *   - 点「克隆」把真实 <select> 的值改掉，并沿同一条路径派发冒泡 change（只一次）；
 *   - 直接改 <select>（用户手动切换）后高亮跟随，且不重建按钮（键盘焦点不丢）；
 *   - 方向键 / Home / End 在分段间移动并激活；
 *   - 只有一种模式的模型整块隐藏。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDomWorld, StubElement } from "./helpers/dom-stub.mjs";
import { loadEsModule } from "./helpers/vm.mjs";

const DICT = {
  "tts.title": "Text to Speech",
  "tts.modeLabel": "Synthesis mode",
  "tts.mode.voice_design": "Voice design (generate from instruction)",
  "tts.mode.voice_clone": "Voice cloning (use reference audio)",
  "tts.seg.label": "Voice source",
  "tts.seg.design": "Voice design",
  "tts.seg.clone": "Clone",
  "tts.seg.library": "Library voice",
  "tts.textPlaceholder": "Text to synthesize",
  "tts.instructLabel": "instruct",
  "tts.refTextLabel": "reference_text",
  "common.language": "Language",
  "common.advanced": "Advanced",
  "tts.speakersLabel": "Speakers",
  "tts.speakerAdd": "Add speaker",
  "tts.speakerRemove": "Remove",
  "tts.speakerLinesPlaceholder": "lines",
  "tts.speakersHint": "hint"
};

function t(key, params) {
  let s = DICT[key] || key;
  for (const [k, v] of Object.entries(params || {})) s = s.split("{" + k + "}").join(String(v));
  return s;
}

const IDS = [
  // 模块求值就要在位的控件
  "voice-picker", "emotion-picker", "asr-audio-picker", "sep-audio-picker",
  "other-audio-picker", "tts-speaker-add", "tts-emotion-alpha", "tts-submit",
  "asr-submit", "asr-copy", "sep-submit", "music-submit", "other-submit", "tts-mode-row",
  // renderWorkspace 切换的五张面板
  "panel-tts", "panel-asr", "panel-sep", "panel-music", "panel-other",
  // renderTtsPanel / updateTtsBlocks 触碰的面板元素
  "tts-title", "tts-model-chip", "tts-seg-mount", "tts-primary-instruction-row",
  "tts-language-row", "tts-speaker-row", "tts-instruct-row", "tts-ref-text-row",
  "tts-enum-row", "tts-emotion-block", "tts-voice-block", "tts-speakers-block",
  "tts-speakers-list", "tts-text-block", "tts-advanced-grid", "tts-advanced",
  "tts-text", "tts-result", "tts-msg", "tts-stats"
];

function mount(world) {
  const body = world.document.body;
  for (const id of IDS) {
    const node = new StubElement(world, id === "tts-title" ? "h2" : "div");
    node.setAttribute("id", id);
    node.setAttribute("class", "hidden");
    body.appendChild(node);
  }
  world.document.createElement = (tag) => new StubElement(world, tag);
}

/** BreezeTTS 2 的真实形状：两个模式、一条 instruction 参数、可选参考音频。 */
function breezeModel() {
  return {
    id: "breeze-tts",
    family: "breeze_tts",
    category: "tts",
    displayName: "BreezeTTS 2",
    inputs: { text: "required", audio: "none", voiceRef: "optional" },
    paramSchema: { instruction: { type: "string", default: "warm newsreader" } }
  };
}

/** 没有模式可切的模型：音色库一颗分段都凑不齐两颗，控件整块隐藏。 */
function singleModeModel() {
  return {
    id: "miotts",
    family: "miotts",
    category: "tts",
    displayName: "MioTTS",
    inputs: { text: "required", audio: "none", voiceRef: "required" },
    paramSchema: {}
  };
}

/** sandbox 里的 Event：dom-stub 的 dispatchEvent 只读 .type / .bubbles。 */
class StubEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = !!init.bubbles;
  }
}

function load(world, model) {
  /* tts-modes.js 是真纯模块：把它加载进来当 panels.js 的依赖（loadEsModule 每次新建
     vm 上下文，所以先取导出再摊进 panels.js 的沙箱，映射逻辑走真代码不打桩）。 */
  const pure = loadEsModule("modules/tts-modes.js", {});
  const sandbox = {
    document: world.document,
    $: world.$,
    el: world.el,
    esc: (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"),
    t,
    I18N: { pick: (o, k) => (o && o[k]) || "", num: (n) => String(n), date: (v) => String(v) },
    Event: StubEvent,
    CustomEvent: class {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    VoiceSelect: class {
      constructor() {}
    },
    AudioPicker: class {
      constructor() {}
    },
    renderCharCount() {},
    historyRefPath: () => "",
    loadHistory() {},
    activeInstanceId: "i1",
    selectedModel: () => model,
    clearResult() {},
    reattachTasks() {},
    submitTask: () => Promise.resolve({}),
    trackTask() {},
    window: { dispatchEvent() {}, addEventListener() {} },
    location: { hash: "" },
    localStorage: { getItem: () => null },
    activeSegment: pure.activeSegment,
    segmentsFor: pure.segmentsFor,
    SEGMENT_LABEL_KEYS: pure.SEGMENT_LABEL_KEYS,
    targetFor: pure.targetFor
  };
  const mod = loadEsModule("modules/panels.js", sandbox);
  mod.__sandbox = sandbox;
  return mod;
}

/** #tts-mode-row 里真实的 <select>（panels.js 建好后塞进那一行）。 */
function modeSelect(world) {
  return world.$("tts-mode-row").querySelector("select");
}

function segButtons(world) {
  return world.$("tts-seg-mount").querySelectorAll("[data-seg]");
}

test("渲染路径：分段控件出现、点击切换、手动切换高亮跟随", () => {
  const world = createDomWorld();
  mount(world);
  const model = breezeModel();
  const mod = load(world, model);

  mod.renderWorkspace();
  const sel = modeSelect(world);
  assert.ok(sel, "breeze 模型有真实的「合成模式」下拉");
  assert.equal(sel.querySelectorAll("option").length, 2);

  // 标题只剩本地化标题，模型名进了旁边的小胶囊
  assert.equal(world.$("tts-title").textContent, "Text to Speech");
  assert.equal(world.$("tts-model-chip").textContent, "BreezeTTS 2");
  assert.equal(world.$("tts-model-chip").classList.contains("hidden"), false);

  // 分段控件出现：role=tablist + aria-label + 两颗 tab
  const mountEl = world.$("tts-seg-mount");
  assert.equal(mountEl.classList.contains("hidden"), false, "两颗分段时不隐藏");
  const list = mountEl.querySelector('[role="tablist"]');
  assert.ok(list, "tablist");
  assert.equal(list.getAttribute("aria-label"), "Voice source");
  const btns = segButtons(world);
  assert.equal(btns.length, 2);
  assert.deepEqual(btns.map((b) => b.getAttribute("data-seg")), ["design", "clone"]);
  // dom-stub 不建文本节点，文案从 markup 读
  assert.match(mountEl.innerHTML, />Voice design<\/button>/);
  assert.match(mountEl.innerHTML, />Clone<\/button>/);
  // roving tabindex：只有选中那颗是 0
  assert.equal(btns[0].getAttribute("tabindex"), "0");
  assert.equal(btns[1].getAttribute("tabindex"), "-1");
  // 高亮：class on + aria-selected（默认模式 voice_design）
  assert.equal(btns[0].classList.contains("on"), true);
  assert.equal(btns[0].getAttribute("aria-selected"), "true");
  assert.equal(btns[1].getAttribute("aria-selected"), "false");
  // CSP：分段标记里没有 style=""
  assert.doesNotMatch(mountEl.innerHTML, /style=/);

  // 点「克隆」：真实 select 的值被改掉，且沿冒泡路径派发 change —— 只一次
  let changes = 0;
  sel.addEventListener("change", () => { changes++; });
  btns[1].onclick();
  assert.equal(sel.value, "voice_clone", "点分段 = 改真实下拉值");
  assert.equal(changes, 1, "change 只派发一次");
  // 高亮跟随（克隆那颗现在选中），克隆模式的参考音频选择器也跟着显示
  const after = segButtons(world);
  assert.equal(after[1].classList.contains("on"), true);
  assert.equal(after[1].getAttribute("aria-selected"), "true");
  assert.equal(after[0].classList.contains("on"), false);
  assert.equal(after[1].getAttribute("tabindex"), "0");
  // 克隆模式有音色选择器 → 音色库分段随之解析出来（这颗不改模式，只聚焦选择器）
  assert.deepEqual(after.map((b) => b.getAttribute("data-seg")), ["design", "clone", "library"]);
  assert.equal(world.$("tts-voice-block").classList.contains("hidden"), false);

  // 直接改真实 select（用户手动切换）：高亮跟随。设计模式没有参考音频选择器，
  // 于是音色库这一段自行消失——能点的才有（声音设计下聚焦一个隐藏的选单是死控件）。
  sel.value = "voice_design";
  sel.dispatchEvent(new StubEvent("change", { bubbles: true }));
  const back = segButtons(world);
  assert.deepEqual(back.map((b) => b.getAttribute("data-seg")), ["design", "clone"]);
  assert.equal(back[0].classList.contains("on"), true);
  assert.equal(back[0].getAttribute("aria-selected"), "true");
  assert.equal(back[1].getAttribute("aria-selected"), "false");
  assert.equal(back[0].getAttribute("tabindex"), "0");

  // 再派发一次同样的 change（值没变）：成员没变就不重建按钮——键盘焦点不丢
  const nodes = segButtons(world);
  sel.dispatchEvent(new StubEvent("change", { bubbles: true }));
  const same = segButtons(world);
  assert.equal(same.length, nodes.length);
  same.forEach((b, i) => assert.equal(b, nodes[i], "成员不变时只改状态"));
});

test("键盘：方向键 / Home / End 在分段间移动并激活", () => {
  const world = createDomWorld();
  mount(world);
  const model = breezeModel();
  const mod = load(world, model);
  mod.renderWorkspace();
  const sel = modeSelect(world);
  const btns = segButtons(world);
  assert.equal(btns.length, 2);

  btns[0].onkeydown({ key: "ArrowRight", preventDefault() {} });
  assert.equal(sel.value, "voice_clone", "→ 切到克隆");
  assert.equal(segButtons(world)[1].getAttribute("aria-selected"), "true");

  segButtons(world)[1].onkeydown({ key: "End", preventDefault() {} });
  assert.equal(sel.value, "voice_clone", "只有两颗时 End 已是最后一颗");

  segButtons(world)[1].onkeydown({ key: "Home", preventDefault() {} });
  assert.equal(sel.value, "voice_design", "Home = 第一颗");

  segButtons(world)[0].onkeydown({ key: "ArrowLeft", preventDefault() {} });
  assert.equal(sel.value, "voice_clone", "← 从第一颗绕到最后一颗");

  // 其它键不拦截（不 preventDefault）
  let prevented = false;
  segButtons(world)[0].onkeydown({ key: "a", preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
});

test("单模式模型：整块分段控件隐藏", () => {
  const world = createDomWorld();
  mount(world);
  const model = singleModeModel();
  const mod = load(world, model);
  mod.renderWorkspace();
  const mountEl = world.$("tts-seg-mount");
  assert.equal(mountEl.classList.contains("hidden"), true, "少于两颗分段就隐藏");
  assert.equal(segButtons(world).length, 0, "不留任何分段节点");
  assert.equal(modeSelect(world), null, "这个模型没有模式下拉");
  assert.equal(world.$("tts-model-chip").textContent, "MioTTS");
});
