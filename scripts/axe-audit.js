#!/usr/bin/env node
/* 无障碍（WCAG 2.0/2.1 A + AA）自动审计：headless Chromium + axe-core，可在 CI 里跑。
   ------------------------------------------------------------------
   用法：npm run a11y:audit   （等价于 node scripts/axe-audit.js）

   为什么不再用「整段粘贴到 DevTools Console」那套：
     - web/index.html 的 CSP 是 `default-src 'self'; script-src 'self'`，往页面里动态插入
       <script src="https://cdn.jsdelivr.net/.../axe.min.js"> 会被浏览器直接拦掉，
       原实现（AXE_URL 走 CDN）在真实页面上根本加载不起来；
     - Console 粘贴依赖人工，退出码永远是 0，无法进 CI 当闸门。
   现在复用了 e2e 的两件现成基建，无 CDN、CI 可复现：
     - e2e/static-server.mjs  提供 web/ 静态页面（与 Go FileServer 同语义）
     - e2e/mock-backend.mjs   拦截 /api/* /v1/*，页面无需 Go 二进制即可完整渲染
   axe-core 从 node_modules 解析（devDependency），由 Playwright 以 CDP addInitScript
   注入 —— 该通道不受页面 CSP 约束，所以 script-src 'self' 无需放宽。

   场景：只覆盖「首屏 + 工作区」这一层，全部靠 localStorage 选模型驱动，不做点击：
     1) 中文 · TTS 面板   2) 英文 · TTS 面板   3) 中文 · ASR 面板
   有意不覆盖点击打开的模态面板（音色库 / 下载管理 / 设置 / 实例详情）：页头按钮走
   location.hash 路由，而页面自身有一个 2s 自调度轮询会重绘模型列表，点击后的 DOM 在
   headless 下不确定（实测面板开合会随机失败）。硬闸门宁可少覆盖也不能随机红；
   模态态的回归由 Playwright e2e（test:e2e）负责。

   确定性：两处干预，都是为了让「同一份代码每次审到同一份 DOM」：
     1) context.clock.install() 冻结时钟 —— app.js 的 2s 自调度轮询一旦触发就会重绘并
        短暂清空模型列表（实测卡片数 28 → 0 → 28），不同运行落在不同时刻就会拿到不同的
        违规节点数，那样的「棘轮」只会随机失败。冻结后审的永远是首屏那一次稳定渲染。
     2) serviceWorkers: "block" —— 见代码内注释（pwa.js 的 controllerchange 会整页 reload）。

   闸门用「棘轮（ratchet）」而不是「零违规」也不是「有违规就放过」：
     - KNOWN_VIOLATIONS 登记已知的存量欠账（全在 web/style.css 的配色上，不在本 PR
       能改的范围），按「规则 id → 违规节点数」比对：出现任何未登记的规则、或某条规则的
       节点数超过登记值，一律退出码 1；反过来，某条登记的规则一个节点都没找到也算失败，
       提示把基线调小。
     - 修好一条就把对应数字调小一档，闸门随之变紧。
     - 报告里始终打印全部违规（含存量）及其选择器，便于下一个改 web/ 的人接手。

   依赖浏览器：CI 的 frontend job 在此之前已执行 `npx playwright install chromium`，
   本脚本不自行下载；要用缓存的话设置 PLAYWRIGHT_BROWSERS_PATH 指向已有的
   ms-playwright 目录即可（脚本不硬编码任何路径）。
   ------------------------------------------------------------------ */
import fs from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";
import { createStaticServer } from "../e2e/static-server.mjs";
import { MockBackend } from "../e2e/mock-backend.mjs";

const require = createRequire(import.meta.url);
const AXE_SOURCE = require.resolve("axe-core/axe.min.js");

/* 已登记的存量 WCAG 欠账（规则 id → 违规节点数）。修好即下调，删完即移除。
   全部是 web/style.css 的前景/背景对比度，改配色才能修。 */
const KNOWN_VIOLATIONS = {
  "color-contrast": 66
};

/* axe 的规则标签集：WCAG 2.0/2.1 A + AA。 */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/* 一个 READY 实例，让首屏与工作区都渲染出真实内容（无实例时大片区域是空壳，审计价值低）。 */
const READY = {
  id: "i1",
  modelId: "supertonic",
  instanceName: "supertonic",
  status: "READY",
  backend: "cpu",
  device: 0,
  port: 19001,
  taskCount: 0
};

/* 场景 = 首屏偏好。只切语言与选中模型，不做任何点击（理由见文件头）。 */
const SCENARIOS = [
  { name: "首屏（中文 · TTS 面板）", prefs: { modelId: "supertonic", lang: "zh" } },
  { name: "首屏（英文 · TTS 面板）", prefs: { modelId: "supertonic", lang: "en" } },
  { name: "首屏（中文 · ASR 面板）", prefs: { modelId: "citrinet_asr", lang: "zh" } }
];

/** 在已渲染的页面上跑一次 axe，返回精简后的 violation 列表。 */
async function runAxe(page, scenario) {
  const results = await page.evaluate(
    async (tags) =>
      // window.axe 由 addInitScript 注入；这里只读 + 汇总，不改 DOM。
      (await window.axe.run(document, { runOnly: tags })).violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        helpUrl: v.helpUrl,
        nodes: v.nodes.map((n) => ({
          target: n.target.join(" "),
          summary: (n.failureSummary || "").split("\n").slice(1).join(" ").trim()
        }))
      })),
    TAGS
  );
  return results.map((v) => ({ ...v, scenario: scenario.name }));
}

async function main() {
  if (!fs.existsSync(AXE_SOURCE)) {
    console.error(`axe-core 未安装：${AXE_SOURCE}（先跑 npm ci）`);
    process.exit(2);
  }
  const axeSource = fs.readFileSync(AXE_SOURCE, "utf8");

  /* 端口 0：让内核分配空闲端口。e2e 固定 4173，写死端口会在最不该失败的地方失败。 */
  const server = createStaticServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch();
  const violations = [];
  try {
    for (const scenario of SCENARIOS) {
      const context = await browser.newContext({
        /* 掐掉 service worker：web/pwa.js 在 controllerchange 时会 window.location.reload()，
           首次注册必然触发一次整页重载，会把审计中途的 page.evaluate 打成
           「Execution context was destroyed」。SW 与可访问性无关，pwa.js 对注册失败
           静默忽略（见 web/pwa.js 的 .catch），所以直接 block 最干净。 */
        serviceWorkers: "block"
      });
      // 冻结时钟：掐断 app.js 的 2s 自调度轮询，让被审的 DOM 永远是首屏那一次稳定渲染。
      await context.clock.install({ time: new Date("2024-01-01T00:00:00Z") });
      // addInitScript 走 CDP，不受页面 CSP 的 script-src 'self' 限制。
      await context.addInitScript({ content: axeSource });
      const page = await context.newPage();
      const backend = new MockBackend({ instances: [READY] });
      backend.install(page);
      await page.addInitScript((p) => {
        localStorage.clear();
        if (p.modelId) localStorage.setItem("hub-model", p.modelId);
        if (p.lang) localStorage.setItem("hub-lang", p.lang);
      }, scenario.prefs);
      await page.goto(`${base}/`);
      await page.locator("#model-list .card-title").first().waitFor();
      violations.push(...(await runAxe(page, scenario)));
      await context.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  if (!violations.length) {
    console.log(
      `OK: axe-core 无 WCAG A/AA 违规（${SCENARIOS.length} 个场景：${SCENARIOS.map((s) => s.name).join("、")}）`
    );
    const leftover = Object.keys(KNOWN_VIOLATIONS);
    if (leftover.length) {
      console.log(`提示：存量欠账已清零，请把 KNOWN_VIOLATIONS 里的 ${leftover.join("、")} 删掉。`);
    }
    return;
  }

  /* 统计「规则 id → 违规节点数」，与登记的存量欠账逐条比对。 */
  const observed = {};
  for (const v of violations) observed[v.id] = (observed[v.id] || 0) + v.nodes.length;

  const regressions = [];
  for (const [id, count] of Object.entries(observed)) {
    const known = KNOWN_VIOLATIONS[id];
    if (known === undefined) regressions.push(`${id}: 未登记的新规则（${count} 个节点）`);
    else if (count > known) regressions.push(`${id}: ${count} 个节点 > 已登记 ${known}`);
  }
  for (const [id, known] of Object.entries(KNOWN_VIOLATIONS)) {
    if (observed[id] === undefined) {
      regressions.push(`${id}: 已登记 ${known} 个节点，本次一个都没找到（请下调基线）`);
    }
  }

  const totalNodes = Object.values(observed).reduce((a, b) => a + b, 0);
  console.log(
    `axe：${Object.keys(observed).length} 条规则违规 / ${totalNodes} 个节点（${SCENARIOS.length} 个场景）`
  );
  for (const [id, count] of Object.entries(observed)) {
    console.log(`  [${KNOWN_VIOLATIONS[id] === undefined ? "新" : "存量"}] ${id}: ${count} 个节点`);
  }
  for (const v of violations) {
    console.log(`\n[${v.impact}] ${v.id} — ${v.help}（${v.scenario}）`);
    console.log(`  ${v.helpUrl}`);
    for (const n of v.nodes) console.log(`  ${n.target}: ${n.summary}`);
  }

  if (regressions.length) {
    console.error(`\naxe 棘轮失败（${regressions.length} 项）：`);
    for (const r of regressions) console.error(`  - ${r}`);
    process.exit(1);
  }
  console.log(
    `\nOK: 无未登记的新增 WCAG 违规（存量欠账见 KNOWN_VIOLATIONS：${JSON.stringify(KNOWN_VIOLATIONS)}）`
  );
}

await main();
