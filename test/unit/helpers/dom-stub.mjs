/* 极小 DOM 桩：只为在 node 里跑 web/modules/{async-ui,command-palette}.js 的焦点语义而存在，
   不追求通用（不实现布局、不实现 CSS 优先级），只实现这些模块真正用到的那几个动作：
   classList / 属性 / 子树查询 / 事件冒泡 / focus / blur / inert / 动画帧。

   关键点是 focus() 的前置条件必须和浏览器一致，否则测不出真问题：
     1. 元素在 visibility:hidden 的子树里 → focus() 是空操作（activeElement 不变）；
     2. 元素在 inert 的子树里 → 同上；
     3. 元素没有可聚焦的形态（body / div / span，且无 tabindex）→ 同上。
   其中第 1 条正是本仓库命令面板失焦的根因：.modal-overlay.hidden 用 visibility:hidden
   保留布局盒做淡出动画，而 visibility 的 CSS 过渡要到第 2 个动画帧才生效。
   SETTLE_FRAMES 就是照着 Chromium 的实测值（--dur-2 = 200ms）定的。 */

const SETTLE_FRAMES = 2; // 去掉 .hidden 之后，visibility 过渡在第 2 帧才生效

const FOCUSABLE_TAGS = new Set(["a", "button", "input", "select", "textarea", "area"]);

/* ---- 选择器：只支持这些模块真正用到的子集 ----
   形如 `tag`、`#id`、`.class`、`.a.b`、`[attr]`、`[attr="v"]`、
   以及它们与 `:not(...)` 的组合；顶层可写成逗号分隔的列表。 */

function attrToken(token) {
  const m = /^\[([\w-]+)(?:([~|^$*]?=)"?([^"\]]*)"?)?\]$/.exec(token);
  if (!m) return null;
  return { name: m[1], op: m[2], value: m[3] };
}

function matchesSimple(node, selector) {
  const negated = [];
  const rest = selector.replace(/:not\(([^)]*)\)/g, (_, inner) => {
    negated.push(inner.trim());
    return " ";
  });
  // 复合选择器（.cp-item.active）中间没有空格，必须逐段扫而不是按空白切
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(rest)) !== null) {
    if (m[1] !== undefined) {
      if (node.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
    } else if (m[2] !== undefined) {
      if (node.id !== m[2]) return false;
    } else if (m[3] !== undefined) {
      if (!node.classList.contains(m[3])) return false;
    } else {
      const a = attrToken("[" + m[4] + "]");
      if (!a || !node.hasAttribute(a.name)) return false;
      if (a.op === "=" && node.getAttribute(a.name) !== a.value) return false;
    }
  }
  return negated.every((n) => !matchesSimple(node, n));
}

function matchesAny(node, selectorList) {
  return selectorList
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .some((s) => matchesSimple(node, s));
}

/* el() 的迷你解析器：只认 command-palette.js 真正传给 el() 的那三种模板
   （无子节点的 <div class="cp-…">，以及带两个 <span> 子节点的 .cp-item 行）。 */
export function parseTemplate(html) {
  const open = /^<([a-zA-Z][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*>/.exec(html);
  if (!open) throw new Error("dom-stub: unsupported template " + html);
  const node = { tag: open[1].toLowerCase(), attrs: {} };
  for (const m of open[2].matchAll(/([\w-]+)="([^"]*)"/g)) node.attrs[m[1]] = m[2];
  const inner = html.slice(open[0].length, html.lastIndexOf("</"));
  node.children = [...inner.matchAll(/<([a-zA-Z][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*>/g)].map((m) => {
    const child = { tag: m[1].toLowerCase(), attrs: {}, children: [] };
    for (const a of m[2].matchAll(/([\w-]+)="([^"]*)"/g)) child.attrs[a[1]] = a[2];
    return child;
  });
  return node;
}

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);

/* innerHTML 要长出可 querySelector 的子树：实例卡片把整段 markup 写进 innerHTML。
   只覆盖这些渲染器用到的子集（标签、引号属性、自闭合、嵌套），不建文本节点。 */
function parseHTMLInto(parent, html) {
  const stack = [parent];
  const re = /<!--[\s\S]*?-->|<\/([A-Za-z][\w:-]*)\s*>|<([A-Za-z][\w:-]*)([^<>]*?)(\/?)>/g;
  for (;;) {
    const m = re.exec(html);
    if (!m) break;
    if (m[0].charCodeAt(1) === 33) continue;
    if (m[1]) {
      const name = m[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName.toLowerCase() === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const tag = m[2].toLowerCase();
    const el = new StubElement(parent.world, tag);
    const attrRe = /([^\s=/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
    for (;;) {
      const a = attrRe.exec(m[3]);
      if (!a) break;
      el.setAttribute(a[1], a[2] ?? a[3] ?? "");
    }
    stack[stack.length - 1].appendChild(el);
    if (m[4] !== "/" && !VOID_TAGS.has(tag)) stack.push(el);
  }
}

export class StubElement {
  constructor(world, tagName) {
    this.world = world;
    this.tagName = tagName.toUpperCase();
    this.id = "";
    this.attrs = new Map();
    this.children = [];
    this.parentElement = null;
    this.textContent = "";
    this.listeners = new Map();
    this.innerHTML = "";
    this.onclick = null;
    this.onmouseenter = null;
    this.style = {};
    const self = this;
    this.classList = {
      contains: (c) => self.classes().has(c),
      add: (c) => {
        const s = self.classes();
        if (!s.has(c)) {
          s.add(c);
          self.attrs.set("class", [...s].join(" "));
        }
      },
      remove: (c) => {
        const s = self.classes();
        if (s.delete(c)) self.attrs.set("class", [...s].join(" "));
        self.world.onHiddenClassChange(self, s.has("hidden"));
      },
      toggle: (c, on) => (on ? this.classList.add(c) : this.classList.remove(c))
    };
  }

  classes() {
    return new Set((this.attrs.get("class") || "").split(/\s+/).filter(Boolean));
  }

  set className(v) {
    this.attrs.set("class", String(v));
  }

  get className() {
    return this.attrs.get("class") || "";
  }

  get dataset() {
    const out = {};
    for (const [k, v] of this.attrs) {
      if (!k.startsWith("data-")) continue;
      const name = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[name] = v;
    }
    return out;
  }

  get isConnected() {
    let n = this;
    while (n.parentElement) n = n.parentElement;
    return n === this.world.documentElement;
  }

  get offsetParent() {
    return this.isConnected ? this.world.documentElement : null;
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value));
    if (name === "id") this.id = String(value);
  }

  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }

  hasAttribute(name) {
    return this.attrs.has(name);
  }

  removeAttribute(name) {
    this.attrs.delete(name);
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  set innerHTML(v) {
    const html = v == null ? "" : String(v);
    this._html = html;
    for (const c of this.children) c.parentElement = null;
    this.children = [];
    if (html) parseHTMLInto(this, html);
  }

  get innerHTML() {
    return this._html || "";
  }

  descendants() {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.descendants().find((n) => matchesAny(n, selector)) || null;
  }

  querySelectorAll(selector) {
    return this.descendants().filter((n) => matchesAny(n, selector));
  }

  contains(node) {
    let n = node;
    while (n) {
      if (n === this) return true;
      n = n.parentElement;
    }
    return false;
  }

  addEventListener(type, cb) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(cb);
  }

  scrollIntoView() {
    /* 无布局：命令面板的滚动定位在这个桩里没有可观测后果 */
  }

  ancestorHas(attr) {
    for (let n = this; n; n = n.parentElement) if (n.hasAttribute(attr)) return true;
    return false;
  }

  /* 浏览器语义：visibility:hidden 的子树里 focus() 是空操作；
     而 visibility 的 CSS 过渡要到下一次样式更新才启动（见 SETTLE_FRAMES）。 */
  visibilityHidden() {
    for (let n = this; n; n = n.parentElement) {
      if (n.classList.contains("hidden")) return true;
      const revealed = this.world.revealedAt.get(n);
      if (revealed !== undefined && this.world.frame - revealed < SETTLE_FRAMES) return true;
    }
    return false;
  }

  canFocus() {
    const focusable =
      FOCUSABLE_TAGS.has(this.tagName.toLowerCase()) || this.hasAttribute("tabindex");
    return focusable && this.isConnected && !this.ancestorHas("inert") && !this.visibilityHidden();
  }

  focus() {
    if (this.canFocus()) this.world.document.activeElement = this;
  }

  blur() {
    if (this.world.document.activeElement !== this) return;
    this.world.document.activeElement = this.world.document.body;
  }

  select() {
    /* 无选区模型：命令面板每次打开都把 value 清空，这里的选中是空操作 */
  }
}

/* 一次 DOM 快照：document / $ / el / 动画帧 / 事件派发，装进 vm sandbox 用。 */
export function createDomWorld() {
  const world = {
    frame: 0,
    revealedAt: new Map(),
    rafQueue: [],
    listeners: new Map()
  };

  const documentElement = new StubElement(world, "html");
  const body = new StubElement(world, "body");
  body.setAttribute("id", "body");
  documentElement.appendChild(body);
  world.documentElement = documentElement;

  world.document = {
    documentElement,
    body,
    activeElement: body,
    readyState: "complete",
    querySelector: (sel) => documentElement.querySelector(sel),
    querySelectorAll: (sel) => documentElement.querySelectorAll(sel),
    getElementById: (id) => documentElement.querySelectorAll("#" + id)[0] || null,
    addEventListener: (type, cb) => {
      if (!world.listeners.has(type)) world.listeners.set(type, []);
      world.listeners.get(type).push(cb);
    }
  };

  world.onHiddenClassChange = (node, nowHidden) => {
    if (nowHidden) world.revealedAt.delete(node);
    else world.revealedAt.set(node, world.frame);
  };

  world.requestAnimationFrame = (cb) => {
    world.rafQueue.push(cb);
    return world.rafQueue.length;
  };
  world.cancelAnimationFrame = () => {};
  /* 推进 n 个动画帧：先记账再跑回调，与浏览器「帧末统一执行 rAF」的顺序一致 */
  world.flushFrames = (n = 1) => {
    for (let i = 0; i < n; i++) {
      world.frame++;
      const due = world.rafQueue;
      world.rafQueue = [];
      for (const cb of due) cb(world.frame);
    }
  };

  world.$ = (id) => world.document.getElementById(id);
  world.el = (html) => {
    const spec = parseTemplate(html);
    const build = (s) => {
      const node = new StubElement(world, s.tag);
      for (const [k, v] of Object.entries(s.attrs)) node.setAttribute(k, v);
      for (const c of s.children) node.appendChild(build(c));
      return node;
    };
    return build(spec);
  };

  /* 事件冒泡：从 target 沿 parentElement 冒到 document，stopPropagation 生效 */
  world.fire = (target, type, init = {}) => {
    const ev = {
      type,
      target,
      currentTarget: null,
      key: init.key,
      ctrlKey: !!init.ctrlKey,
      metaKey: !!init.metaKey,
      altKey: !!init.altKey,
      shiftKey: !!init.shiftKey,
      defaultPrevented: false,
      stopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      }
    };
    for (let n = target; n; n = n.parentElement) {
      for (const cb of n.listeners.get(type) || []) cb.call(n, ev);
      if (ev.stopped) return ev;
    }
    for (const cb of world.listeners.get(type) || []) cb.call(world.document, ev);
    return ev;
  };

  return world;
}
