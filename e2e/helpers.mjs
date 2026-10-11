/* e2e 公共辅助：注入 localStorage 偏好、打开首页、等待初始渲染完成。 */
import { expect } from "@playwright/test";

/** 打开首页并等待模型列表渲染；backend 需已 install。
 *  prefs.hash 可选：带 hash 冷启动（深链接刷新），用来验证懒加载面板的路由还原。 */
export async function openApp(page, backend, prefs = {}) {
  backend.install(page);
  await page.addInitScript((p) => {
    try {
      localStorage.clear();
      if (p.modelId) localStorage.setItem("hub-model", p.modelId);
      if (p.theme) localStorage.setItem("hub-theme", p.theme);
      if (p.lang) localStorage.setItem("hub-lang", p.lang);
    } catch {
      /* about:blank 等场景忽略 */
    }
  }, prefs);
  await page.goto("/" + (prefs.hash || ""));
  await expect(page.locator("#model-list .card-title").first()).toBeVisible();
}

/** 等待指定实例就绪、且工作区提交按钮可用（updateInstanceBar 异步完成）。 */
export async function waitForReadyInstance(page, modelId) {
  await expect(page.locator("#instance-select option")).toHaveCount(1, { timeout: 10000 });
  const ready = page.locator("#instance-pill");
  await expect(ready).toHaveClass(/ok/, { timeout: 10000 });
}

/** 在 AudioPicker 中走「本地路径」页签并探测（避免真实上传/录音）。 */
export async function pickAudioByPath(page, pickerRoot, path) {
  const root = page.locator(pickerRoot);
  await root.locator('.picker-tab[data-tab="path"]').click();
  await root.locator(".path-input").fill(path);
  await root.locator(".path-probe").click();
  await expect(root.locator(".path-info")).not.toHaveText("");
}
