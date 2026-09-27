const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const dir = 'docs/diagrams';
const out = path.join(dir, 'previews');
fs.mkdirSync(out, { recursive: true });

(async () => {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.html') && f !== 'index.html');
  const browser = await chromium.launch();
  for (const f of files) {
    const slug = f.replace(/\.html$/, '');
    const page = await browser.newPage({ viewport: { width: 1160, height: 900 }, deviceScaleFactor: 2 });
    await page.goto('file://' + path.resolve(dir, f));
    await page.waitForTimeout(1200);
    const svg = await page.$('svg');
    const box = await svg.boundingBox();
    await svg.screenshot({ path: path.join(out, slug + '.png') });
    const dims = { width: Math.round(box.width), height: Math.round(box.height) };
    console.log(slug, JSON.stringify(dims));
    await page.close();
  }
  await browser.close();
})();
