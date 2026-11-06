import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

test("service worker install caches lazy interface assets for first offline use", async () => {
  const handlers = new Map();
  const requests = [];
  const source = fs.readFileSync(new URL("../../web/sw.js", import.meta.url), "utf8");
  vm.runInNewContext(source, {
    self: { addEventListener: (name, handler) => handlers.set(name, handler) },
    Request: class extends Request {
      constructor(input, options) {
        super(new URL(input, "http://synthetic.invalid"), options);
      }
    },
    caches: { open: async () => ({ add: async (request) => requests.push(request) }) }
  });
  let installation;
  handlers.get("install")({
    waitUntil: (promise) => {
      installation = promise;
    }
  });
  await installation;
  const cached = new Set(requests.map((request) => new URL(request.url).pathname));
  for (const asset of [
    "/modules/interface-modes.js",
    "/interface-modes.css",
    "/modules/operator-studio.js",
    "/operator-studio.css"
  ]) {
    assert.ok(cached.has(asset), asset + " must be cached before its first offline import");
  }
});
