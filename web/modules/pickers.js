/* web/modules/pickers.js — 表单选择器实例
 *
 * 五类面板里所有参考音频 / 说话人入口的 VoiceSelect 与 AudioPicker 实例，
 * 在模块求值时一次性创建（TTS 音色、情感参考、ASR / 分离 / 其它输入、其它音色）。
 * 抽出这一层是为了让面板与历史载入共用同一批实例，
 * 也保证「重渲染后统一刷新标签」（window.__audioPickers / __voiceSelects）只有一个挂载点。
 *
 * VoiceSelect / AudioPicker 本身仍是经典脚本（web/voice-select.js、web/audio-picker.js），
 * 各自维护 window 全局，本模块不重新实现。 */

import { $ } from "./dom.js";

export const voicePicker = new VoiceSelect($("voice-picker"), "picker.speakerRef", {
  onChange: (v) => { const rt = $("tts-reference-text"); if (v && v.text && rt) rt.value = v.text; }
});
export const emotionPicker = new VoiceSelect($("emotion-picker"), "picker.emotionRef");
export const asrAudioPicker = new AudioPicker($("asr-audio-picker"), "picker.inputRequired");
export const sepAudioPicker = new AudioPicker($("sep-audio-picker"), "picker.inputRequired");
export const otherAudioPicker = new AudioPicker($("other-audio-picker"), "picker.input");
export const otherVoicePicker = new VoiceSelect($("other-voice-picker"), "picker.voiceRef");
