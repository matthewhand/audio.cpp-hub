/* #72 单元测试：web/wav.js（WAV 编码/裁剪/量化、格式化、预热容错）。
   通过 node:vm 加载 classic script，不修改前端。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readWeb, runClassic, makeBrowserSandbox } from "./helpers/vm.mjs";

function loadWav() {
  const sandbox = makeBrowserSandbox({ Blob, console, setTimeout });
  runClassic(readWeb("wav.js"), sandbox, "wav.js");
  return sandbox.window.WavUtil;
}

function fakeAudioBuffer(channels, sampleRate = 8000) {
  return {
    sampleRate,
    length: channels[0].length,
    numberOfChannels: channels.length,
    duration: channels[0].length / sampleRate,
    getChannelData: (c) => Float32Array.from(channels[c])
  };
}

async function readWav(blob) {
  const ab = await blob.arrayBuffer();
  return new DataView(ab);
}

test("wav: 空加载后导出四个工具函数", () => {
  const W = loadWav();
  assert.equal(typeof W.audioBufferToWav, "function");
  assert.equal(typeof W.formatDuration, "function");
  assert.equal(typeof W.formatSize, "function");
  assert.equal(typeof W.warmAudioOutput, "function");
});

test("wav: 编码 PCM16 单声道头与数据长度", async () => {
  const W = loadWav();
  const buf = fakeAudioBuffer([[0, 0.5, -0.5, 1], [0, 0, 0, 0]], 8000);
  const blob = W.audioBufferToWav(buf);
  assert.equal(blob.type, "audio/wav");
  const dv = await readWav(blob);
  const str = (off) => String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
  assert.equal(str(0), "RIFF");
  assert.equal(str(8), "WAVE");
  assert.equal(str(12), "fmt ");
  assert.equal(str(36), "data");
  assert.equal(dv.getUint32(16, true), 16);
  assert.equal(dv.getUint16(20, true), 1);
  assert.equal(dv.getUint16(22, true), 1);
  assert.equal(dv.getUint32(24, true), 8000);
  assert.equal(dv.getUint32(28, true), 16000);
  assert.equal(dv.getUint16(32, true), 2);
  assert.equal(dv.getUint16(34, true), 16);
  assert.equal(dv.getUint32(40, true), 4 * 2);
  assert.equal(dv.getUint32(4, true), 36 + 4 * 2);
});

test("wav: 双声道混单声道求平均", async () => {
  const W = loadWav();
  const buf = fakeAudioBuffer([[1, -1], [-1, 1]]);
  const dv = await readWav(W.audioBufferToWav(buf));
  assert.equal(dv.getInt16(44, true), 0);
  assert.equal(dv.getInt16(46, true), 0);
});

test("wav: 裁剪区间只编码所选样点", async () => {
  const W = loadWav();
  // 0.001s = 8 样点 @8000Hz；取 [8,16) → 8 个样点
  const samples = Array.from({ length: 32 }, (_, i) => i / 32);
  const dv = await readWav(W.audioBufferToWav(fakeAudioBuffer([samples]), 0.001, 0.002));
  assert.equal(dv.getUint32(40, true), 8 * 2);
});

test("wav: 越界/空区间不抛错且数据长度为 0", async () => {
  const W = loadWav();
  const dv = await readWav(W.audioBufferToWav(fakeAudioBuffer([[0.1, 0.2]]), 5, 10));
  assert.equal(dv.getUint32(40, true), 0);
});

test("wav: 样点幅度钳制到 int16 边界", async () => {
  const W = loadWav();
  const dv = await readWav(W.audioBufferToWav(fakeAudioBuffer([[2, -2]])));
  assert.equal(dv.getInt16(44, true), 0x7fff);
  assert.equal(dv.getInt16(46, true), -0x8000);
});

test("wav: formatDuration", () => {
  const W = loadWav();
  assert.equal(W.formatDuration(null), "-");
  assert.equal(W.formatDuration(Infinity), "-");
  assert.equal(W.formatDuration(NaN), "-");
  assert.equal(W.formatDuration(0), "0:00.0");
  assert.equal(W.formatDuration(9.5), "0:09.5");
  assert.equal(W.formatDuration(65.4), "1:05.4");
});

test("wav: formatSize", () => {
  const W = loadWav();
  assert.equal(W.formatSize(null), "-");
  assert.equal(W.formatSize(0), "0 B");
  assert.equal(W.formatSize(1023), "1023 B");
  assert.equal(W.formatSize(1024), "1.0 KB");
  assert.equal(W.formatSize(1536), "1.5 KB");
  assert.equal(W.formatSize(1024 * 1024), "1.00 MB");
});

test("wav: warmAudioOutput 在缺少 AudioContext 时不抛错", () => {
  const W = loadWav();
  assert.doesNotThrow(() => W.warmAudioOutput());
  // 缺少 AudioContext 时不应留下半初始化状态
  assert.doesNotThrow(() => W.warmAudioOutput());
});
