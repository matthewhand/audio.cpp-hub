#!/usr/bin/env node
/*
 * 图标生成：从仓库根目录 icon.ico（内含 64x64 PNG）派生 PWA 所需的 PNG 图标。
 *
 * 依赖：ffmpeg（已在开发环境提供）。无 ffmpeg 时可用 Playwright 作为替代
 * 栅格化方案（见 docs/pwa.md「图标」一节），本脚本不自动回退。
 *
 * 用法：
 *   node scripts/gen-icons.cjs            # 输出到 web/icons/
 *   ICON_SRC=path/to/icon.ico node scripts/gen-icons.cjs
 *
 * 输出：
 *   web/icons/icon-192.png            普通图标（保留透明背景）
 *   web/icons/icon-512.png
 *   web/icons/icon-maskable-192.png   maskable（图形缩至安全区 62% + 品牌底色）
 *   web/icons/icon-maskable-512.png
 *   web/icons/apple-touch-icon-180.png
 *
 * 说明：源图仅 64x64，放大到 512 会偏软；如需锐利图标请提供更高分辨率源图。
 */
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const src = process.env.ICON_SRC || path.join(root, "icon.ico");
const outDir = path.join(root, "web", "icons");

function hasFfmpeg() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function run(args) {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });
}

/* 读取源图原始 RGBA，估算不透明像素平均亮度，用来给 maskable 选反差底色 */
function averageLuminance() {
  const raw = "/tmp/acpp-icon-probe.rgba";
  run(["-i", src, "-f", "rawvideo", "-pix_fmt", "rgba", raw]);
  const buf = fs.readFileSync(raw);
  fs.unlinkSync(raw);
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 3 < buf.length; i += 4) {
    if (buf[i + 3] < 32) continue;
    // Rec.709 亮度
    sum += 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
    n++;
  }
  return n ? sum / n : 128;
}

function main() {
  if (!fs.existsSync(src)) {
    console.error(`找不到源图标：${src}`);
    process.exit(1);
  }
  if (!hasFfmpeg()) {
    console.error("未找到 ffmpeg。请安装 ffmpeg，或用 Playwright 手动栅格化（见 docs/pwa.md）。");
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const lum = averageLuminance();
  // 图形偏亮 → 深色底；图形偏暗 → 浅色底，保证 maskable 安全区内仍有对比
  const maskBg = lum > 140 ? "0x17181c" : "0xf6f6f7";
  const scaled = "scale=iw*0.62:ih*0.62:flags=lanczos";

  run(["-i", src, "-vf", "scale=192:192:flags=lanczos", path.join(outDir, "icon-192.png")]);
  run(["-i", src, "-vf", "scale=512:512:flags=lanczos", path.join(outDir, "icon-512.png")]);
  run(["-i", src, "-vf", `${scaled},pad=192:192:(ow-iw)/2:(oh-ih)/2:color=${maskBg}`,
    path.join(outDir, "icon-maskable-192.png")]);
  run(["-i", src, "-vf", `${scaled},pad=512:512:(ow-iw)/2:(oh-ih)/2:color=${maskBg}`,
    path.join(outDir, "icon-maskable-512.png")]);
  run(["-i", src, "-vf", `${scaled},pad=180:180:(ow-iw)/2:(oh-ih)/2:color=${maskBg}`,
    path.join(outDir, "apple-touch-icon-180.png")]);

  console.log(`图标已生成到 ${path.relative(root, outDir)}/（源亮度 ${lum.toFixed(1)}，maskable 底色 ${maskBg}）`);
}

main();
