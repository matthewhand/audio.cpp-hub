/* Now / Queue 状态条 e2e：真实渲染路径（首屏静态外壳 + 任务数据 + 取消请求）。
   不用 page.route 直接造响应，而是走 MockBackend 的 GET /api/tasks 与
   DELETE /api/tasks/{id}，因此断言的是「hub 真的报了什么，界面就画什么」。 */
import { test, expect } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

const READY = {
  id: "i1",
  modelId: "supertonic",
  instanceName: "breeze",
  status: "READY",
  backend: "cpu",
  device: 0,
  port: 19001,
  taskCount: 1
};

const INSTANCES = [
  READY,
  Object.assign({}, READY, { id: "i2", instanceName: "siren", port: 19002 })
];

function nowQueue(page) {
  return page.locator("#now-queue");
}

test("状态条隐藏 → 空闲时显示 0 / cap + free chips → 有任务时画 chip", async ({ page }) => {
  const backend = new MockBackend({ instances: INSTANCES });
  await openApp(page, backend, { modelId: "supertonic", lang: "zh" });

  // 没有在途任务但有就绪实例：收成一行紧凑的「In flight 0 / 2」+ 两枚 free chip
  const strip = nowQueue(page);
  await expect(strip).toBeVisible();
  await expect(strip).toHaveClass(/is-idle/);
  await expect(strip.locator(".nq-cap")).toHaveText("进行中 0 / 2");
  await expect(strip.locator(".nq-slot.free")).toHaveCount(2);
  await expect(strip.locator(".nq-qchip")).toHaveCount(0);

  // 一条运行中 + 一条排队：chip、位次、耗时、取消键都出现
  const now = Date.now();
  backend.tasks.push({
    id: "t9001",
    modelId: "supertonic",
    category: "tts",
    status: "RUNNING",
    createdAt: now - 3200,
    startedAt: now - 3200,
    finishedAt: null,
    text: "欢迎回到演播室，今天也一起把音频做完",
    instanceId: "i1",
    instanceName: "breeze",
    position: 0
  });
  backend.tasks.push({
    id: "t9002",
    modelId: "supertonic",
    category: "tts",
    status: "QUEUED",
    createdAt: now - 4000,
    startedAt: null,
    finishedAt: null,
    text: "第二条排队任务",
    instanceId: "i2",
    instanceName: "siren",
    position: 0
  });

  await expect(strip.locator(".nq-cap").first()).toHaveText("进行中 1 / 2", { timeout: 20000 });
  await expect(strip.locator(".nq-slot:not(.free)")).toHaveCount(1);
  await expect(strip.locator(".nq-slot.free")).toHaveCount(1);
  await expect(strip.locator(".nq-qchip")).toHaveCount(1);

  // 运行中 chip：实例名 + 摘要 + 共享计时器写的耗时
  const running = strip.locator(".nq-slot:not(.free)");
  await expect(running.locator(".nq-n").first()).toHaveText("breeze");
  await expect(running.locator(".nq-q")).toContainText("欢迎回到演播室");
  await expect(running.locator("[data-elapsed-id='t9001']")).toBeVisible();
  await expect(running.locator("[data-elapsed-id='t9001']")).toHaveText(/^\d+(\.\d+)?s$|^\d+m /);

  // 排队 chip：位次 + 实例 + 已等待（秒级会自己跳，不需要重画整条）
  const queued = strip.locator(".nq-qchip");
  await expect(queued.locator(".nq-n").first()).toHaveText("#1");
  await expect(queued.locator(".nq-n").nth(1)).toHaveText("siren");
  await expect(queued.locator("[data-wait-at]")).toHaveText(/^\d+(\.\d+)?s$|^\d+m /);

  // 没有就绪实例也没有在途任务时整条收起
  backend.tasks.length = 0;
  backend.instances.length = 0;
  await expect(strip).toBeHidden({ timeout: 20000 });
});

test("状态条的取消键单击即取消（DELETE 一次），不弹确认框", async ({ page }) => {
  const backend = new MockBackend({ instances: [READY] });
  await openApp(page, backend, { modelId: "supertonic", lang: "en" });

  const now = Date.now();
  backend.tasks.push({
    id: "t9101",
    modelId: "supertonic",
    category: "tts",
    status: "RUNNING",
    createdAt: now - 1200,
    startedAt: now - 1200,
    finishedAt: null,
    text: "cancel me",
    instanceId: "i1",
    instanceName: "breeze",
    position: 0
  });

  const strip = nowQueue(page);
  const cancel = strip.locator(".nq-x").first();
  await expect(cancel).toBeVisible({ timeout: 20000 });
  // aria-label 带实例名（en 词典），title 带短任务 id
  await expect(cancel).toHaveAttribute("aria-label", /breeze/);
  await expect(cancel).toHaveAttribute("title", /t9101/);

  await cancel.click();

  await expect
    .poll(() => backend.tasks.filter((t) => t.status === "CANCELLED").length, { timeout: 10000 })
    .toBe(1);
  const deletes = backend.requests.filter(
    (r) => r.method === "DELETE" && /\/api\/tasks\/t9101/.test(r.path)
  );
  expect(deletes).toHaveLength(1);
});

test("农场摘要的 inFlightCap 决定容量与 free chip 数量", async ({ page }) => {
  const backend = new MockBackend({ instances: INSTANCES });
  backend.farm = { available: true, hubsUp: 1, hubsTotal: 1, failures: 0, inFlightCap: 3 };
  await openApp(page, backend, { modelId: "supertonic", lang: "zh" });

  const strip = nowQueue(page);
  // 摘要到位后 cap 从兜底的 2 变成农场报的 3，空闲时 free chip 相应多一枚
  await expect(strip.locator(".nq-cap")).toHaveText("进行中 0 / 3", { timeout: 20000 });
  await expect(strip.locator(".nq-slot.free")).toHaveCount(3);
});
