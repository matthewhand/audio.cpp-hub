/* 基建冒烟：确认静态服务 + mock 后端 + 首屏渲染可用。 */
import { test, expect } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

test("首屏加载：模型列表与默认面板渲染", async ({ page }) => {
  const backend = new MockBackend({
    instances: [
      {
        id: "i1",
        modelId: "supertonic",
        instanceName: "supertonic",
        status: "READY",
        backend: "cpu",
        device: 0,
        port: 19001,
        taskCount: 0
      }
    ]
  });
  await openApp(page, backend, { modelId: "supertonic", lang: "zh" });
  await expect(page).toHaveTitle(/audio\.cpp-hub/);
  await expect(page.locator("#panel-tts")).toBeVisible();
  await expect(page.locator("#instance-pill")).toHaveClass(/ok/);
  // 至少请求过 models 与 instances
  expect(backend.requests.some((r) => r.path === "/api/models")).toBeTruthy();
});
