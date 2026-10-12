# PR #156 — Windows-native SSE resource safety (approval gated)

Scope: Issue #155, draft PR #156. Synthetic test source and a separately
owner-approved, isolated Windows2 native execution on 13 October 2026.
**W01–W06 passed on Windows2; deployment is not authorised or performed.**
Keep PR #156 draft and Issue #155 open. Issue #128 remains the
independent deployment gate.

## Validation route

~~~mermaid
flowchart LR
  A["Linux full-handler<br/>10s timeout proven"] --> B["Windows W01–W06<br/>fixture preparation"]
  B --> C["Windows AMD64<br/>cross-compile only"]
  C --> D{"Owner approves<br/>native execution?"}
  D -->|No| E["STOP / draft"]
  D -->|Yes| F["Windows2<br/>hash-verified run"]
  F --> G["Independent review<br/>plus latest CI"]
  G --> H["Human merge<br/>decision (not merge)"]
~~~

**Evidence layers:** Linux socket-backpressure proof is not a Windows
Winsock result. Cross-compiling Windows tests is not executing them.
Deterministic net.Pipe backpressure is not Winsock TCP backpressure.

## Windows-only fixture outcomes

| ID | Fixture | Test transport | Expected check | Current status |
| --- | --- | --- | --- | --- |
| W01 | TestSSEWinNativeW01LoopbackHelloAndDeadlines | Native Windows TCP loopback | HTTP 200, SSE hello, observed write-deadline preflight and refresh | **PASS (Windows2)** |
| W02 | TestSSEWinNativeW02UnsupportedDeadlineFailsClosed | Synthetic response writer | 503 EVENTS_DEADLINE_UNSUPPORTED, slot reusable | **PASS (Windows2)** |
| W03 | TestSSEWinNativeW03OtherDeadlineFailure | Synthetic failing writer | Best-effort 503 EVENTS_DEADLINE_FAILED, no error leak, slot reusable | **PASS (Windows2)** |
| W04 | TestSSEWinNativeW04ConcurrentCapacity64 | In-process goroutines | 192 simultaneous attempts; exactly 64 admissions, no oversubscription | **PASS (Windows2)** |
| W05 | TestSSEWinNativeW05DisconnectAndShutdown | Native Windows TCP loopback | Disconnect and bus shutdown each release slots AND exit handler | **PASS (Windows2)** |
| W06 | TestSSEWinNativeW06PipeBackpressureReclaimsHandler | **net.Pipe, not Winsock** | Genuinely blocked task write ends with 10s timeout, slot reclaimed, replacement hello and cleanup | **PASS (Windows2)** |

W06 reserves 63 slots, admits one full HTTP handler in the 64th slot,
receives hello, confirms the hello-carrying transport Write has finished,
publishes one 64 KiB synthetic event, proves that the first underlying
net.Conn.Write after publication was entered and still blocked after 250 ms, and
requires a timeout-class error near the 10-second deadline. The client
remains connected and the bus open until after reclamation; early exit or
premature capacity release fails. The replacement request must receive
hello and itself release its slot. A test-owned HTTP server, pipe listener
and clients are cleaned up even after a fatal assertion.

Native Windows Winsock **stalled TCP backpressure** remains unverified;
W01/W05 are Winsock smoke tests, not full stalled-write simulations.

## Confirmed preflight (13 October 2026 AEDT)

- Parent PR head when started: **86628bacd46dc91fa31353a97e666b08d6c8166e**.
- CI run [38286105084](https://github.com/matthewhand/audio.cpp-hub/actions/runs/38286105084)
  succeeded 4/4 at the parent head. Recheck CI after the fixture commit.
- Earlier Linux full-handler blocked-write proof: **PASS 10.050799173s**
  with open client, released 64th slot, replacement SSE hello and cleanup.
- Go 1.27.1 on Linux ARM64 statically cross-compiled the new Windows-only
  test source to Windows AMD64, CGO disabled. Environment: GOTOOLCHAIN=local,
  GOPROXY=off, GOMAXPROCS=2, GOMEMLIMIT=768MiB, go test -c -p 1,
  external 45s timeout, nice/idle I/O. **Compilation PASS**, then this
  exact binary was transferred via SSH into a disposable test-owned directory,
  verified again with Windows SHA-256, and executed only after approval.
  Test executable SHA-256:
  1c15acac69d2b279a7b1c7ea25aff3e599de56e3cee1adab93962f06d8d99099.
- Read-only Windows2 SSH reachable: Windows Server 2022, 32 logical CPUs;
  ~22,683 MiB RAM available out of ~32,693 MiB; free C: 3.4 GiB,
  D: 0 GiB, E: 6.2 GiB. No Go toolchain discovered on PATH or five
  conventional locations (not an exhaustive inventory).
- PowerShell runner parsed with Windows2's own parser; corrected runner was
  verified by full native execution with process exit code 0.
- Isolated teamstinky source: /tmp/audio-156-win-fixtures-20261013.
  Dirty older review worktrees preserved. Teamstinky disk ~3 GiB free.

## Native Windows2 measured evidence — 13 October 2026 AEDT

- **Pinned test code:** 83d1f5f90ed051abe0a7748a3b45c8fe0e4a413a.
  The Windows-only Go test executable was built offline from that commit;
  its exact SHA-256 was checked before and after secure staging:
  1c15acac69d2b279a7b1c7ea25aff3e599de56e3cee1adab93962f06d8d99099.
- **Test source SHA-256:** 57d7ce385f19ebea2cc7b32610d51920c89a1b148a941aa56a1304b1a44cb122.
  Staged source included only the Windows Go fixture, runner script and
  go.mod, plus the hash-verified executable. No model or production files.
- **Native outcomes:** all W01–W06 PASS, including two W05 subtests. W06
  logged a genuine blocked net.Pipe transport-write timeout at
  **10.000684s** on the corrected run; W06 test duration **12.00s** and
  total runner wall time **12.295s**. It proved the 64th slot was
  reclaimed while the original client stayed connected; replacement SSE
  hello and its subsequent slot cleanup were asserted.
- **Hard limits:** GOMAXPROCS=2, GOMEMLIMIT=768MiB, offline Go flags,
  30-second native Go test timeout, 45-second external Windows process-tree
  watchdog, best-effort BelowNormal CPU priority. No limit was reached.
  Windows I/O priority and actual peak Go memory were **not measured**.
- **Runner defect and correction:** the first run printed Go PASS for
  W01–W06, but PowerShell 5.1 Start-Process -PassThru returned a null
  ExitCode and the script correctly refused to claim overall success.
  The runner was hardened to create and track a .NET Process directly,
  asynchronously drain stdout/stderr, and require numeric exit code 0.
  Corrected-run runner SHA-256:
  0b2b2e39b68225cefa5120328734cc5503aee9dcc655c4da71ca5700b6772ddc.
  **Corrected-run process exit code 0; complete Go PASS; empty stderr;
  SSH command exit 0.**
- **After-run cleanup:** Windows2 reported zero remaining audio156 test
  processes, zero runner temp directories; removed the four-file staging
  directory after checking its exact path, contents, and executable hash.
  Cleanup recheck: staging absent, zero test processes and runner temps.
- **Transport boundary:** W01/W05 exercised real native Windows Winsock
  loopback for hello/deadlines and disconnect/shutdown. W06 used
  deterministic net.Pipe; a live **Winsock nonreading-peer deadline and
  recovery test remains unmeasured**, requiring its own approved fixture.
- **CI provenance:** prior head 83d1f5f had GitHub CI run
  [38289470181](https://github.com/matthewhand/audio.cpp-hub/actions/runs/38289470181)
  **SUCCESS** (4/4). Runner fix and this measured evidence require
  verification of *their own final-head CI* after commit.

No production services, dependencies, recordings, models, inference,
restarts, or deployment were touched. This is not independent approval
to merge the draft.

## Repeating native Windows execution (fresh approval required)

1. Obtain separate explicit approval for each future native test session and
   any executable staging. The 13 October 2026 approval covered the completed
   run; it is not permission to deploy, install dependencies, or merge.
   Inspect a clean Windows2 worktree at the exact new PR head and recheck
   host RAM, CPU, disk, isolation and temp space. No production files.
2. Build a precompiled test executable with an existing Go toolchain
   (Linux cross-compilation acceptable if Windows2 lacks Go) and record its
   exact SHA-256. No toolchain installation, dependencies or downloads.

   ~~~sh
   GOOS=windows GOARCH=amd64 CGO_ENABLED=0 GOTOOLCHAIN=local GOPROXY=off GOMAXPROCS=2 GOMEMLIMIT=768MiB go test -c -p 1 -o audio156-pr156.test.exe .
   sha256sum audio156-pr156.test.exe
   ~~~

3. After approval and secure transfer into a test-owned Windows directory,
   use the **manual, uninvoked by CI** PowerShell runner. Paths/digest
   below are illustrative and do not assert files exist on Windows2:

   ~~~powershell
   .\scripts\qa156-windows-native.ps1 -OwnerApproved -TestExecutable 'C:\isolated\audio156-pr156.test.exe' -ExpectedSHA256 '<actual-64-hex-sha256>' -RepositoryDirectory 'C:\isolated\audio.cpp-hub'
   ~~~

   It verifies the executable name and SHA-256, requires >=512 MiB free
   disk and >=1 GiB free RAM, sets GOMAXPROCS=2 and GOMEMLIMIT=768MiB,
   applies a 30s test timeout and an external **45s process-tree watchdog**
   (taskkill limited to the test's own PID), caps printed logs to 64 KiB,
   and removes only its own unique temp directory. It uses best-effort
   BelowNormal CPU priority; native Windows I/O priority is not guaranteed.
   Native Go -race requires a suitable pre-existing CGO compiler and is
   optional, not a dependency-installation justification.
4. Collect measured W01–W06 results, timeout durations, slot counts,
   before/after handler count, logs, exit codes, SHA and exact commit.
   Review false-pass routes and test-owned process cleanup independently.
5. Verify latest-head CI and update PR/Issue #155. Recommend **human merge
   approval only**; do not change draft state, merge or deploy. #128 remains
   the deployment gate.

## Explicit limits and outstanding risk

- Net.Pipe W06 proves full handler deadline handling deterministically,
  **not** the WinSock TCP socket-buffer behavior that the earlier Linux
  socket-specific regression exercises.
- Real Windows TCP write-timeout with a connected, nonreading peer remains
  a separate unproven behavior. It must not be inferred from W06.
- W03 only guarantees best-effort 503: broken connections may be unable
  to deliver an HTTP error response to the client.
- Middleware wrappers in production must still propagate deadline support
  (or provide Unwrap); independent review should inspect this contract.
- Handler exit and slot count are distinct checks; W05 asserts both.
- W01–W06 native runtime is **PASS**, but native race-detector suitability,
  heavy-load resource consumption, real Winsock stalled-write behavior,
  and service deployment remain **unverified**.

No recordings, inference, models, service changes or production restarts.
