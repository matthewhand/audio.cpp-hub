/* #102 单元测试：web/api-client.js（ApiError 信封归一化、CODE 客户端错误码、
   AbortController 超时/中断、buildUrl、请求原语、可见性感知轮询）。
   通过 node:vm 加载 classic script（helpers/vm.mjs 的 runClassic 模式），
   fetch / setTimeout / document 全部用可控桩替换：无网络、无真实定时器，
   因此不依赖真实 hub，也不会挂起。不修改任何前端源码。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readWeb, runClassic, loadI18n } from "./helpers/vm.mjs";

/* 让所有待决的微任务 / 已排队的微任务链跑完（vm 内的 Promise 回调也在这里冲刷）。 */
async function flush(rounds = 4) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/** 手动推进的假时钟：只记录定时器，由测试显式 fire，杜绝真实等待。 */
function makeClock() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    get size() {
      return timers.size;
    },
    delays: () => [...timers.values()].map((t) => t.ms),
    async fireAll() {
      for (const [id, t] of [...timers]) {
        timers.delete(id);
        t.fn();
      }
      await flush();
    }
  };
}

const abortError = () => {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
};

/** 假 fetch：记录每次调用，并允许测试手动 resolve / reject / 永挂。 */
function makeFetchRecorder() {
  const calls = [];
  const fetchImpl = (url, init) => {
    const call = { url, init };
    calls.push(call);
    return new Promise((resolve, reject) => {
      call.respond = (status, text) =>
        resolve({ ok: status >= 200 && status < 300, status, text: async () => text });
      call.fail = (err) => reject(err);
      const sig = init && init.signal;
      if (sig) {
        if (sig.aborted) reject(abortError());
        else sig.addEventListener("abort", () => reject(abortError()), { once: true });
      }
    });
  };
  return {
    fetch: fetchImpl,
    calls,
    last: () => calls[calls.length - 1],
    count: () => calls.length
  };
}

/** 可计数的外部 signal 桩：用来断言「请求结束后摘掉 abort 监听」这个不留悬挂句柄的约定。 */
function makeSignalStub(aborted = false) {
  return {
    aborted,
    added: 0,
    removed: 0,
    addEventListener() {
      this.added++;
    },
    removeEventListener() {
      this.removed++;
    }
  };
}

function makeApi({ i18n = false } = {}) {
  const clock = makeClock();
  const recorder = makeFetchRecorder();
  const consoleLog = { warn: [], error: [], log: [] };
  const visListeners = [];
  const document = {
    hidden: false,
    documentElement: { lang: "" },
    querySelectorAll: () => [],
    addEventListener: (evt, fn) => {
      if (evt === "visibilitychange") visListeners.push(fn);
    },
    removeEventListener: (evt, fn) => {
      const i = visListeners.indexOf(fn);
      if (i >= 0) visListeners.splice(i, 1);
    }
  };
  const store = new Map();
  const sandbox = {
    window: {},
    document,
    navigator: { language: "zh-CN" },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    },
    fetch: recorder.fetch,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    // 注入宿主 realm 的构造器：源码里的 `body instanceof FormData/Blob/ArrayBuffer`
    // 是跨 realm 的 instanceof，注入同一个 realm 的构造器才判定正确。
    AbortController,
    FormData,
    Blob,
    ArrayBuffer,
    console: {
      warn: (...a) => consoleLog.warn.push(a),
      error: (...a) => consoleLog.error.push(a),
      log: (...a) => consoleLog.log.push(a)
    }
  };
  // 页面加载顺序：i18n 三件套在 api-client.js 之前
  if (i18n) loadI18n(sandbox);
  runClassic(readWeb("api-client.js"), sandbox, "api-client.js");
  return {
    Api: sandbox.window.AudioCppHub.api,
    clock,
    fetch: recorder,
    consoleLog,
    document,
    sandbox,
    visibilityListeners: visListeners
  };
}

/** 立刻挂上 rejection 处理器，返回「错误本身」的 promise：既不会 unhandledRejection，
    也保证在推进假时钟之前错误就已被接住（顺序无关）。 */
function caught(promise) {
  return promise.then(
    (value) => {
      throw new assert.AssertionError({
        message: `expected the request to reject, got ${JSON.stringify(value)}`
      });
    },
    (e) => e
  );
}

/** 假 fetch 立刻返回一个响应体，返回该响应的 promise。 */
function respond(env, path, status, body, opts) {
  const p = env.Api.request(path, opts);
  env.fetch.last().respond(status, body);
  return p;
}

/* vm realm 造出来的对象/数组原型与测试 realm 不同，deepStrictEqual 会因原型不等而失败。
   响应体与错误信封都是 vm realm 里 JSON.parse 出来的，这里用 JSON 往返摊平回测试 realm。 */
const plain = (v) => (v === null || typeof v !== "object" ? v : JSON.parse(JSON.stringify(v)));

/* ------------------------------------------------------------------ 常量 */

test("api: CODE 客户端错误码取值固定（跨文件契约，改名即破坏调用方）", () => {
  const { Api } = makeApi();
  assert.deepEqual(
    { ...Api.CODE },
    {
      TIMEOUT: "CLIENT_TIMEOUT",
      ABORTED: "CLIENT_ABORTED",
      NETWORK: "CLIENT_NETWORK",
      BAD_JSON: "CLIENT_BAD_JSON",
      BAD_SHAPE: "CLIENT_BAD_SHAPE",
      HTTP: "CLIENT_HTTP_ERROR"
    }
  );
});

test("api: DEFAULTS 超时/轮询间隔固定", () => {
  const { Api } = makeApi();
  assert.deepEqual({ ...Api.DEFAULTS }, { timeout: 20000, pollInterval: 2000, pollTimeout: 10000 });
});

test("api: window.AudioCppHub.api 暴露全部原语", () => {
  const { Api } = makeApi();
  for (const name of [
    "request",
    "get",
    "post",
    "put",
    "del",
    "list",
    "poll",
    "stopAllPollers",
    "buildUrl"
  ]) {
    assert.equal(typeof Api[name], "function", `Api.${name}`);
  }
  assert.equal(typeof Api.ApiError, "function");
  assert.equal(typeof Api.CODE, "object");
  assert.equal(typeof Api.DEFAULTS, "object");
});

/* ------------------------------------------------------------- ApiError */

test("api: ApiError 缺省字段与 toString", () => {
  const { Api } = makeApi();
  const e = new Api.ApiError("boom");
  assert.equal(e.name, "ApiError");
  assert.equal(e.message, "boom");
  assert.equal(e.status, 0);
  assert.equal(e.code, "CLIENT_HTTP_ERROR", "无 code 时落到 HTTP 默认码");
  assert.deepEqual({ ...e.params }, {});
  assert.equal(e.type, "");
  assert.equal(e.detail, "");
  assert.equal(e.envelope, null);
  assert.equal(e.url, "");
  assert.equal(e.method, "");
  assert.equal(e.aborted, false);
  assert.equal(e.toString(), "ApiError{CLIENT_HTTP_ERROR 0 boom}");
  assert.equal(new Api.ApiError("").message, "", "空 message 不抛错");
  assert.ok(new Api.ApiError("x") instanceof Api.ApiError);
  assert.equal(typeof new Api.ApiError("x").stack, "string", "继承自 Error");
});

test("api: ApiError 判定属性表驱动（code → isTimeout/isNetwork/isClient）", () => {
  const { Api } = makeApi();
  const cases = [
    ["CLIENT_TIMEOUT", true, false, true],
    ["CLIENT_ABORTED", false, false, true],
    ["CLIENT_NETWORK", false, true, true],
    ["CLIENT_BAD_JSON", false, false, true],
    ["CLIENT_BAD_SHAPE", false, false, true],
    ["CLIENT_HTTP_ERROR", false, false, true],
    ["VOICE_NAME_EXISTS", false, false, false],
    ["TASK_NOT_FOUND", false, false, false]
  ];
  for (const [code, isTimeout, isNetwork, isClient] of cases) {
    const e = new Api.ApiError("m", { code });
    assert.deepEqual(
      [e.isTimeout, e.isNetwork, e.isClient],
      [isTimeout, isNetwork, isClient],
      `code=${code}`
    );
    assert.equal(e.isAbort, false, `code=${code} 未标 aborted`);
  }
  // aborted 标记独立于 code（超时与调用方取消都算）
  assert.equal(new Api.ApiError("m", { code: Api.CODE.ABORTED, aborted: true }).isAbort, true);
  assert.equal(new Api.ApiError("m", { code: Api.CODE.TIMEOUT, aborted: true }).isAbort, true);
});

/* ------------------------------------------------- 错误信封归一化（核心） */

test("api: 非 OK 响应归一化表驱动——hub 风格 / OpenAI 风格 / 非 JSON / 空体", async () => {
  const cases = [
    {
      name: "hub 风格：code + params + error 全部透传",
      status: 409,
      body: JSON.stringify({
        ok: false,
        code: "VOICE_NAME_EXISTS",
        params: { name: "n" },
        error: "音色名称已存在"
      }),
      want: {
        code: "VOICE_NAME_EXISTS",
        type: "",
        detail: "音色名称已存在",
        message: "音色名称已存在",
        params: { name: "n" },
        status: 409,
        envelope: {
          ok: false,
          code: "VOICE_NAME_EXISTS",
          params: { name: "n" },
          error: "音色名称已存在"
        }
      }
    },
    {
      name: "hub 风格缺 code：回落到 HTTP 默认码，error 作 detail",
      status: 400,
      body: JSON.stringify({ ok: false, error: "参数不对" }),
      isClient: true,
      want: {
        code: "CLIENT_HTTP_ERROR",
        type: "",
        detail: "参数不对",
        message: "参数不对",
        params: {},
        status: 400
      }
    },
    {
      name: "OpenAI 风格：error.type 升为 code",
      status: 400,
      body: JSON.stringify({ error: { message: "no such model", type: "invalid_request_error" } }),
      want: {
        code: "invalid_request_error",
        type: "invalid_request_error",
        detail: "no such model",
        message: "no such model",
        params: {},
        status: 400
      }
    },
    {
      name: "OpenAI 风格缺 type：type 空、code 落 HTTP 默认码",
      status: 502,
      body: JSON.stringify({ error: { message: "upstream down" } }),
      isClient: true,
      want: {
        code: "CLIENT_HTTP_ERROR",
        type: "",
        detail: "upstream down",
        message: "upstream down",
        params: {},
        status: 502
      }
    },
    {
      name: "顶层 message 字段也能取到 detail",
      status: 400,
      body: JSON.stringify({ message: "top level" }),
      isClient: true,
      want: {
        code: "CLIENT_HTTP_ERROR",
        type: "",
        detail: "top level",
        message: "top level",
        params: {},
        status: 400
      }
    },
    {
      name: "非 JSON 错误体：原文当 message，envelope 为 null",
      status: 500,
      body: "Internal Server Error",
      isClient: true,
      want: {
        code: "CLIENT_HTTP_ERROR",
        type: "",
        detail: "",
        message: "Internal Server Error",
        params: {},
        status: 500,
        envelope: null
      }
    },
    {
      name: "空错误体：message 退成 HTTP <status>",
      status: 404,
      body: "",
      isClient: true,
      want: {
        code: "CLIENT_HTTP_ERROR",
        type: "",
        detail: "",
        message: "HTTP 404",
        params: {},
        status: 404,
        envelope: null
      }
    },
    {
      name: "JSON 但取不到人类信息（如 {ok:false}）：message 退成响应体原文",
      status: 403,
      body: JSON.stringify({ ok: false }),
      isClient: true,
      want: {
        code: "CLIENT_HTTP_ERROR",
        type: "",
        detail: "",
        message: '{"ok":false}',
        params: {},
        status: 403
      }
    }
  ];
  for (const c of cases) {
    const env = makeApi();
    const err = await caught(respond(env, "/api/voices", c.status, c.body));
    assert.equal(err.name, "ApiError", c.name);
    for (const [key, want] of Object.entries(c.want)) {
      assert.deepEqual(plain(err[key]), want, `${c.name}: ${key}`);
    }
    assert.equal(err.url, "/api/voices", `${c.name}: url`);
    assert.equal(err.method, "GET", `${c.name}: method`);
    // isClient 只看 code 是否自造：服务端业务码 / OpenAI type 都不算客户端错误
    assert.equal(err.isClient, c.isClient ?? false, `${c.name}: isClient`);
    assert.equal(err.isAbort, false, `${c.name}: 非中断`);
  }
});

test("api: hub 与 OpenAI 两种信封都不算客户端错误，且保留原始 envelope 供程序判断", async () => {
  const env = makeApi();
  const hub = await caught(
    respond(env, "/api/x", 409, JSON.stringify({ ok: false, code: "A_B", error: "e" }))
  );
  const openai = await caught(
    respond(env, "/v1/x", 400, JSON.stringify({ error: { message: "m", type: "t" } }))
  );
  assert.equal(hub.isClient, false);
  assert.equal(openai.isClient, false);
  assert.deepEqual(plain(hub.envelope), { ok: false, code: "A_B", error: "e" });
  assert.deepEqual(plain(openai.envelope), { error: { message: "m", type: "t" } });
});

test("api: message 走 I18N.errText 本地化；字典缺码 / 抛错时回退服务端原文", async () => {
  const cases = [
    {
      name: "字典命中",
      i18n: true,
      body: { ok: false, code: "VOICE_NAME_EXISTS", error: "raw" },
      want: "音色名称已存在（名称需唯一）"
    },
    {
      name: "字典缺码回退 error 原文",
      i18n: true,
      body: { ok: false, code: "NO_SUCH_CODE", error: "兜底文本" },
      want: "兜底文本"
    },
    {
      name: "无 I18N 时回退 error 原文",
      i18n: false,
      body: { ok: false, code: "VOICE_NAME_EXISTS", error: "raw" },
      want: "raw"
    }
  ];
  for (const c of cases) {
    const env = makeApi({ i18n: c.i18n });
    const err = await caught(respond(env, "/api/voices", 409, JSON.stringify(c.body)));
    assert.equal(err.message, c.want, c.name);
    assert.equal(err.detail, c.body.error, `${c.name}: detail 始终是服务端原文`);
  }
  // errText 抛错不得让错误处理本身炸掉
  const env = makeApi();
  env.sandbox.window.I18N = {
    errText() {
      throw new Error("字典坏了");
    }
  };
  const err = await caught(
    respond(env, "/api/voices", 409, JSON.stringify({ ok: false, code: "X", error: "兜底" }))
  );
  assert.equal(err.message, "兜底");
});

/* ------------------------------------------------------- 客户端 CODE 行为 */

test("api: CLIENT_BAD_JSON——200 但响应体不是合法 JSON", async () => {
  const env = makeApi();
  const err = await caught(respond(env, "/api/z", 200, "{oops"));
  assert.equal(err.code, "CLIENT_BAD_JSON");
  assert.equal(err.status, 200, "状态码仍带，便于排查");
  assert.equal(err.isClient, true);
  assert.equal(err.isAbort, false);
  assert.match(err.message, /^bad json: /);
});

test("api: CLIENT_BAD_SHAPE——list() 拿到非数组即拒绝，不静默当空数组", async () => {
  const cases = [
    ["object", JSON.stringify({ ok: true }), "expected array, got object"],
    ["null body", "", "expected array, got null"],
    ["string", JSON.stringify("nope"), "expected array, got string"],
    ["number", "42", "expected array, got number"]
  ];
  for (const [name, body, want] of cases) {
    const env = makeApi();
    const p = env.Api.list("/api/downloads");
    env.fetch.last().respond(200, body);
    const err = await caught(p);
    assert.equal(err.code, "CLIENT_BAD_SHAPE", name);
    assert.equal(err.message, want, name);
    assert.equal(err.isClient, true, name);
    assert.equal(err.url, "/api/downloads", name);
  }
  // 合法数组正常返回
  const env = makeApi();
  const p = env.Api.list("/api/downloads");
  env.fetch.last().respond(200, JSON.stringify([{ id: "a" }]));
  assert.deepEqual(plain(await p), [{ id: "a" }]);
});

test("api: CLIENT_NETWORK——fetch 抛原生异常归一化为网络错误", async () => {
  const cases = [
    ["TypeError", () => new TypeError("Failed to fetch"), "Failed to fetch"],
    ["Error", () => new Error("boom"), "boom"],
    ["字符串", () => "raw string", "raw string"],
    ["无 message", () => ({}), "[object Object]"]
  ];
  for (const [name, make, wantMsg] of cases) {
    const env = makeApi();
    const p = env.Api.get("/api/n");
    env.fetch.last().fail(make());
    const err = await caught(p);
    assert.equal(err.code, "CLIENT_NETWORK", name);
    assert.equal(err.isNetwork, true, name);
    assert.equal(err.isClient, true, name);
    assert.equal(err.isAbort, false, name);
    assert.equal(err.status, 0, name);
    assert.equal(err.message, wantMsg, name);
  }
});

test("api: CLIENT_TIMEOUT——超时定时器触发后中止请求，且不留悬挂定时器", async () => {
  const env = makeApi();
  const p = caught(env.Api.get("/api/slow", { timeout: 5 }));
  assert.deepEqual(env.clock.delays(), [5], "只挂了一个 5ms 超时定时器");
  await env.clock.fireAll();
  const err = await p;
  assert.equal(err.code, "CLIENT_TIMEOUT");
  assert.equal(err.isTimeout, true);
  assert.equal(err.isAbort, true, "超时也是 abort，轮询里应静默");
  assert.equal(err.isNetwork, false);
  assert.equal(err.status, 0);
  assert.equal(err.message, "request timeout");
  assert.equal(env.clock.size, 0, "finally 里清掉了定时器");
});

test("api: timeout: 0 表示不限时，不挂超时定时器", async () => {
  const env = makeApi();
  const p = env.Api.get("/api/slow", { timeout: 0 });
  assert.equal(env.clock.size, 0);
  env.fetch.last().respond(200, JSON.stringify({ ok: true }));
  assert.deepEqual(plain(await p), { ok: true });
  assert.equal(env.clock.size, 0);
});

test("api: CLIENT_ABORTED——调用方取消（预先已 abort / 途中 abort）", async () => {
  // 预先 abort
  const pre = makeApi();
  const ctl = new AbortController();
  ctl.abort();
  const err1 = await caught(pre.Api.get("/api/a", { signal: ctl.signal }));
  assert.equal(err1.code, "CLIENT_ABORTED");
  assert.equal(err1.isAbort, true);
  assert.equal(err1.isTimeout, false, "调用方取消不是超时");
  assert.equal(err1.isNetwork, false);
  assert.equal(err1.message, "request aborted");

  // 途中 abort
  const mid = makeApi();
  const ctl2 = new AbortController();
  const p = mid.Api.get("/api/a", { signal: ctl2.signal });
  ctl2.abort();
  const err2 = await caught(p);
  assert.equal(err2.code, "CLIENT_ABORTED");
  assert.equal(err2.isAbort, true);
  assert.equal(err2.isTimeout, false);
});

test("api: 请求结束后摘掉外部 signal 的 abort 监听（不留悬挂句柄）", async () => {
  const cases = [
    ["成功", (env, p) => env.fetch.last().respond(200, "{}"), (p) => p],
    ["失败", (env) => env.fetch.last().respond(500, "{}"), null],
    ["网络异常", (env) => env.fetch.last().fail(new TypeError("x")), null]
  ];
  for (const [name, settle, pass] of cases) {
    const env = makeApi();
    const sig = makeSignalStub();
    const p = env.Api.get("/api/a", { signal: sig });
    settle(env, p);
    if (pass) await pass(p).catch(() => {});
    else await p.catch(() => {});
    assert.equal(sig.added, 1, `${name}: 应挂一次 abort 监听`);
    assert.equal(sig.removed, 1, `${name}: 应摘一次 abort 监听`);
  }
});

test("api: 中断的请求不产生任何 console 输出", async () => {
  const env = makeApi();
  const ctl = new AbortController();
  const p = env.Api.get("/api/a", { signal: ctl.signal });
  ctl.abort();
  await caught(p);
  assert.deepEqual(env.consoleLog, { warn: [], error: [], log: [] });
});

/* ------------------------------------------------------------ 请求原语 */

test("api: 成功响应解析 JSON 原样返回；空体返回 null", async () => {
  const env = makeApi();
  assert.deepEqual(
    plain(await respond(env, "/api/models", 200, JSON.stringify({ ok: true, models: [1, 2] }))),
    {
      ok: true,
      models: [1, 2]
    }
  );
  assert.equal(await respond(env, "/api/x", 204, ""), null);
  assert.equal(await respond(env, "/api/x", 200, ""), null);
});

test("api: raw: true 直接交出 Response，不解析 JSON", async () => {
  const env = makeApi();
  const res = await respond(env, "/api/aud", 200, "RIFFbinary", { raw: true });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "RIFFbinary");
});

test("api: buildUrl 表驱动——占位替换、query 过滤、已有 query 追加、编码", () => {
  const { Api } = makeApi();
  const cases = [
    ["无参无 query", "/api/models", null, null, "/api/models"],
    ["单个占位", "/api/tasks/{id}", { id: "ab12" }, null, "/api/tasks/ab12"],
    ["占位做 URL 编码", "/api/tasks/{id}", { id: "a b/c" }, null, "/api/tasks/a%20b%2Fc"],
    ["数字占位", "/api/tasks/{id}", { id: 42 }, null, "/api/tasks/42"],
    ["同一占位出现多次全部替换", "/api/a/{id}/b/{id}", { id: "x" }, null, "/api/a/x/b/x"],
    [
      "query 过滤 null/undefined/空串",
      "/api/tasks",
      null,
      { a: 1, b: null, c: undefined, d: "" },
      "/api/tasks?a=1"
    ],
    ["query 值做编码", "/api/tasks", null, { modelId: "a b&c" }, "/api/tasks?modelId=a%20b%26c"],
    ["query key 做编码", "/api/tasks", null, { "a b": "c" }, "/api/tasks?a%20b=c"],
    ["路径已有 ? 用 & 追加", "/api/tasks?x=1", null, { y: 2 }, "/api/tasks?x=1&y=2"],
    ["占位与 query 共存", "/api/tasks/{id}", { id: "z" }, { active: 1 }, "/api/tasks/z?active=1"],
    ["path 为 null", null, null, null, ""],
    [
      "绝对 URL 原样保留",
      "https://example.com/v1/audio/speech",
      null,
      null,
      "https://example.com/v1/audio/speech"
    ]
  ];
  for (const [name, path, params, query, want] of cases) {
    assert.equal(Api.buildUrl(path, params, query), want, name);
  }
});

test("api: params 占位在真实请求里生效，url / method 记进错误", async () => {
  const env = makeApi();
  const p = env.Api.request("/api/tasks/{id}", {
    method: "delete",
    params: { id: "a b" },
    query: { modelId: "m 1" }
  });
  assert.equal(env.fetch.last().url, "/api/tasks/a%20b?modelId=m%201");
  assert.equal(env.fetch.last().init.method, "DELETE");
  env.fetch
    .last()
    .respond(404, JSON.stringify({ ok: false, code: "TASK_NOT_FOUND", error: "任务不存在" }));
  const err = await caught(p);
  assert.equal(err.url, "/api/tasks/a%20b?modelId=m%201");
  assert.equal(err.method, "DELETE");
});

test("api: body 序列化——只有普通对象走 JSON 并补 Content-Type", async () => {
  const env = makeApi();
  const { Api } = env;

  Api.post("/api/j", { a: 1 });
  assert.equal(env.fetch.last().init.body, JSON.stringify({ a: 1 }));
  assert.equal(env.fetch.last().init.headers["Content-Type"], "application/json");

  const fd = new FormData();
  Api.post("/api/f", fd);
  assert.equal(env.fetch.last().init.body, fd, "FormData 原样");
  assert.equal(env.fetch.last().init.headers["Content-Type"], undefined, "不覆盖浏览器边界");

  const blob = new Blob(["x"], { type: "audio/wav" });
  Api.post("/api/b", blob);
  assert.equal(env.fetch.last().init.body, blob, "Blob 原样");
  assert.equal(env.fetch.last().init.headers["Content-Type"], undefined);

  Api.post("/api/s", "raw string");
  assert.equal(env.fetch.last().init.body, "raw string");

  const ab = new ArrayBuffer(4);
  Api.post("/api/a", ab);
  assert.equal(env.fetch.last().init.body, ab, "ArrayBuffer 原样");

  const u8 = new Uint8Array([1, 2]);
  Api.post("/api/t", u8);
  assert.equal(env.fetch.last().init.body, u8, "TypedArray 原样");

  Api.post("/api/nested", { list: [1, 2], nested: { ok: true } });
  assert.equal(env.fetch.last().init.body, '{"list":[1,2],"nested":{"ok":true}}');

  // 显式 Content-Type 不被自动补的覆盖
  Api.post("/api/o", { a: 1 }, { headers: { "Content-Type": "application/vnd.x+json" } });
  assert.equal(env.fetch.last().init.headers["Content-Type"], "application/vnd.x+json");
});

test("api: body 为 undefined / null 时不发送 body", async () => {
  const env = makeApi();
  env.Api.request("/api/x", { method: "POST" });
  assert.equal(env.fetch.last().init.body, undefined);
  env.Api.post("/api/x", null);
  assert.equal(env.fetch.last().init.body, undefined);
});

test("api: 方法与 cache 透传", () => {
  const env = makeApi();
  const { Api } = env;
  Api.get("/a");
  assert.equal(env.fetch.last().init.method, "GET");
  Api.put("/a", { x: 1 });
  assert.equal(env.fetch.last().init.method, "PUT");
  Api.del("/a");
  assert.equal(env.fetch.last().init.method, "DELETE");
  Api.request("/a", { method: "patch" });
  assert.equal(env.fetch.last().init.method, "PATCH", "小写方法转大写");
  Api.request("/a");
  assert.equal(env.fetch.last().init.method, "GET", "缺省 GET");
  assert.equal(env.fetch.last().init.cache, undefined, "未给 cache 不设置该字段");
  Api.request("/a", { cache: "no-store" });
  assert.equal(env.fetch.last().init.cache, "no-store");
  assert.ok(env.fetch.last().init.signal, "每次请求都带内部 signal");
});

/* ------------------------------------------------------------------ poll */

test("api: poll 立即跑一轮并把解析后的数据交给 handler，随后自调度下一轮", async () => {
  const env = makeApi();
  const seen = [];
  const h = env.Api.poll("/api/instances", (d) => seen.push(d), { interval: 2000 });
  env.fetch.last().respond(200, JSON.stringify([{ id: "a" }]));
  await flush();
  assert.deepEqual(plain(seen), [[{ id: "a" }]]);
  assert.deepEqual(env.clock.delays(), [2000], "上一轮结束才排下一轮（自调度 setTimeout）");
  h.stop();
});

test("api: poll immediate:false 不立即发请求", async () => {
  const env = makeApi();
  const h = env.Api.poll("/api/instances", () => {}, { interval: 50, immediate: false });
  assert.equal(env.fetch.count(), 0);
  assert.deepEqual(env.clock.delays(), [50]);
  h.stop();
});

test("api: poll 单飞——上一轮未结束不再发请求", async () => {
  const env = makeApi();
  const seen = [];
  const h = env.Api.poll("/api/instances", (d) => seen.push(d), { interval: 10 });
  assert.equal(env.fetch.count(), 1);
  h.refresh();
  h.refresh();
  await flush();
  assert.equal(env.fetch.count(), 1, "同刻只允许一个在途请求");
  env.fetch.last().respond(200, "[]");
  await flush();
  assert.deepEqual(plain(seen), [[]]);
  h.stop();
});

test("api: poll 路径可以是函数，每轮重新求值", async () => {
  const env = makeApi();
  let path = "/api/tasks?instanceId=a";
  const urls = [];
  const h = env.Api.poll(
    () => path,
    () => {},
    { interval: 10 }
  );
  urls.push(env.fetch.last().url);
  env.fetch.last().respond(200, "[]");
  await flush();
  path = "/api/tasks?instanceId=b"; // 下一轮换一个实例
  await env.clock.fireAll();
  urls.push(env.fetch.last().url);
  assert.deepEqual(urls, ["/api/tasks?instanceId=a", "/api/tasks?instanceId=b"]);
  h.stop();
});

test("api: poll list:true 时非数组交 onError（CLIENT_BAD_SHAPE）", async () => {
  const env = makeApi();
  const errors = [];
  const h = env.Api.poll("/api/downloads", () => assert.fail("handler 不应被调用"), {
    list: true,
    onError: (e) => errors.push(e)
  });
  env.fetch.last().respond(200, JSON.stringify({ ok: true }));
  await flush();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "CLIENT_BAD_SHAPE");
  h.stop();
});

test("api: poll 失败交 onError；未提供 onError 只 console.warn", async () => {
  const withHandler = makeApi();
  const seen = [];
  const h1 = withHandler.Api.poll("/api/a", () => {}, { onError: (e) => seen.push(e) });
  withHandler.fetch.last().respond(500, JSON.stringify({ ok: false, code: "BOOM", error: "炸了" }));
  await flush();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].code, "BOOM", "服务端业务码原样给调用方");
  assert.equal(withHandler.consoleLog.warn.length, 0, "给了 onError 就不 warn");
  h1.stop();

  const noHandler = makeApi();
  const h2 = noHandler.Api.poll("/api/a", () => {});
  noHandler.fetch.last().fail(new TypeError("Failed to fetch"));
  await flush();
  assert.equal(noHandler.consoleLog.warn.length, 1);
  assert.match(String(noHandler.consoleLog.warn[0][0]), /poll failed/);
  assert.equal(noHandler.consoleLog.warn[0][1], "/api/a", "warn 带上出错的 url");
  h2.stop();
});

test("api: poll 中断静默——不调 onError 也不 console.warn", async () => {
  // 1) 单次请求超时
  const timeout = makeApi();
  const tErr = [];
  const h1 = timeout.Api.poll("/api/a", () => {}, { timeout: 5, onError: (e) => tErr.push(e) });
  await timeout.clock.fireAll();
  assert.deepEqual(tErr, [], "超时属 abort，轮询里静默");
  assert.deepEqual(timeout.consoleLog.warn, []);
  h1.stop();

  // 2) stop() 中断在途请求
  const stopped = makeApi();
  const sErr = [];
  const seen = [];
  const h2 = stopped.Api.poll("/api/a", (d) => seen.push(d), { onError: (e) => sErr.push(e) });
  h2.stop();
  await flush();
  assert.deepEqual(sErr, [], "stop 中断不打扰调用方");
  assert.deepEqual(seen, [], "stop 后到达的响应不再回调 handler");
  assert.deepEqual(stopped.consoleLog.warn, []);
});

test("api: poll stop() 清定时器、摘 visibility 监听并停掉后续轮次", async () => {
  const env = makeApi();
  const seen = [];
  const h = env.Api.poll("/api/a", (d) => seen.push(d), { interval: 20 });
  env.fetch.last().respond(200, "[]");
  await flush();
  assert.equal(env.visibilityListeners.length, 1);
  assert.deepEqual(env.clock.delays(), [20]);

  h.stop();
  assert.equal(env.clock.size, 0, "无悬挂定时器");
  assert.equal(env.visibilityListeners.length, 0, "visibility 监听已摘");
  await env.clock.fireAll();
  assert.equal(env.fetch.count(), 1, "stop 后不再发请求");

  h.stop(); // 幂等
  assert.equal(env.clock.size, 0);
});

test("api: poll 可见性感知——隐藏时不发请求，恢复可见立即补一次", async () => {
  const env = makeApi();
  const seen = [];
  const h = env.Api.poll("/api/a", (d) => seen.push(d), { interval: 20, immediate: false });

  env.document.hidden = true;
  await env.clock.fireAll();
  assert.equal(env.fetch.count(), 0, "标签页隐藏时不发请求");

  env.document.hidden = false;
  for (const fn of [...env.visibilityListeners]) fn(); // 派发 visibilitychange
  await flush();
  assert.equal(env.fetch.count(), 1, "重新可见立即补一次");
  env.fetch.last().respond(200, "[]");
  await flush();
  assert.deepEqual(plain(seen), [[]]);
  h.stop();
});

test("api: poll refresh() 在隐藏时是空操作，可见时立即拉一次", async () => {
  const env = makeApi();
  const h = env.Api.poll("/api/a", () => {}, { interval: 20, immediate: false });

  env.document.hidden = true;
  await h.refresh();
  assert.equal(env.fetch.count(), 0, "refresh 不绕过可见性");

  env.document.hidden = false;
  // refresh() 返回本轮 promise，只有响应回来才 settle；因此先断言已发出再回响应
  const p = h.refresh();
  await flush();
  assert.equal(env.fetch.count(), 1);
  env.fetch.last().respond(200, "[]");
  await p;
  h.stop();
});

test("api: poll visibility:false 时不注册监听、隐藏也照发", async () => {
  const env = makeApi();
  env.document.hidden = true;
  const h = env.Api.poll("/api/a", () => {}, { visibility: false });
  assert.equal(env.visibilityListeners.length, 0, "显式关闭可见性感知");
  assert.equal(env.fetch.count(), 1, "隐藏也照发");
  env.fetch.last().respond(200, "[]");
  await flush();
  h.stop();
});

test("api: stopAllPollers 一次停掉全部轮询且可重复调用", async () => {
  const env = makeApi();
  env.Api.poll("/api/a", () => {}, { interval: 10 });
  env.Api.poll("/api/b", () => {}, { interval: 10 });
  assert.equal(env.visibilityListeners.length, 2);

  env.Api.stopAllPollers();
  assert.equal(env.visibilityListeners.length, 0, "visibility 监听全摘");
  assert.equal(
    env.fetch.calls.every((c) => c.init.signal.aborted),
    true,
    "在途请求全部被中断"
  );
  await flush(); // 中断的在途请求 settle 后，各自的超时定时器才被 finally 清掉
  assert.equal(env.clock.size, 0, "无悬挂定时器");

  env.Api.stopAllPollers(); // 幂等
  assert.equal(env.clock.size, 0);
});
