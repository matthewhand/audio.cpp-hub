/* #73 UI 清单漂移检查：把清单重新生成到临时文件，与仓库中已提交的版本逐字节比对。
   清单过期（界面改动未重生成）时退出码为 1，CI 据此失败。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generate, ROOT } from "./ui-inventory.mjs";

const { json, markdown } = await generate();
const tmpJson = path.join(os.tmpdir(), `ui_inventory.${process.pid}.json`);
const tmpMd = path.join(os.tmpdir(), `ui.${process.pid}.md`);
fs.writeFileSync(tmpJson, json);
fs.writeFileSync(tmpMd, markdown);

const targets = [
  [tmpJson, path.join(ROOT, "ui_inventory.json"), "ui_inventory.json"],
  [tmpMd, path.join(ROOT, "docs", "ui.md"), "docs/ui.md"]
];

let failed = false;
for (const [tmp, committed, label] of targets) {
  if (!fs.existsSync(committed)) {
    console.error(`✗ 缺少 ${label}`);
    failed = true;
    continue;
  }
  const generated = fs.readFileSync(tmp, "utf8");
  const current = fs.readFileSync(committed, "utf8");
  if (generated !== current) {
    console.error(`✗ ${label} 与源码不一致（漂移）`);
    failed = true;
  } else {
    console.log(`✓ ${label}`);
  }
}

fs.rmSync(tmpJson, { force: true });
fs.rmSync(tmpMd, { force: true });

if (failed) {
  console.error("请运行 `npm run ui:inventory` 重新生成并提交。");
  process.exit(1);
}
console.log("UI 清单已是最新");
