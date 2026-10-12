import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

// Exercise the actual Activity functions in a deterministic mock browser,
// without network, installed browsers or real timers.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = readFileSync(resolve(root, "web/modules/activity-queue.js"), "utf8");
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, "missing Activity source anchors: " + start + " / " + end);
  return source.slice(a, b);
}
const lifecycle = section("function schedulePoll()", "function privacyClick(") +
  section("function visibilityChange()", "function relocalize()");

function harness({ constructionFailures = 0, listenerFailures = 0 } = {}) {
  let attempts = 0, closed = 0, polls = 0, reconciles = 0;
  let nextTimer = 0;
  const timers = new Map();
  const fakeElement = () => ({
    textContent: "",
    classList: { add() {} },
    setAttribute() {},
    replaceChildren() {}
  });
  const elements = new Map();
  function $(id) {
    if (!elements.has(id)) elements.set(id, fakeElement());
    return elements.get(id);
  }
  class FakeEventSource {
    static CLOSED = 2;
    static CONNECTING = 0;
    constructor() {
      attempts++;
      if (constructionFailures-- > 0) throw Error("synthetic constructor failure");
      this.readyState = FakeEventSource.CONNECTING;
    }
    addEventListener() {
      if (listenerFailures-- > 0) throw Error("synthetic listener registration failure");
    }
    close() {
      closed++;
      this.readyState = FakeEventSource.CLOSED;
    }
  }
  const scope = {
    opened: true, rows: [], stale: true, streamLive: true,
    stream: null, inFlight: null, generation: 1, pending: new Set(),
    poll: null, streamRetry: null, streamRetryDelay: 2000,
    STREAM_RETRY_INITIAL_MS: 2000, STREAM_RETRY_MAX_MS: 60000,
    POLL_MS: 5000, LIVE_POLL_MS: 15000,
    document: { hidden: false, removeEventListener() {} },
    window: { removeEventListener() {} }, $,
    EventSource: FakeEventSource,
    setTimeout(fn, ms) {
      const id = ++nextTimer;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { polls++; return 1; },
    clearInterval() {},
    reconcile() { reconciles++; return Promise.resolve(); },
    privacyClick() {}, storageChange() {},
    render() {}
  };
  vm.createContext(scope);
  vm.runInContext(lifecycle, scope, { filename: "activity-queue.js" });
  return {
    scope, timers,
    attempts: () => attempts, closed: () => closed,
    polls: () => polls, reconciles: () => reconciles,
    nextDelay() { return [...timers.values()][0]?.ms ?? null; },
    fire() {
      assert.equal(timers.size, 1, "only one bounded retry may be scheduled");
      const [id, timer] = [...timers.entries()][0];
      timers.delete(id);
      timer.fn();
    },
    setHidden(value) { scope.document.hidden = value; }
  };
}

test("Activity: synchronous EventSource exceptions retry with bounded backoff and eventually recover", () => {
  const h = harness({ constructionFailures: 2 });
  h.scope.connectStream();
  assert.equal(h.attempts(), 1);
  assert.equal(h.nextDelay(), 2000);
  assert.equal(h.scope.streamLive, false);
  h.fire();
  assert.equal(h.attempts(), 2);
  assert.equal(h.nextDelay(), 4000);
  h.fire();
  assert.equal(h.attempts(), 3);
  assert.equal(h.timers.size, 0);
  assert.ok(h.scope.stream, "new EventSource established after failures");
  h.scope.eventReceived({ type: "hello", data: "{}" });
  assert.equal(h.scope.streamRetryDelay, 2000, "valid handshake resets retry delay");
  assert.ok(h.polls() >= 3, "poll fallback stays active while reconnecting");
  assert.equal(h.reconciles(), 1);
});

test("Activity: constructor retry has one timer, obeys 60s max, and close cancels it", () => {
  const h = harness({ constructionFailures: 100 });
  h.scope.connectStream();
  const delays = [];
  for (let n = 0; n < 8; n++) {
    delays.push(h.nextDelay());
    h.fire();
  }
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  assert.equal(h.timers.size, 1);
  const before = h.attempts();
  h.scope.close();
  assert.equal(h.scope.opened, false);
  assert.equal(h.timers.size, 0);
  assert.equal(h.scope.streamRetryDelay, 2000);
  assert.equal(h.attempts(), before);
});

test("Activity: hide cancels constructor retry; visibility recovery makes one new attempt", () => {
  const h = harness({ constructionFailures: 1 });
  h.scope.connectStream();
  assert.equal(h.timers.size, 1);
  h.setHidden(true);
  h.scope.visibilityChange();
  assert.equal(h.timers.size, 0);
  assert.equal(h.scope.streamRetryDelay, 2000);
  h.setHidden(false);
  h.scope.visibilityChange();
  assert.equal(h.attempts(), 2);
  assert.ok(h.scope.stream);
  assert.equal(h.timers.size, 0);
});

test("Activity: a partially constructed stream is closed before retry", () => {
  const h = harness({ listenerFailures: 1 });
  h.scope.connectStream();
  assert.equal(h.closed(), 1);
  assert.equal(h.scope.stream, null);
  assert.equal(h.nextDelay(), 2000);
  h.fire();
  assert.equal(h.attempts(), 2);
  assert.ok(h.scope.stream);
});

test("Activity: browser CONNECTING uses native reconnect; terminal CLOSED schedules manual retry", () => {
  const h = harness();
  h.scope.connectStream();
  assert.ok(h.scope.stream);
  h.scope.stream.readyState = h.scope.EventSource.CONNECTING;
  h.scope.stream.onerror();
  assert.equal(h.timers.size, 0, "no duplicate retry while native EventSource reconnects");
  h.scope.stream.readyState = h.scope.EventSource.CLOSED;
  h.scope.stream.onerror();
  assert.equal(h.nextDelay(), 2000);
  h.fire();
  assert.equal(h.attempts(), 2);
  assert.ok(h.scope.stream);
  assert.equal(h.timers.size, 0);
});
