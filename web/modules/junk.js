/* web/modules/junk.js — 用量看板与最近活动共用的测试任务过滤。
 *
 * 空的 modelId 对看板仍然是垃圾。活动行要同时看 modelId 和实例名：
 * 只有名字空、实例 id 也空，才算没有身份。单独缺实例名不算。
 * 模型目录为空或没有时，不做「不在目录里」这一条（首屏目录还没到）。 */

const JUNK_LABEL = /^(?:nonexistent.*|test[_-]?model.*|race[-_ ]?\d*|probe.*|bench(?:mark)?[-_ ]?\d*|dummy.*|tmp.*)$/i;

/** 一个名字本身像不像探针 / 测试模型。空串不算（空由调用方决定）。 */
export function isJunkLabel(value) {
  const s = String(value == null ? "" : value).trim();
  if (!s) return false;
  return JUNK_LABEL.test(s);
}

/** 用量看板：空 modelId、nonexistent*、test model，以及与活动同一套探针名。 */
export function isJunkStatsModel(m) {
  const id = String(m && m.modelId || "").trim();
  if (!id) return true;
  return isJunkLabel(id);
}

function clean(v) {
  return String(v == null ? "" : v).trim();
}

/**
 * 活动行是不是测试任务。
 * modelId、实例名、实例上的 modelId 任一个撞上探针名就算。
 * 目录可用时：实例不在当前实例列表里，且模型也不在目录里，也算。
 * @param {any} row
 * @param {{instances?:any[], models?:any[]|null}} [ctx]
 */
export function isJunkActivityRow(row, ctx) {
  if (!row) return true;
  const modelId = clean(row.modelId);
  let instanceName = clean(row.instanceName);
  const instanceId = clean(row.instanceId);
  const instList = ctx && Array.isArray(ctx.instances) ? ctx.instances : [];
  const hit = instanceId ? instList.find(i => i && String(i.id) === instanceId) : null;
  if (hit && !instanceName) instanceName = clean(hit.instanceName || hit.name);
  const modelFromInst = hit ? clean(hit.modelId) : "";
  if (isJunkLabel(modelId) || isJunkLabel(instanceName) || isJunkLabel(modelFromInst) || isJunkLabel(instanceId)) {
    return true;
  }
  if (!modelId && !instanceName && !modelFromInst && !instanceId) return true;

  const models = ctx && ctx.models;
  if (!Array.isArray(models) || models.length === 0) return false;
  const inInst = !!hit || instList.some(i => {
    if (!i) return false;
    if (modelId && clean(i.modelId) === modelId) return true;
    if (instanceName && clean(i.instanceName || i.name) === instanceName) return true;
    return false;
  });
  if (inInst) return false;
  const inCat = models.some(m => {
    if (!m) return false;
    const id = clean(m.id || m.modelId);
    if (modelId && id === modelId) return true;
    if (modelFromInst && id === modelFromInst) return true;
    return false;
  });
  return !inCat;
}
