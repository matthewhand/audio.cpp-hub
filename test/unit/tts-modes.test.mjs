/* web/modules/tts-modes.js 的纯逻辑：三颗分段（声音设计 / 克隆 / 音色库）只是
 * 「合成模式」下拉与音色选择器之上的薄视图，映射全部由真实选项的 value/label
 * 推导，因此可以在 node 里直接打。覆盖：单模式 → 不构成控件；design+clone →
 * 两颗；未知值 → 该段省略且不抛；中文标签同样命中；targetFor 返回精确选项值；
 * activeSegment 对每个取值的高亮；library 的两种解析（真有模式 vs 聚焦选择器）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEsModule } from "./helpers/vm.mjs";

const mod = loadEsModule("modules/tts-modes.js", {});

/* vm realm 造出来的数组/对象原型与测试 realm 不同：deepStrictEqual 会报
   「same structure but not reference-equal」，JSON 往返摊平（同 memory-format 的做法）。 */
const plain = (v) => JSON.parse(JSON.stringify(v));

/* BreezeTTS 2 的真实选项：value 是引擎识别的模式，label 走词典（zh） */
const BREEZE = [
  { value: "voice_design", label: "声音设计（按指令生成音色）" },
  { value: "voice_clone", label: "声音克隆（使用参考音频）" }
];

test("SEGMENT_IDS / SEGMENT_LABEL_KEYS：三颗分段的稳定 id 与词典 key", () => {
  assert.deepEqual(plain(mod.SEGMENT_IDS), ["design", "clone", "library"]);
  assert.deepEqual(plain(mod.SEGMENT_LABEL_KEYS), {
    design: "tts.seg.design",
    clone: "tts.seg.clone",
    library: "tts.seg.library"
  });
});

test("design+clone：正好两颗分段，各自指向真实选项值", () => {
  assert.deepEqual(plain(mod.segmentsFor(BREEZE, {})), [
    { id: "design", modeValue: "voice_design" },
    { id: "clone", modeValue: "voice_clone" }
  ]);
});

test("单个模式：只有一颗分段——控件整体没有意义（调用方据此隐藏）", () => {
  assert.deepEqual(plain(mod.segmentsFor([{ value: "voice_design", label: "Voice design" }], {})), [
    { id: "design", modeValue: "voice_design" }
  ]);
  // 没有可选模式时一颗都不解析
  assert.deepEqual(plain(mod.segmentsFor([], {})), []);
  assert.deepEqual(plain(mod.segmentsFor(null, {})), []);
});

test("未知选项值：那颗分段省略，其它照常，绝不抛异常", () => {
  // fast/slow 谁都不匹配 → 一颗都没有
  assert.deepEqual(plain(mod.segmentsFor([{ value: "fast" }, { value: "slow" }], {})), []);
  // 一个未知 + 一个可识别：只出可识别的那颗
  assert.deepEqual(plain(mod.segmentsFor([{ value: "fast" }, { value: "voice_clone" }], {})), [
    { id: "clone", modeValue: "voice_clone" }
  ]);
  // 畸形输入也按「不解析」处理，不抛
  assert.deepEqual(plain(mod.segmentsFor("nope", {})), []);
  assert.deepEqual(plain(mod.segmentsFor([null, 42, {}, { value: "" }, { label: "clone" }], {})), []);
  assert.deepEqual(plain(mod.segmentsFor([{ value: "voice_clone" }], {})), [
    { id: "clone", modeValue: "voice_clone" }
  ]);
});

test("英文 / 中文标签与 value 的小写子串都参与匹配", () => {
  // 纯英文 value + label
  assert.deepEqual(plain(mod.segmentsFor([
    { value: "design_mode", label: "Voice design" },
    { value: "ref_clone", label: "Clone" }
  ], {})), [
    { id: "design", modeValue: "design_mode" },
    { id: "clone", modeValue: "ref_clone" }
  ]);
  // 中文 label（没有英文 value 也能命中）
  assert.deepEqual(plain(mod.segmentsFor([
    { value: "m1", label: "音色设计" },
    { value: "m2", label: "参考音频克隆" }
  ], {})), [
    { id: "design", modeValue: "m1" },
    { id: "clone", modeValue: "m2" }
  ]);
  // instruct / prompt 等词同样算「设计」
  assert.deepEqual(plain(mod.segmentsFor([{ value: "instruct_me" }, { value: "x" }], {})), [
    { id: "design", modeValue: "instruct_me" }
  ]);
  assert.deepEqual(plain(mod.segmentsFor([{ value: "prompt_voice" }], {})), [
    { id: "design", modeValue: "prompt_voice" }
  ]);
});

test("认领制：一个选项只归一颗分段，library 的词最宽所以排最后", () => {
  // 三个选项都含 "voice"：design/clone 先把前两个认领走，library 只剩 voice_library
  assert.deepEqual(plain(mod.segmentsFor([
    { value: "voice_design" },
    { value: "voice_clone" },
    { value: "voice_library" }
  ], {})), [
    { id: "design", modeValue: "voice_design" },
    { id: "clone", modeValue: "voice_clone" },
    { id: "library", modeValue: "voice_library" }
  ]);
  // 设计词与克隆词同时出现（"voice_design_clone"）：先匹配的 design 认领
  assert.deepEqual(plain(mod.segmentsFor([{ value: "voice_design_clone" }], {})), [
    { id: "design", modeValue: "voice_design_clone" }
  ]);
});

test("preset / 音色库：这些词只归 library", () => {
  assert.deepEqual(plain(mod.segmentsFor([{ value: "speaker_preset" }], {})), [
    { id: "library", modeValue: "speaker_preset" }
  ]);
  assert.deepEqual(plain(mod.segmentsFor([{ value: "voice_library_zh" }], {})), [
    { id: "library", modeValue: "voice_library_zh" }
  ]);
});

test("library 兜底：没有 library 模式但模型带音色选择器时，modeValue 为 null", () => {
  assert.deepEqual(plain(mod.segmentsFor(BREEZE, { hasVoicePicker: true })), [
    { id: "design", modeValue: "voice_design" },
    { id: "clone", modeValue: "voice_clone" },
    { id: "library", modeValue: null }
  ]);
  // 没有音色选择器又没有 library 模式：这颗分段不解析
  assert.deepEqual(plain(mod.segmentsFor(BREEZE, { hasVoicePicker: false })), [
    { id: "design", modeValue: "voice_design" },
    { id: "clone", modeValue: "voice_clone" }
  ]);
  // 兜底不制造控件：只有一个模式 + 一个选择器仍只有两颗（再少一种模式就 <2 → 隐藏）
  assert.deepEqual(plain(mod.segmentsFor([{ value: "voice_clone" }], { hasVoicePicker: true })), [
    { id: "clone", modeValue: "voice_clone" },
    { id: "library", modeValue: null }
  ]);
});

test("targetFor：返回要选中的精确选项值；没解析 / 是快捷键时为 null", () => {
  assert.equal(mod.targetFor("design", BREEZE), "voice_design");
  assert.equal(mod.targetFor("clone", BREEZE), "voice_clone");
  // library 在 Breeze 上不是模式，是「聚焦选择器」→ null（调用方不改模式）
  assert.equal(mod.targetFor("library", BREEZE), null);
  assert.equal(mod.targetFor("library", [{ value: "voice_library" }]), "voice_library");
  // 未知分段 id / 空选项
  assert.equal(mod.targetFor("nope", BREEZE), null);
  assert.equal(mod.targetFor("design", null), null);
});

test("activeSegment：当前下拉值落在哪颗分段上", () => {
  const caps = { modeOptions: BREEZE, hasVoicePicker: true };
  assert.equal(mod.activeSegment("voice_design", caps), "design");
  assert.equal(mod.activeSegment("voice_clone", caps), "clone");
  // 不在任何分段里 / 空值 / 没有下拉
  assert.equal(mod.activeSegment("something_else", caps), null);
  assert.equal(mod.activeSegment("", caps), null);
  assert.equal(mod.activeSegment(null, caps), null);
  // library 是快捷键（modeValue null），永远不会被高亮
  assert.equal(mod.activeSegment("voice_design", { modeOptions: BREEZE }), "design");

  // 也可以传算好的 segments（视图只算一次的契约）
  const segments = plain(mod.segmentsFor(BREEZE, {}));
  assert.equal(mod.activeSegment("voice_clone", { segments }), "clone");
  assert.equal(mod.activeSegment("voice_clone", { segments: [] }), null);
  assert.equal(mod.activeSegment("voice_clone", null), null);
});
