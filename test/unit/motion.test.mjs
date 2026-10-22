/* motion.js：pill 的 state-flip 不能把 MutationObserver 再次触发；
   同一节点同一类的 flash 只留一个定时器；reduced-motion 不加动画类。
   旧实现里观察者会跟着 flash 自己的 class 改动一直排队，突变计数会顶到 settle 的上限。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDomWorld, StubElement } from "./helpers/dom-stub.mjs";
import { readWeb, runClassic } from "./helpers/vm.mjs";

function loadMotion(opts = {}) {
  const world = createDomWorld();
  const pill = new StubElement(world, "div");
  pill.setAttribute("id", "instance-pill");
  world.document.body.appendChild(pill);
  if (opts.reduce) world.matchMedia.setMatches("(prefers-reduced-motion: reduce)", true);
  const windowListeners = new Map();
  const sandbox = {
    console,
    MutationObserver: world.MutationObserver,
    document: world.document,
    window: {
      matchMedia: (query) => world.matchMedia(query),
      setTimeout: (fn, ms) => world.clock.setTimeout(fn, ms),
      clearTimeout: (id) => world.clock.clearTimeout(id),
      addEventListener: (type, cb) => {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type).push(cb);
      }
    }
  };
  runClassic(readWeb("motion.js"), sandbox, "motion.js");
  return { world, sandbox, pill, windowListeners };
}

/* 观察者回调与 flash 的定时器交替跑到安静。有上限：旧实现的自我触发会一直排队。 */
function settle(world, cap = 48) {
  let steps = 0;
  while (steps < cap && (world.microtaskCount() > 0 || world.clock.size > 0)) {
    if (world.microtaskCount() > 0) world.flushMicrotasks(1);
    else world.clock.fireAll();
    steps++;
  }
  return steps;
}

function writesOf(world, node, from) {
  return world.classWrites.slice(from).filter((w) => w.node === node);
}

function flipAdds(writes) {
  let adds = 0;
  let on = false;
  for (const w of writes) {
    const has = w.value.split(/\s+/).includes("state-flip");
    if (has && !on) adds++;
    on = has;
  }
  return adds;
}

test("watchPill: 真实状态变化只闪一次，动画类的加删不再自我触发", () => {
  const { world, pill } = loadMotion();
  const from = world.classWrites.length;
  pill.classList.add("ready");
  const steps = settle(world);
  const writes = writesOf(world, pill, from);
  assert.ok(
    writes.length <= 4 && steps < 48 && world.microtaskCount() === 0 && world.clock.size === 0,
    "unbounded flash loop writes=" + writes.length + " steps=" + steps
  );
  assert.equal(flipAdds(writes), 1);
  assert.equal(pill.classList.contains("ready"), true);
  assert.equal(pill.classList.contains("state-flip"), false);

  const fromWs = world.classWrites.length;
  pill.className = "ready   state-flip";
  settle(world);
  assert.equal(writesOf(world, pill, fromWs).length, 1);
  assert.equal(world.clock.size, 0);
  assert.equal(world.microtaskCount(), 0);
});

test("flash: 同一节点同一类不叠设定时器，缺类时不读 offsetWidth", () => {
  const { world, sandbox } = loadMotion();
  const btn = new StubElement(world, "button");
  world.document.body.appendChild(btn);
  const from = world.classWrites.length;
  const reflows = world.reflows;
  const flash = sandbox.window.hubMotion.flash;
  flash(btn, "copied", 700);
  flash(btn, "copied", 700);
  flash(btn, "copied", 50);
  assert.equal(world.clock.size, 1);
  assert.equal(world.clock.cleared, 2);
  assert.deepEqual(world.clock.delays(), [50]);
  assert.equal(world.reflows, reflows);
  assert.equal(writesOf(world, btn, from).length, 1);
  assert.equal(btn.classList.contains("copied"), true);
  world.clock.fireAll();
  assert.equal(btn.classList.contains("copied"), false);
  assert.equal(world.clock.size, 0);

  btn.classList.add("copied");
  const reflowAt = world.reflows;
  flash(btn, "copied", 700);
  assert.equal(world.reflows, reflowAt + 1);
  assert.equal(world.clock.size, 1);
  assert.equal(btn.classList.contains("copied"), true);
});

test("reduced-motion: flash 不加动画类", () => {
  const { world, sandbox, pill } = loadMotion({ reduce: true });
  assert.equal(sandbox.window.hubMotion.prefersReduced(), true);
  const from = world.classWrites.length;
  pill.classList.add("ready");
  settle(world);
  assert.equal(writesOf(world, pill, from).length, 1);
  assert.equal(pill.classList.contains("state-flip"), false);
  assert.equal(world.clock.size, 0);
  const root = world.document.documentElement;
  sandbox.window.hubMotion.flash(root, "theme-switching", 320);
  assert.equal(root.classList.contains("theme-switching"), false);
  assert.equal(world.clock.size, 0);
});

test("themechange: 仍给 documentElement 加上 theme-switching", () => {
  const { world, windowListeners } = loadMotion();
  const reflows = world.reflows;
  for (const cb of windowListeners.get("themechange")) cb();
  assert.equal(world.document.documentElement.classList.contains("theme-switching"), true);
  assert.equal(world.clock.size, 1);
  assert.equal(world.reflows, reflows);
  world.clock.fireAll();
  assert.equal(world.document.documentElement.classList.contains("theme-switching"), false);
});
