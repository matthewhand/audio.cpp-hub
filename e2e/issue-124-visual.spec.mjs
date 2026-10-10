/* Issue #124 Audio Studio v3: real-browser visual and layout assertions.
   GPU inference is mocked; production deployment is never touched. */
import { expect, test } from "@playwright/test";
import { openApp } from "./helpers.mjs";
import { MockBackend } from "./mock-backend.mjs";

test("issue #124: Studio v3 desktop/mobile and light/dark", async ({ browser }, testInfo) => {
  for (const layout of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 }
  ]) {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width: layout.width, height: layout.height },
        deviceScaleFactor: 1,
        serviceWorkers: "block"
      });
      const page = await context.newPage();
      const backend = new MockBackend({
        instances: [
          {
            id: "breeze1",
            instanceName: "Breeze TTS 2",
            modelId: "breeze-tts",
            status: "READY",
            backend: "vulkan",
            device: 0,
            port: 18090,
            taskCount: 0
          },
          {
            id: "sano1",
            instanceName: "SanoTTS",
            modelId: "sanotts",
            status: "READY",
            backend: "vulkan",
            device: 0,
            port: 18091,
            taskCount: 0
          }
        ]
      });
      await openApp(page, backend, { modelId: "breeze-tts", lang: "en", theme });
      await expect(page.locator("#studio-script-heading")).toBeVisible();
      await expect(page.locator("#studio-controls-heading")).toBeVisible();
      await expect(page.locator("#instance-pill")).toHaveClass(/ok/);
      await expect(page.locator("#tts-submit")).toBeEnabled();
      await page.locator("#tts-text").fill(
        "The morning light enters quietly through the window. Each word finds its own rhythm, and the voice follows."
      );
      await expect(page.locator("#tts-text")).toBeFocused();
      const scriptBox = await page.locator(".studio-script").boundingBox();
      const controlsBox = await page.locator(".studio-controls").boundingBox();
      const editorBox = await page.locator("#tts-text").boundingBox();
      const buttonBox = await page.locator("#tts-submit").boundingBox();
      const toolbarBox = await page.locator("#instance-bar").boundingBox();
      expect(scriptBox).not.toBeNull();
      expect(controlsBox).not.toBeNull();
      expect(editorBox.height).toBeGreaterThan(layout.name === "desktop" ? 340 : 210);
      expect(toolbarBox.x + toolbarBox.width).toBeLessThanOrEqual(layout.width + 1);
      if (layout.name === "desktop") {
        expect(controlsBox.x).toBeGreaterThanOrEqual(scriptBox.x + scriptBox.width - 2);
        expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(layout.height - 20);
      } else {
        expect(controlsBox.y).toBeGreaterThanOrEqual(scriptBox.y + scriptBox.height - 2);
        expect(buttonBox.width).toBeGreaterThan(145);
      }
      await testInfo.attach(`studio-v3-${theme}-${layout.name}.png`, {
        body: await page.screenshot({ animations: "disabled", fullPage: true }),
        contentType: "image/png"
      });
      if (layout.name === "mobile") {
        await page.locator(".studio-render").scrollIntoViewIfNeeded();
        await testInfo.attach(`studio-v3-${theme}-mobile-actions.png`, {
          body: await page.screenshot({ animations: "disabled" }),
          contentType: "image/png"
        });
      }
      await context.close();
    }
  }
});
