# GTX audio.cpp-hub warm-up/restart loop — staged, not deployed

**Status (12 October 2026):** review-only source branch. DO NOT start, stop,
restart, daemon-reload, merge or deploy anything as part of this patch review.

## Observed failure

On `ubuntu-gtx`, the installed `audio-cpp-hub.service` (different from
tracked Docker examples) runs two `ExecStartPost` hooks:

1. `docker/start-instance.sh` starts Breeze, waits for `READY`, and sends
   `POST /v1/audio/speech` to force a warm model. A 502, timeout, empty WAV,
   or malformed WAV exits nonzero, failing systemd startup.
2. `start-sanotts-instance.sh` starts SanoTTS and warms it. Its failures are
   handled nonfatally, but this second hook may never run if Breeze fails.

The installed service has `Restart=on-failure`, `RestartSec=5s`.
Journal records from 12 October show repeated Breeze warm-up timeouts / HTTP
502 leading to startup failure and immediate retries (last observed
`NRestarts=338` at 17:48 AEDT). Heavy memory/I/O pressure was simultaneously
observed: approximately 11 GiB swap used on a 15 GiB RAM host and an
unexplained ~9 GiB unreclaimable kernel slab. This association does **not**
prove that Breeze caused the slab allocation.

## Source policy (all opt-in; default unchanged)

| Setting | Behavior |
| --- | --- |
| No new environment flags | Legacy behavior: Breeze warm-up **required**; failures abort startup |
| `AUDIOCPP_STARTUP_MODE=hub-only` | Both post-start helpers exit before any instance creation, model load, API request or speech synthesis |
| `AUDIOCPP_WARMUP_POLICY=skip` | Breeze instance creation/READY waits still happen; skips only Breeze warm-up. **SanoTTS still starts/warms** |
| `AUDIOCPP_WARMUP_POLICY=best-effort` | Breeze starts normally, but warm-up HTTP failure, empty WAV, or invalid WAV logs a warning and exits success; SanoTTS still starts/warms |
| `AUDIOCPP_WARMUP_MAX_SECONDS=1..30` | Bounded HTTP warm-up duration in best-effort policy; default 15. Strict legacy timeout remains 300 |
| `AUDIOCPP_WARMUP_WAV` | Override default `/tmp/audio-cpp-hub-warmup.wav`; useful for isolated tests without touching global temp paths |

**Best option during a resource incident:** `hub-only`. The main Go hub
can serve management functionality but no instance is automatically ready.
The two post-start scripts must first be upgraded to the reviewed version;
setting `AUDIOCPP_STARTUP_MODE` alone against the old installed scripts
does nothing.

A staged example systemd drop-in is at
`docs/examples/gtx-hub-only-recovery.conf`. It is **not installed** and
does not modify systemd or a running process.

## Approval-gated deployment and rollback design

Do not execute any of these steps without a separate explicit approval.

1. Verify authenticated GTX connectivity, low CPU/RAM/swap/I/O pressure,
   disk headroom and availability of dependent audio clients/failover.
   Capture installed scripts and complete unit/drop-ins, current hashes,
   permissions, `NRestarts`, open ports and model readiness *without*
   triggering inferential health checks.
2. Back up the two installed startup scripts and relevant systemd unit/drop-in
   in a separate protected location. Preserve git worktrees and existing
   uncommitted work; do not copy a whole unrelated checkout over them.
3. Install ONLY the reviewed scripts and opt-in
   `70-startup-recovery.conf` with `AUDIOCPP_STARTUP_MODE=hub-only`;
   validate shell syntax and `systemd-analyze verify` in a bounded way.
4. After explicit operational authorization, perform one controlled
   systemd daemon reload and one bounded restart. Confirm hub API and
   management UI are responsive **without** loading/synthesizing models.
   Confirm no new auto-start of `breeze` or `sanotts`.
5. Monitor systemd restart counter and memory/IO PSI. If there are errors,
   restore original scripts, remove only the new drop-in, daemon-reload
   and perform a **separately approved** controlled restart.
   Restore model service using the original or an approved best-effort
   policy only after host resources and the underlying TTS failure
   have been investigated.
6. The hub being alive with `hub-only` is **not** TTS readiness. Expect
   Breeze/SanoTTS inference to be unavailable locally. Keep LAN clients
   on known-good failover (when verified), not an assumed warm instance.

The host unit may also contain an `EnvironmentFile`; confirm the exact
environment precedence and effective values on the host before relying
on a drop-in. Never log secrets or inspect credentials.

## Test policy

`python3 -B -m unittest discover -s tests -p test_startup_warmup_policy.py -v`

The regression uses isolated temporary dummy weight/executable files and
a fake `curl` on PATH. It tests shell syntax, no-network hub-only mode,
strict legacy exit, skipped warm-up, best-effort failure/timeout behavior
and synthetic valid/malformed/empty WAVs. It never loads a model, contacts a
hub or uses real service APIs. Avoid broad integration or CI runs on GTX.

## Remaining risks

- `hub-only` bypasses the post-start scripts but does not change the Go
  hub itself, its listener, or resource behavior from existing requests.
- Neither best-effort nor skip prevents initial Breeze instance loading or
  SanoTTS warm-up. Do not enable those modes during severe GTX pressure.
- A future resource-safe production fix should independently review the
  9 GiB `kmalloc-rnd-01-64` kernel slab cache and repeated TTS HTTP 502
  rather than treating a boot policy as a root-cause cure.
- All changes here are non-production source/documentation only.
