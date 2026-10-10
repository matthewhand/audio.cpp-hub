/* web/modules/elapsed.js — 生成耗时的唯一起点
 *
 * 卡片徽标、工具栏徽标、合成按钮下的状态行都读这张表，并且只由
 * instances.js 的一个 setInterval 重画。表在 innerHTML 重绘之后仍然在，
 * 所以 2s 轮询把节点换掉也不会把起点改成「这一帧的现在」。
 *
 * 起点：服务端 task.startedAt，否则 SSE task.started 的 ts，否则第一次
 * 看到这条任务的客户端时间。同一条任务之后更大的时间戳丢弃（排队→运行
 * 若把 startedAt 换成更晚的值，耗时会倒退）。比本地时钟超前 2s 以上的
 * 服务端时间、以及「这条 SSE 自称是现在」但和本地钟差超过 2s 的 ts，
 * 改用客户端收到的时间。展示时把未来起点钳到 now，不写回表。
 * 任务结束时清掉；同一实例上的下一条任务用自己的起点，不继承上一条。 */

export const ELAPSED_TICK_MS = 200;
export const SKEW_MS = 2000;

/** @type {Map<string, number>} */
const anchors = new Map();
/** @type {Map<string, number>} */
const received = new Map();
/** @type {Map<string, string>} instanceId → 当前占着这台实例的 taskId */
const instTask = new Map();

export function finiteMs(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 展示用起点：未来的锚钳到 now，不修改存下来的值。 */
export function displayStartMs(stored, now) {
  const start = finiteMs(stored);
  const n = finiteMs(now);
  if (start == null || n == null) return null;
  return start > n ? n : start;
}

/**
 * 从一次观测里选出候选起点。纯函数。
 * startedAt 优先于 sseTs。服务端时间比 now 超前超过 SKEW_MS，
 * 或者这是一条 live SSE 且 |ts-now| 超过 SKEW_MS，改用 receivedAt。
 * 过去的 startedAt（任务已经跑了一段时间）照实采用，不当作时钟偏差。
 * @param {{startedAt?:*, sseTs?:*, receivedAt?:*, now?:*, live?:boolean}} obs
 * @returns {number|null}
 */
export function candidateStartMs(obs) {
  const now = finiteMs(obs && obs.now) || Date.now();
  const receivedAt = finiteMs(obs && obs.receivedAt);
  const started = finiteMs(obs && obs.startedAt);
  const sse = finiteMs(obs && obs.sseTs);
  const server = started != null ? started : sse;
  if (server != null) {
    const futureSkew = server > now + SKEW_MS;
    const liveSkew = started == null && sse != null && !!(obs && obs.live) && Math.abs(server - now) > SKEW_MS;
    if (futureSkew || liveSkew) return receivedAt != null ? receivedAt : now;
    return server;
  }
  return receivedAt;
}

function taskKey(id) { return "task:" + id; }
function instKey(id) { return "inst:" + id; }

/**
 * 记住一条任务 / 一台实例的起点。同一 taskId 不会被更大的时间戳覆盖。
 * 换了 taskId 的实例改用新任务自己的起点。
 * @param {{taskId?:*, instanceId?:*}} ids
 * @param {{startedAt?:*, sseTs?:*, receivedAt?:*, now?:*, live?:boolean}} obs
 * @returns {number|null}
 */
export function rememberStart(ids, obs) {
  const now = finiteMs(obs && obs.now) || Date.now();
  const taskId = ids && ids.taskId ? String(ids.taskId) : "";
  const instanceId = ids && ids.instanceId ? String(ids.instanceId) : "";
  if (!taskId && !instanceId) return null;
  const tk = taskId ? taskKey(taskId) : "";
  const ik = instanceId ? instKey(instanceId) : "";
  const given = finiteMs(obs && obs.receivedAt);
  const rebound = !!(taskId && instanceId && instTask.get(instanceId) && instTask.get(instanceId) !== taskId);

  let recvAt;
  if (rebound) {
    if (!received.has(tk)) received.set(tk, given != null ? given : now);
    recvAt = received.get(tk);
  } else {
    if (tk && !received.has(tk)) received.set(tk, given != null ? given : now);
    if (ik && !received.has(ik)) received.set(ik, given != null ? given : now);
    recvAt = null;
    for (const k of [tk, ik]) {
      if (!k || !received.has(k)) continue;
      const v = received.get(k);
      if (recvAt == null || v < recvAt) recvAt = v;
    }
  }

  const candidate = candidateStartMs({ ...(obs || {}), now, receivedAt: recvAt });
  let prev = tk && anchors.has(tk) ? anchors.get(tk) : null;
  // 卡片先按 instanceId 记下的锚，第一条带 taskId 的观测要继承，不能换成更晚的 startedAt。
  // 已经绑到另一条任务上的实例锚不继承（那是上一条任务）。
  if (tk && prev == null && ik && anchors.has(ik)) {
    const bound = instTask.get(instanceId);
    if (!bound || bound === taskId) prev = anchors.get(ik);
  }
  if (!tk && ik && anchors.has(ik)) prev = anchors.get(ik);
  let next = candidate;
  if (prev != null && (next == null || next > prev)) next = prev;
  if (next == null) return prev;

  if (tk) anchors.set(tk, next);
  if (ik) {
    anchors.set(ik, next);
    if (taskId) instTask.set(instanceId, taskId);
    if (rebound) received.set(ik, recvAt);
  }
  return next;
}

/** 存下来的起点（未钳制）。taskId 或 instanceId 都行。 */
export function rawStartMs(id) {
  if (id == null || id === "") return null;
  const s = String(id);
  if (anchors.has(taskKey(s))) return anchors.get(taskKey(s));
  if (anchors.has(instKey(s))) return anchors.get(instKey(s));
  return null;
}

/** 展示用起点。taskId 或 instanceId。没有记录时返回 null。 */
export function taskStartMs(id, nowMs) {
  const stored = rawStartMs(id);
  if (stored == null) return null;
  return displayStartMs(stored, finiteMs(nowMs) || Date.now());
}

export function hasActiveStarts() {
  return anchors.size > 0;
}

/** 任务结束时调用。只清这条任务；同实例上另一条仍占着起点时不动实例键。 */
export function clearTaskStart(ids) {
  const taskId = ids && ids.taskId ? String(ids.taskId) : "";
  const instanceId = ids && ids.instanceId ? String(ids.instanceId) : "";
  if (taskId) {
    anchors.delete(taskKey(taskId));
    received.delete(taskKey(taskId));
  }
  if (instanceId) {
    const bound = instTask.get(instanceId);
    if (!taskId || !bound || bound === taskId) {
      anchors.delete(instKey(instanceId));
      received.delete(instKey(instanceId));
      instTask.delete(instanceId);
    }
  }
}

/** 测试复位。生产路径不调用。 */
export function resetElapsed() {
  anchors.clear();
  received.clear();
  instTask.clear();
}
