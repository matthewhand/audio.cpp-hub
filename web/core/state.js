/* 全局可变状态：所有特性模块共享同一份 store（对应原 app.js 顶部散落的模块级变量）。
   纯模块私有的缓存（如设备探测缓存、菜单元素）留在各自模块内，不进这里。 */
export const state = {
  // 模型 / 实例 / 可执行文件 / 配置
  models: [],
  instances: [],
  executables: [],
  profiles: [],
  selectedModelId: null,
  activeInstanceId: null,
  // TTS 交互态
  breezeMode: "voice_design",
  emotionMode: "none",
  emotionVector: new Array(8).fill(0),
  ttsVariant: "base",
  ttsLanguageSel: null,
  asrLanguageSel: null,
  otherLanguageSel: null,
  speakerPickers: [],
  // 参考音频选择器实例（entry 初始化时创建；面板 handler 运行时读取）
  voicePicker: null,
  emotionPicker: null,
  asrAudioPicker: null,
  sepAudioPicker: null,
  otherAudioPicker: null,
  otherVoicePicker: null,
  // 任务 / 事件
  taskViews: new Map(),      // taskId → 已知任务（进行中 + 已完成保留展示）
  taskDetails: new Map(),    // taskId → 已展开的完整结果文本
  activePolls: new Map(),    // taskId → intervalId
  // 侧栏历史
  sidebarHistoryItems: [],
  sidebarGroups: [],
  groupCollapsed: new Map(), // 组折叠状态（未分组为 ""）
  historyDetails: new Map(), // taskId → 完整历史记录（详情展开缓存）
  sidebarRows: new Map(),    // key → { node, sig } 侧栏行节点复用缓存
  // 下载
  downloads: [],
  mdlPackages: null,
  mdlModel: null,
};

export const VIBEVOICE_MAX_SPEAKERS = 4;

/** 当前选中的模型条目。 */
export const selectedModel = () => state.models.find(m => m.id === state.selectedModelId);

/** 当前选中模型的 id（历史按 modelId 隔离）。 */
export function historyModelId() {
  const m = selectedModel();
  return m ? m.id : null;
}
