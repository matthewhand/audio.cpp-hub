# Issue #128 — Voice-farm release baseline with ubuntu-max SSH unavailable

**Evidence date:** 2026-10-12. **Status:** Read-only. No merges, deployments, service
restarts, model generation requests, mount changes, or production writes.

This is a snapshot of **HTTP-served content**, not proof that an endpoint runs
an immutable Git revision. The clean GitHub main revision inspected was
**b5d8157**. Both ubuntu-max static UIs served HTTP 200 although SSH timed out
and their /api/instances and /api/models GET calls timed out at seven seconds.

## Served UI asset fingerprints

SHA-256 prefixes for raw HTTP assets, requested directly rather than through a
cached service worker. Full SHA-256 hashes and per-viewport metrics are in
[the JSON evidence](../media/issue-128-offline/assets-and-browser-metrics.json).

| Deployment | Root HTML | style.css | app.js | sw.js | Overflow at 390px |
| --- | --- | --- | --- | --- | --- |
| ubuntu-max AMD :18080 | 7692d7642294 | aac936f65078 | 8bb173228784 | 28396ee7e8e4 | 58px |
| ubuntu-max Qwen3 :18081 | 7e7796316e49 | 14b2fdde7d9d | 34839a5026d6 | dda7ae151191 | 106px |
| ubuntu-gtx :18080 | 6c4ded3802b1 | a80c01d92b44 | c74fdce2ec0f | 46561f030831 | 0px |
| windows2 CPU :18080 | 7e7796316e49 | 14b2fdde7d9d | 34839a5026d6 | dda7ae151191 | 106px |

**Three distinct asset groups:** Qwen3 and Windows match one another for all
four assets. AMD and GTX each serve another set. None of the four matches the
complete inspected clean GitHub main HTML/CSS/app/SW bundle.

GTX serves its **dirty working-source files directly**, not a clean Git
commit: the four served hashes exactly match files under
~/audio.cpp-hub/web, branch fix/119-webui-qol (committed HEAD 1fb5092;
26 uncommitted entries). The served HTML differs from committed HEAD content.
Do not reset, overwrite, silently redeploy, or recreate that checkout.

## Real responsive browser screenshots

The linked images are **real Chromium captures of live deployments**, not
generated design concepts or screenshots of source PR #143 deployed to hosts.
All 12 initial page requests returned HTTP 200 with no observed page-level
JavaScript exception. Service workers were blocked for reproducible raw
asset comparisons; this does **not** validate SW activation. Screenshots do
not prove genuine audio synthesis or durable histories.

| Deployment | Mobile 390px | Laptop 1366px | Desktop 1920px |
| --- | --- | --- | --- |
| AMD | [Image](../media/issue-128-offline/max-amd-mobile.png) | [Image](../media/issue-128-offline/max-amd-laptop.png) | [Image](../media/issue-128-offline/max-amd-desktop.png) |
| Qwen3 | [Image](../media/issue-128-offline/max-qwen3-mobile.png) | [Image](../media/issue-128-offline/max-qwen3-laptop.png) | [Image](../media/issue-128-offline/max-qwen3-desktop.png) |
| GTX | [Image](../media/issue-128-offline/gtx-mobile.png) | [Image](../media/issue-128-offline/gtx-laptop.png) | [Image](../media/issue-128-offline/gtx-desktop.png) |
| Windows | [Image](../media/issue-128-offline/windows-cpu-mobile.png) | [Image](../media/issue-128-offline/windows-cpu-laptop.png) | [Image](../media/issue-128-offline/windows-cpu-desktop.png) |

Issue #139 / draft PR #143 cover mobile overflow but cannot fix older live
assets until a separate explicitly approved rollout.

## Host / API baseline

| Host | Evidence | Release blocker |
| --- | --- | --- |
| ubuntu-max | SSH timeout, static AMD and Qwen3 UIs answer 200, two API GET paths time out after 7 sec | Recover resource/host and API health first |
| ubuntu-gtx | SSH works, systemd audio-cpp-hub.service serves port 18080, 26 dirty repo entries | Preserve directly served mutable files; prepare immutable artifact elsewhere |
| windows2 | Docker container audio-cpp-hub-cpu running image audio-cpp-hub:cpu-espeak (image ID sha256:04c44f1425f20c2a0181c1ba7fd282dd3da992f04cf0c57f2b1640657662c134) | All five E: bind mounts inaccessible: issue #127 |

GET /api/instances returns two READY instances on GTX (breeze-tts,
sanotts on Vulkan) and one READY SanoTTS CPU on Windows. **READY does not
prove synthesis or persistence.** Windows's mount bridge is broken despite
READY. No inference jobs were submitted. The mandated **five real non-silent
WAVs and verified matching history entries** remain pending approval, actual
endpoint inventory and host recovery.

## Windows2 SanoTTS storage gate (#127)

Five Docker mount destinations return Invalid argument:
- E:\audiocpp-hub\data -> /app/data (RW)
- E:\audiocpp-hub\logs -> /app/logs (RW)
- E:\audiocpp-hub\run -> /app/run (RW)
- E:\audiocpp\bin -> /audio.cpp/bin (RO)
- E:\audiocpp\models\sanoTTS-heart-nano-GGUF -> /audio.cpp/models (RO)

All corresponding directories exist on Windows; E: is NTFS, healthy, with
approximately 6.75 GB reported free. In the already-running docker-desktop
WSL distribution, /mnt/host/c is readable but /mnt/host/e returns Invalid
argument. Separate **9p/DrvFs** mounts appear in /proc/self/mountinfo.
This isolates the observed fault to the Windows-to-WSL E: filesystem bridge
before container bind mounts, not only SanoTTS history code.

**No approval exists to restart Docker Desktop, WSL, containers or remount
E:.** Those operations could interrupt DSH, JEV, Kokoro, Portainer and other
running Windows2 services. Preserve all weights, histories and volumes.

## Approval-gated recovery and release plan (not executed)

| Gate | Preflight / action to propose for approval | Stop / rollback criterion |
| --- | --- | --- |
| 0 — Record baselines | Capture exact binary/image hashes, units/Compose definitions, env handling, writable mount mappings, free space and backup status without exposing secrets | No changes without verified recovery artifacts and explicit scope approval |
| 1 — ubuntu-max recovery | After SSH returns, audit memory, swap, storage, process/build pressure, Go hub API and pinned source read-only | Stop if resource pressure or API timeout persists |
| 2 — GTX isolation | Preserve 26 dirty entries and current served files; build/test pinned clean-source artifact in a separate worktree | No git reset/clean of production checkout, no direct overwrite of served files |
| 3 — Windows bridge repair | Review all Windows Docker dependents and backups, then request a maintenance window for the smallest reversible E: bridge repair | Abort if C:/E: integrity, data or dependent container health cannot be preserved |
| 4 — Single-host controlled rollout | Only after approval, stage one immutable revision per host and verify actual HTML/CSS/app/SW hashes, readiness and responsive UI | Restore that host's recorded artifact if checks regress; do not automatically touch other hosts |
| 5 — Live audio QA | After explicit approval, generate unique per-instance short WAVs; verify valid RIFF, duration, non-silence, correct model and retrievable matching history | Missing WAV/history, false READY, mount failure or inconsistent assets prevents closure |

Do not execute a Docker/WSL shutdown, restart, disk remount, data deletion or
production rollout based only on this document. Windows-specific rollback
commands, downtime and backup locations require separate operator approval.

## Read-only reproduction references

For an operator-authorized endpoint, HTTP raw-asset checks:

~~~shell
curl --connect-timeout 3 --max-time 8 -sS -o /dev/null -w '%{http_code}\n' "http://<host>:18080/"
curl --connect-timeout 3 --max-time 8 -fsS "http://<host>:18080/style.css" | sha256sum
curl --connect-timeout 3 --max-time 8 -fsS "http://<host>:18080/sw.js" | sha256sum
~~~

Windows mount diagnostics, requiring no restart or test write:

~~~powershell
wsl -d docker-desktop -e sh -c "ls -ld /mnt/host/c /mnt/host/e; grep /mnt/host /proc/self/mountinfo"
docker inspect --format '{{range .Mounts}}{{.Source}} -> {{.Destination}} {{.RW}}{{println}}{{end}}' audio-cpp-hub-cpu
~~~

**Release gate remains OPEN:** actual deployed pinned revisions, approved
repairs, verified non-silent synthesis/history from all intended instances,
real browser screenshots, SW activation and documented rollbacks.
