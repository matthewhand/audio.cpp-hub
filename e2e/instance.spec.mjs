/* #71 e2e：启动 / 停止实例（启动弹窗提交 → 实例条就绪 → 停止 → 回到无就绪） */
import { test, expect } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

test("启动后实例就绪，停止后回到无就绪", async ({ page }) => {
  const backend = new MockBackend({
    executables: [
      { id: "e1", name: "Mock CPU", path: "/opt/audiocpp_server", note: "", env: {}, exists: true }
    ]
  });
  await openApp(page, backend, { modelId: "supertonic", lang: "zh" });
  await expect(page.locator("#instance-pill")).toHaveClass(/warn/);

  await page.locator("#launch-open-btn").click();
  await expect(page.locator("#launch-modal")).toBeVisible();
  await expect(page.locator("#launch-exec option")).toHaveCount(1);
  await page.locator("#launch-weights").fill("/models/supertonic");
  await page.locator("#launch-btn").click();
  await expect(page.locator("#launch-modal")).toBeHidden();

  await expect(page.locator("#instance-pill")).toHaveClass(/ok/, { timeout: 10000 });
  await expect(page.locator("#instance-select option")).toHaveCount(1);
  expect(backend.instances).toHaveLength(1);
  expect(backend.instances[0].modelId).toBe("supertonic");

  await page.locator("#instance-stop").click();
  await expect(page.locator("#instance-pill")).toHaveClass(/warn/, { timeout: 10000 });
  expect(backend.instances).toHaveLength(0);
  await expect(page.locator("#instance-list")).toContainText("暂无实例");
});

test("shows an exited instance and lets the user remove its card", async ({ page }) => {
  const instance = {
    id: "exit123",
    instanceName: "exit-test",
    modelId: "supertonic",
    status: "READY",
    backend: "cpu",
    port: 19002
  };
  const backend = new MockBackend({ instances: [instance] });
  await openApp(page, backend, { modelId: "supertonic", lang: "en" });
  const card = page.locator("#instance-list .card").filter({ hasText: "exit-test" });
  await expect(card.getByText("Ready", { exact: true })).toBeVisible();

  instance.status = "EXITED";
  await expect(card.getByText("Exited", { exact: true })).toBeVisible();
  await expect(page.locator("#instance-select")).toBeDisabled();
  await card.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(card).toHaveCount(0);
});
