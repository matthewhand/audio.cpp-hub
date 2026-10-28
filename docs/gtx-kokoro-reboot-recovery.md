# GTX Kokoro Reboot Recovery Runbook — verified installed state

**Verified read-only on 27 October 2026, 18:28 AEDT:** The separate
`audio-cpp-hub-kokoro-bluegreen.service` is **enabled and active**, and its
`ExecStartPost` completed once at **06:10:24–06:10:28 AEDT** with
`code=exited, status=0` and `Result=success`. The installed script matched
the original staged Git blob `4bf11debe935a5a16d02294ad0b14557fdf5e472`.
The pinned hub binary SHA-256 matched too.

**Limits:** This confirms one successful installed startup hook, not complete
crash recovery, a full reboot/fallback matrix, TalkingHead cutover, or a soak.
No service or deployed code was changed by the source-only audit. The original
`audio-cpp-hub.service` on :18080 remains a separate protected unit.

## Scope

`docker/kokoro-ensure-ready.py` (719 lines in the deployed baseline; stdlib-only,
host-specific pinned facts) is installed as an `ExecStartPost` for the **candidate** hub on
`http://127.0.0.1:18280`. It attempts to establish and verify one Kokoro instance, failing closed otherwise:
`instanceName=kokoro`, `modelId=kokoro_tts`, `backend=cpu`, `threads=2`,
engine port `18290`, weights at the pinned Q8 path, with `/v1/models`
advertising exactly the alias `kokoro`.

**Protected resources — must not be touched by anything in this plan:**

- The live production hub on **:18080** (untouched; the script hard-validates
  the loopback URL and never reaches it).
- The original hub unit and the **Breeze / Sanotts** services (never modified).

## Pinned paths and facts (from the script, do not drift)

| Item | Value |
|---|---|
| Hub binary | `/home/matthewh/dev/audio.cpp-hub-bluegreen-20261024/audio.cpp-hub` |
| Binary SHA256 | `217d0a913b194701fc50400e99fa868fd96bfc2be87de5236bc44ecb6590490c` |
| Hub base URL | `http://127.0.0.1:18280` |
| Engine port | `18290` |
| Weights | `/home/matthewh/audio.cpp-hub/models/Kokoro-82M-GGUF/kokoro-82m-q8_0.gguf` |
| Model ID / alias | `kokoro_tts` / `kokoro` |

## Effective systemd configuration — candidate only

This is a record of the *installed* configuration, not a deployment recipe.
The main unit is
`/etc/systemd/system/audio-cpp-hub-kokoro-bluegreen.service`.
The drop-in is
`/etc/systemd/system/audio-cpp-hub-kokoro-bluegreen.service.d/50-kokoro-ensure-ready.conf`.

```ini
# Read-only effective settings; main unit and drop-in combined:
[Service]
Type=simple
Restart=no
CPUQuota=200%
MemoryMax=4G
TasksMax=120
IPAddressDeny=any
IPAddressAllow=localhost
Environment=KOKORO_ENSURE_UNIT=audio-cpp-hub-kokoro-bluegreen.service
TimeoutStartSec=150
ExecStartPost=/usr/bin/python3 /home/matthewh/dev/audio.cpp-hub-bluegreen-20261024/docker/kokoro-ensure-ready.py
```

The installed unit is **enabled**, but `Restart=no`. The hook runs during a
service *start*, not continuously after crashes. An old comment in the live
drop-in still says "NOT enabled at boot"; that comment is **stale** but does
not change systemd effective state. Editing the live drop-in is out of scope.

The startup identity check requires the pinned service name, systemd
`INVOCATION_ID`, a matching `/proc/<MAINPID>/exe`, cgroup and exact
loopback listener ownership. This script is **not** a standalone operator
health probe; its production entrypoint can create an instance.

### Port + PID listener-owner guard

In production mode, `check_bootstrap_guard` validates executable and unit
identity; `wait_for_owned_listener` / `check_listener_owner_guard` then uses
read-only `/proc` inspection **before any HTTP request** to prove that
the same MAINPID owns the pinned listening socket:

1. `/proc/<MAINPID>/cgroup` must contain an entry whose path components are
   exactly `system.slice/audio-cpp-hub-kokoro-bluegreen.service` (exact
   membership, not a substring — deeper-scope paths are rejected).
2. `/proc/net/tcp` must show exactly one `TCP_LISTEN` (state `0A`) entry with
   local address `127.0.0.1:18280` (hex `0100007F:4768`); a wildcard
   `0.0.0.0` listener on that port, a foreign interface listener, or any
   ambiguous extra listing fails closed. If `/proc/net/tcp` is unavailable,
   the run fails (exit 12).
3. One `readlink` target under `/proc/<MAINPID>/fd/*` (bounded walk of at
   most 1024 fds) must equal `socket:[<that entry's inode>]` — so a rogue
   process occupying the port while the unit starts cannot pass.

No network calls are involved. After validating the systemd invocation,
`wait_for_owned_listener` gives the candidate a **bounded initial bind window**:
an *absent* listener may be retried, but a foreign, wildcard, mismatched or
wrongly owned listener fails immediately. The guard then runs again in
`verify_live_identity` immediately before POST and before accepting READY.
It is never needed (or run) in synthetic test mode.

Observed host reference: `/proc/net/tcp` local hex `0100007F:4768`, state
`0A`, socket inode `5796352`, fd link `/proc/<pid>/fd/3 ->
socket:[5796352]`, cgroup `/system.slice/audio-cpp-hub-kokoro-bluegreen.service`.

## Remaining acceptance and risks

1. **Only one successful startup is observed.** The hook ran on 27 October.
   It does not establish controlled failed starts, crash recovery, power-cycle
   reliability, remote-client fallback, MP3 synthesis, or sustained soak.
2. **No automatic crash restart:** The unit is enabled with `Restart=no`.
   A startup hook cannot by itself recover a later stopped/crashed service.
3. **Failure is consequential:** A nonzero `ExecStartPost` fails the candidate
   unit startup. Codes 11–21 cover bad env/identity, pressure, models,
   paths, HTTP, target mismatch, POST failure, state, deadline and alias.
   The original :18080 service is outside this hook's authority.
4. **Python Kokoro :9093 / TalkingHead state must be checked separately.**
   Earlier runbooks describe :9093 as fallback, but this audit does not prove
   that it is still working or that remote consumers have been migrated.
5. **Installed bytes are separate from candidate source.** Source-only
   comments/tests do not update the installed hook. Any future deployment,
   controlled restart/failure test or unit edit needs separate approval.
6. **120-second budget is not a hard deadline:** The code checks a 120s
   monotonic deadline; an in-flight 5s HTTP call can finish beyond the
   boundary. Effective `TimeoutStartSec=150` is confirmed.

## Operator quick reference

- **Synthetic offline tests** (fake HTTP, clock, `/proc` and weights; no
  real instance creation): `PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest
  discover -s tests -p test_kokoro_ensure_ready.py` from the isolated source
  workspace (command wraps visually across two lines).
- **Read-only unit check:** `systemctl show
  audio-cpp-hub-kokoro-bluegreen.service -p UnitFileState -p ActiveState
  -p Result -p ExecStartPost`.
- **Do not manually invoke the production helper:** it may POST an instance
  creation. No restart, reload, enable/disable, route change or production
  file overwrite is authorized here.
- On status 12/15, reverify the pinned files/identity; never silently alter
  checksums to pass the gate. On 16/18, inspect staging availability.

## Source-only status

The corrective worktree is not installed. It preserves all existing branches,
the three original staged blobs, GTX fanout edits and both hub services.
