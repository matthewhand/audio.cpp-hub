#!/usr/bin/env node
/*
 * 录制 Web UI 演示片段（issue #77）。
 *
 * 重要：本脚本只录制**真实运行中的 hub**，不会伪造界面。脚本本身不会生成
 * 任何假素材；未实际运行前 docs/media/ 只有 README。录制结果默认不提交
 * （体积大且随 UI 变动而变，按需重新生成并单独提交）。
 *
 * 依赖：Playwright + Chromium（优先本地 node_modules，其次 ~/.npm/_npx 缓存），
 *       ffmpeg（用于 WebM → GIF/MP4）。二者缺失时给出安装提示并退出，不产出文件。
 *
 * 用法：
 *   HUB_URL=http://127.0.0.1:18080 node scripts/record-demos.cjs
 *   node scripts/record-demos.cjs --scenario=tts        # 只录一个
 *   node scripts/record-demos.cjs --poster-only         # 只截海报帧（无动画）
 *   node scripts/record-demos.cjs --reduced-motion      # 以 reduced-motion 渲染并录像
 *   node scripts/record-demos.cjs --list                # 列出场景
 *
 * 产出（docs/media/）：
 *   <name>.webm / <name>.gif / <name>.mp4  —— 可循环播放的短片
 *   <name>.poster.png                      —— 海报帧（供 <video poster> / 静态回退）
 *   <name>.reduced.poster.png              —— reduced-motion 海报（--reduced-motion 时）
 *
 * reduced-motion：以 `reducedMotion:"reduce"` 启动上下文录制时，CSS 会关闭
 * 非必要动画，得到静态/低动版本；海报帧亦可在该模式下截取，作为无动画回退。
 */
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "docs", "media");
const hubUrl = process.env.HUB_URL || "http://127.0.0.1:18080";

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const getOpt = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};

const posterOnly = hasFlag("--poster-only");
const reduced = hasFlag("--reduced-motion");
const only = getOpt("scenario", "");

/* ---------- Playwright 解析（本地 → npx 缓存 → 全局） ---------- */
function loadPlaywright() {
  try {
    return require("playwright");
  } catch {
    /* 继续找 */
  }
  const npxRoot = path.join(os.homedir(), ".npm", "_npx");
  if (fs.existsSync(npxRoot)) {
    for (const d of fs.readdirSync(npxRoot)) {
      const p = path.join(npxRoot, d, "node_modules", "playwright");
      if (fs.existsSync(p)) {
        try {
          return require(p);
        } catch {
          /* 继续找 */
        }
      }
    }
  }
  try {
    const g = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    return require(path.join(g, "playwright"));
  } catch {
    return null;
  }
}

function hasFfmpeg() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function reachable() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    await fetch(hubUrl, { method: "GET", signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/* ---------- 场景：全部为尽力而为，元素不存在时跳过该步而非中断 ---------- */
const scenarios = {
  "theme-switch": async (page) => {
    await page.waitForTimeout(900);
    await page.click("#theme-toggle").catch(() => {});
    await page.waitForTimeout(1100);
    await page.click("#theme-toggle").catch(() => {});
    await page.waitForTimeout(900);
  },
  "instance-start": async (page) => {
    await page.waitForTimeout(900);
    await page.click("#launch-open-btn").catch(() => {});
    await page.waitForTimeout(1400);
    // 有可执行文件时展示设备/权重字段；否则仅停留在弹窗
    await page.click("#launch-modal .modal-close").catch(() => {});
    await page.waitForTimeout(700);
  },
  history: async (page) => {
    await page.waitForTimeout(900);
    await page.click("#history-btn").catch(() => {});
    await page.waitForTimeout(1800);
    await page.click("#history-panel .history-actions button").catch(() => {});
    await page.waitForTimeout(600);
  },
  downloads: async (page) => {
    await page.waitForTimeout(900);
    await page.click("#downloads-btn").catch(() => {});
    await page.waitForTimeout(1600);
    await page.click("#downloads-modal .modal-close").catch(() => {});
    await page.waitForTimeout(600);
  },
  tts: async (page) => {
    await page.waitForTimeout(1000);
    // 选第一个模型卡片，切到 TTS 面板
    await page.click("#model-list .card").catch(() => {});
    await page.waitForTimeout(1200);
    await page.fill("#tts-text", "你好，这是 audio.cpp-hub 的演示语音。").catch(() => {});
    await page.waitForTimeout(600);
    await page.click("#tts-submit").catch(() => {});
    // 等待任务行出现并跑到终态（最长 60s，超时则录制当前画面）
    await page
      .waitForSelector("#history-list .task-row, #history-list .history-row", { timeout: 60000 })
      .catch(() => {});
    await page.waitForTimeout(4000);
  }
};

async function recordOne(browser, name, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acpp-demo-"));
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    reducedMotion: reduced ? "reduce" : "no-preference",
    recordVideo: { dir: tmp, size: { width: 1280, height: 800 } }
  });
  const page = await ctx.newPage();
  let ok = false;
  try {
    await page.goto(hubUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await fn(page);
    ok = true;
  } catch (e) {
    console.warn(`  ! ${name} 录制中断：${e.message}`);
  }

  const posterSuffix = reduced ? ".reduced" : "";
  await page
    .screenshot({ path: path.join(outDir, `${name}${posterSuffix}.poster.png`) })
    .catch(() => {});

  const video = page.video();
  await ctx.close();
  const webm = await video.path().catch(() => null);
  if (webm && fs.existsSync(webm)) {
    const dest = path.join(outDir, `${name}${posterSuffix}.webm`);
    fs.copyFileSync(webm, dest);
    if (hasFfmpeg()) {
      try {
        execFileSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-y",
            "-i",
            dest,
            "-vf",
            "fps=12,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
            path.join(outDir, `${name}${posterSuffix}.gif`)
          ],
          { stdio: "inherit" }
        );
        execFileSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-y",
            "-i",
            dest,
            "-an",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            path.join(outDir, `${name}${posterSuffix}.mp4`)
          ],
          { stdio: "inherit" }
        );
      } catch (e) {
        console.warn(`  ! ffmpeg 转码失败：${e.message}`);
      }
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return ok;
}

async function main() {
  const names = only ? [only] : Object.keys(scenarios);
  if (only && !scenarios[only]) {
    console.error(`未知场景：${only}\n可用：${Object.keys(scenarios).join(", ")}`);
    process.exit(2);
  }

  if (!(await reachable())) {
    console.error(`✗ 无法连接 ${hubUrl}`);
    console.error("  请先启动 audio.cpp-hub，或用 HUB_URL=... 指定地址。");
    console.error("  未生成任何素材。");
    process.exit(1);
  }

  const pw = loadPlaywright();
  if (!pw) {
    console.error(
      "✗ 未找到 Playwright。安装：npm i -D playwright && npx playwright install chromium"
    );
    console.error("  未生成任何素材。");
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  let browser;
  try {
    browser = await pw.chromium.launch();
  } catch (e) {
    console.error(`✗ Chromium 启动失败：${e.message}`);
    console.error("  运行：npx playwright install chromium");
    process.exit(1);
  }

  console.log(`录制目标 ${hubUrl} → ${path.relative(root, outDir)}/`);
  for (const name of names) {
    console.log(`- ${name}${reduced ? " (reduced-motion)" : ""}`);
    if (posterOnly) {
      const ctx = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        reducedMotion: reduced ? "reduce" : "no-preference"
      });
      const page = await ctx.newPage();
      try {
        await page.goto(hubUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
        await scenarios[name](page);
      } catch (e) {
        console.warn(`  ! ${name}：${e.message}`);
      }
      await page
        .screenshot({ path: path.join(outDir, `${name}${reduced ? ".reduced" : ""}.poster.png`) })
        .catch(() => {});
      await ctx.close();
    } else {
      await recordOne(browser, name, scenarios[name]);
    }
  }
  await browser.close();
  console.log("完成。");
}

if (hasFlag("--list")) {
  console.log(Object.keys(scenarios).join("\n"));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
