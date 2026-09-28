#!/usr/bin/env node
// Render every diagram HTML to PNG previews (light + dark), diagram only.
//
//   cd docs/diagrams
//   npm i -D playwright            # once; browsers via PLAYWRIGHT_BROWSERS_PATH
//   PLAYWRIGHT_BROWSERS_PATH=/mnt/downloads/cache/ms-playwright node render.mjs
//
// Writes assets/<slug>.png and assets/<slug>-dark.png (2x device scale).

import { readdir, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "assets");

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright not installed. Run: npm i -D playwright");
  process.exit(1);
}

const files = (await readdir(here))
  .filter((f) => f.endsWith(".html") && !f.startsWith("_"))
  .sort();

if (files.length === 0) {
  console.error("no diagram .html files found");
  process.exit(1);
}

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
try {
  for (const scheme of ["light", "dark"]) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 1000 },
      deviceScaleFactor: 2,
      colorScheme: scheme,
    });
    for (const f of files) {
      const slug = f.replace(/\.html$/, "");
      const url = pathToFileURL(resolve(here, f)).href;
      await page.goto(url, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts && document.fonts.ready);
      const svg = page.locator("figure.diagram svg");
      const name = scheme === "light" ? `${slug}.png` : `${slug}-dark.png`;
      await svg.screenshot({ path: join(outDir, name) });
      console.log(`rendered ${name}`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}
