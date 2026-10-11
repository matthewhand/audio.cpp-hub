# Issue #121 — Native SSE / Activity Queue QA

### Isolated real-SSE browser QA (Issue #121)

The ordinary Playwright suite uses a mock EventSource. For an additional
**native EventSource against the actual Go SSE handler**, from a clean
development checkout with npm test dependencies already installed, start the
loopback-only harness:

```sh
QA121_REAL_SSE_BROWSER=1 go test -run '^TestQA121BrowserHarness$' -v .
```

While it is listening on `127.0.0.1:4194`, run a second local command:

```sh
node e2e/qa121-real-sse-browser.mjs
```

The browser exercise uses a disposable test EventBus and synthetic/mock tasks;
it covers stream connection, event-triggered task refresh, disconnect/reconnect,
404 fallback, privacy and responsive screenshots. The harness has an 80-second
lifetime and returns without touching production services or model weights.
The normal Go suite skips the opt-in harness automatically.
