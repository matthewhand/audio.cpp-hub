/* web/modules/state.js — 跨模块共享的可变状态
 *
 * 只收「有多个功能模块读、且有多个功能模块写」的绑定：模型清单、可执行文件、
 * 启动配置、当前选中模型、当前实例。ES 模块的 import 是活绑定（读永远看到最新值），
 * 但**不能给导入的绑定赋值**，所以每个可写绑定额外导出一个 setXxx()，
 * 写方一律走 setter——比「到处 window.state.models = …」更早暴露拼写错误。
 *
 * 单一写方的状态不进这里：下载任务、实例列表、面板表单等仍与各自功能模块放在一起，
 * 见 web/README.md 的模块图。 */

export let models = [];
export let executables = [];
export let profiles = [];
export let selectedModelId = null;
export let activeInstanceId = null;

export const selectedModel = () => models.find(m => m.id === selectedModelId);

/* 写入口：只有 models.js（模型清单 / 当前模型）、settings.js（可执行文件）、
   launch.js（启动配置）、instances.js（当前实例）会调，其余模块一律只读。 */
export function setModels(next) { models = next; }
export function setExecutables(next) { executables = next; }
export function setProfiles(next) { profiles = next; }
export function setSelectedModelId(next) { selectedModelId = next; }
export function setActiveInstanceId(next) { activeInstanceId = next; }

export function modelConfigured(m) {
  const weightsOk = profiles.some(x => x.modelId === m.id && x.weightsPath && x.weightsExists !== false);
  return weightsOk && executables.some(e => e.exists);
}

/* 正在生成的实例 id。task-events.js 就地增删（SSE task.started / 终态），
   instances.js 只读。放在这个叶子模块里，避免两边互相 import。 */

/* SSE 已知的「正在生成」状态（task-events.js 写，instances.js 只读）：
   busyStarts —— instanceId → 该实例当前 RUNNING 任务的 task.started 时间戳
   （毫秒；事件没带 ts 时为 null），有键即「SSE 说这个实例在忙」；流断开时
   整表清空（任务可能已经在断流期间结束，留着会让徽标永远亮着），busy 判定
   此后整体回退到轮询数据；
   runningStarts —— instanceId → RUNNING 任务的 startedAt，来自任务轮询
   （tasks.js 写），SSE 不可用时给「生成中…」补一个计时起点。
   两份表同源互补：busyStarts 即时但不覆盖重连前的任务，runningStarts 慢一点
   却总能从轮询数据里拿到。 */
export const busyStarts = new Map();
export const runningStarts = new Map();

/* instanceId → last terminal task finishedAt (ms). instances.js reads this when
   memory.idleSinceMs is absent. tasks.js and activity.js write it. */
export const idleFallbacks = new Map();

export function noteIdleFallback(instanceId, finishedAt) {
  if (!instanceId) return;
  const ts = Number(finishedAt);
  if (!Number.isFinite(ts) || ts <= 0) return;
  const prev = idleFallbacks.get(instanceId) || 0;
  if (ts >= prev) idleFallbacks.set(instanceId, ts);
}
