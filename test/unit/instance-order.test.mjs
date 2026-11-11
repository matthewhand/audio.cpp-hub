/* 实例卡片排序：sortInstances 必须是全序，且与选中态 / 忙碌态无关——
   否则 2s 轮询重画时卡片会在列表里跳来跳去（选中的卡片一会儿在顶部一会儿在底部）。
   函数从真实源码里抽出来在 node:vm 里求值。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFunction, readWeb } from "./helpers/vm.mjs";

const { sortInstances } = (() => {
  const src = readWeb("modules/instances.js");
  const code = extractFunction(src, "sortInstances");
  return new Function(`"use strict"; ${code}; return { sortInstances };`)();
})();

function inst(over) {
  return Object.assign(
    {
      id: "id",
      instanceName: "name",
      modelId: "model",
      status: "READY",
      createdAt: "2026-01-01T00:00:00.000Z"
    },
    over
  );
}

/* Fisher-Yates：给定种子 deterministic 打乱，用来反复验证同一输出 */
function shuffle(list, seed) {
  const arr = list.slice();
  let s = seed >>> 0 || 1;
  for (let i = arr.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const order = (list) =>
  sortInstances(list)
    .map((i) => i.id)
    .join(",");

test("sortInstances：状态 → createdAt → name → id 的全序", () => {
  const list = [
    inst({ id: "a", status: "STOPPED", createdAt: "2026-01-01T00:00:00.000Z" }),
    inst({ id: "b", status: "STARTING", createdAt: "2026-01-01T00:00:05.000Z" }),
    inst({ id: "c", status: "READY", createdAt: "2026-01-01T00:00:09.000Z" }),
    inst({ id: "d", status: "READY", createdAt: "2026-01-01T00:00:01.000Z" }),
    inst({ id: "e", status: "READY", createdAt: "2026-01-01T00:00:01.000Z", instanceName: "aaa" }),
    inst({ id: "f", status: "ERROR", createdAt: "" })
  ];
  // 就绪（按 createdAt，同一时刻按 name）→ 启动中 → 其它（空 createdAt 排在前）
  const want = "e,d,c,b,f,a";
  assert.equal(order(list), want);
  // 同一份输入任何顺序喂进去都一样
  for (let seed = 1; seed <= 200; seed++) {
    assert.equal(order(shuffle(list, seed)), want);
  }
});

test("sortInstances：选中态与忙碌态不参与排序", () => {
  const list = [
    inst({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" }),
    inst({ id: "b", createdAt: "2026-01-01T00:00:01.000Z" }),
    inst({ id: "c", createdAt: "2026-01-01T00:00:02.000Z" })
  ];
  const base = order(list);
  // 选中 b / 标记 b 与 c 正在生成 / 把 taskCount 抬高等「易变字段」全部改一遍
  const noisy = list.map((i, n) => ({
    ...i,
    selected: n === 1,
    busy: n !== 0,
    taskCount: n === 1 ? 3 : 0,
    memory: { busy: n === 1, ramBytes: n * 1024 }
  }));
  assert.equal(order(noisy), base);
  assert.equal(order(noisy.reverse()), base);
  // id 兜底：同状态、同 createdAt、同名字时仍比得出结果
  const ties = [
    inst({ id: "zz", instanceName: "same", createdAt: "same" }),
    inst({ id: "aa", instanceName: "same", createdAt: "same" })
  ];
  assert.equal(order(ties), "aa,zz");
  assert.equal(order(ties.slice().reverse()), "aa,zz");
});

test("sortInstances：不改入参，空 / 非数组输入安全", () => {
  const list = [inst({ id: "b" }), inst({ id: "a" })];
  const copy = list.slice();
  sortInstances(list);
  assert.deepEqual(list, copy);
  assert.deepEqual(sortInstances(null), []);
  assert.deepEqual(sortInstances(undefined), []);
  assert.deepEqual(sortInstances("nope"), []);
  // 缺字段的旧数据不抛错
  assert.deepEqual(
    sortInstances([{ id: "x" }, {}]).map((i) => i.id || ""),
    ["", "x"]
  );
});

/* #174：渲染路径真的用上了全序排序与内存条（源码契约，防止回退成按状态的不稳定排序 / 文本行）。 */
test("renderInstanceList 使用 sortInstances、memBlockHtml 与 applyMemBars", () => {
  const src = readWeb("modules/instances.js");
  const body = extractFunction(src, "renderInstanceList");
  assert.match(body, /sortInstances\(instances\)/);
  assert.match(body, /memBlockHtml\(withSparkSeries\(inst\)\)/);
  assert.match(body, /applyMemBars\(list\)/);
  assert.doesNotMatch(body, /instance\.memoryLegend/);
});

const { readyInstancesForModel, preferredReadyInstance } = (() => {
  const src = readWeb("modules/instances.js");
  const helpers = ["sortInstances", "readyInstancesForModel", "preferredReadyInstance"]
    .map((name) => extractFunction(src, name))
    .join("\n");
  return new Function(
    `"use strict"; ${helpers}; return { readyInstancesForModel, preferredReadyInstance };`
  )();
})();

test("selects the most recently used READY instance for the current model", () => {
  const list = [
    inst({ id: "old" }),
    inst({ id: "new", createdAt: "2026-01-02T00:00:00.000Z" }),
    inst({ id: "starting", status: "STARTING" }),
    inst({ id: "stopped", status: "STOPPED" }),
    inst({ id: "wrong-model", modelId: "other" })
  ];
  const recent = ["wrong-model", "stopped", "starting", "old", "new"];
  assert.equal(preferredReadyInstance(readyInstancesForModel(list, "model"), recent), "old");
  assert.equal(preferredReadyInstance(readyInstancesForModel(list.slice(1), "model"), recent), "new");
  assert.equal(preferredReadyInstance(readyInstancesForModel(list, "other"), recent), "wrong-model");
  assert.equal(preferredReadyInstance(readyInstancesForModel(list, "missing"), recent), null);
});

test("defaults to the newest READY instance regardless of response order", () => {
  const list = [
    inst({ id: "old" }),
    inst({ id: "new", createdAt: "2026-01-02T00:00:00.000Z" }),
    inst({ id: "starting", status: "STARTING", createdAt: "2026-01-03T00:00:00.000Z" })
  ];
  for (const feed of [list, list.slice().reverse()]) {
    assert.equal(preferredReadyInstance(readyInstancesForModel(feed, "model"), ["missing"]), "new");
  }
});

test("uses a stable default when READY instances share a timestamp", () => {
  const list = [inst({ id: "a" }), inst({ id: "b" }), inst({ id: "c", status: "STOPPED" })];
  for (const feed of [list, list.slice().reverse()]) {
    assert.equal(preferredReadyInstance(readyInstancesForModel(feed, "model"), []), "b");
  }
});
