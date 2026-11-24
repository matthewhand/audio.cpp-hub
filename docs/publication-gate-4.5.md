# Local publication gate: evidence milestone

This gate creates local evidence and candidate packages. A pass does not establish
an overall 4.5/5 rating, authorize publication, or prove that all changes have
merged. The filename identifies the milestone, not an awarded score.

The supplied public reference is main commit
`62acde3f822ea6bf58ad8b0505a52ff47ffbcad3`. The CLI accepts any full 40-hex
expected commit. It verifies a pinned source; it does not establish that the
candidate is public, belongs to main, or is source-merged. Record candidate
provenance separately. Private functional evidence, including private c1 proof,
cannot be relabelled public proof.

## Preparation and invocation

Execute a separate copy of this driver, its wrapper, and its tests outside the
tested checkout. The tools may be versioned in the repository; copy the pinned
versions into a separate execution directory before running them, and record
their hashes. Preserve the original draft and earlier evidence externally.

Provision an isolated clean sparse checkout separately. Its tracked
`docs/media/`, `docs/screenshots/`, and `docs/assets/` directories must be absent.
The gate never fetches or restores their historical contents. Do not use an
active developer checkout, a checkout holding private runtime data, or a running
release directory.

Dependency acquisition is a separate, explicitly reviewed operation. Provision
Go modules, Node dependencies, Playwright Chromium, Chromium headless shell,
FFmpeg, browser system libraries, Go 1.27+, Node 22+, npm, a C compiler, Git, and
`ss` before invoking the gate. Dependency caches must be outside the checkout.
A dedicated host or externally enforced network policy is recommended when
running a candidate whose scripts have not been reviewed.

Create the checkout's `node_modules` symlink during preparation and ignore
`/node_modules` using only this isolated checkout's `.git/info/exclude`.
Preflight requires `git check-ignore --quiet node_modules` to succeed so the
symlink cannot mark Go's VCS build metadata modified. The driver does not change
Git configuration. The symlink must resolve to the explicitly selected external
dependency directory. This is the only permitted untracked or ignored source
entry at initial and final checks. The
gate records this exception. Share caches only under an appropriate external
read-only policy; the driver does not mount or chmod them read-only.

Example, using generic already-provisioned paths:

```bash
python3 -B /opt/local-gate/scripts/publication-gate.py \
  --source /srv/checkouts/candidate \
  --expected-sha FULL_40_HEX_CANDIDATE_COMMIT \
  --output-parent /srv/local-evidence \
  --go /opt/go/bin/go \
  --node /opt/node/bin/node \
  --node-modules /srv/offline/node_modules \
  --browser-cache /srv/offline/ms-playwright \
  --gomodcache /srv/offline/gomodcache \
  --preflight-only
```

Remove `--preflight-only` to execute the gate. The output parent must already
exist and be outside the checkout. Each execution creates a fresh uniquely
named directory. Existing evidence is preserved.

Defaults require 5 GiB free on `/`, 8 GiB `MemAvailable`, and 0.5 GiB free on
the output filesystem, with an 8 GiB run-directory budget. Explicitly reviewed
hosts can set `--min-root-free-gib`, `--min-memory-free-gib`,
`--min-output-free-gib`, and `--max-run-gib`. All must be finite and positive.
The gate records effective values and actual filesystem availability, checks
the output parent before allocation, and monitors the run filesystem during
commands and ZIP writing. It never lowers thresholds automatically.

For example, an explicitly reviewed constrained run can select
`--max-run-gib 1.25 --min-output-free-gib 0.5 --min-root-free-gib 4
--min-memory-free-gib 6 --rotate-go-cache`. The optional rotation removes only
the fresh run's `home/gocache` after backend checks and after each completed
crossbuild target, recording phase and bytes removed. It rejects symlink
traversal and never deletes shared dependencies, browser caches, receipts, or
logs. Rotation is off by default.

Preflight validates identity, cleanliness, sparse exclusions, tool versions,
required files, headless browser-cache executables, resource floors, and availability of
loopback port 4173. It allocates no run directory and performs no builds. Its
JSON evidence goes to stdout on success or stderr on failure.

## Execution and evidence

An existing headless-only Chromium cache plus FFmpeg is sufficient; full
Chromium is not required. Preflight reads `playwright-core/browsers.json` and
uses the installed Playwright resolver through the explicitly selected Node
executable. Its platform and revision selection therefore follows the actual
host rather than a hardcoded Ubuntu version. Nothing is downloaded.

The environment is constructed from an allowlist. It forces local Go
toolchains, offline module and npm settings, disabled telemetry and browser
downloads, CI behavior, bounded Go concurrency, and disabled real SSE browser
tests. Inherited proxy and network-enabling environment values are discarded.
No npm installation, npx, browser installation, toolchain upgrade, fetch,
deployment, release upload, push, or tag operation occurs.

These environment settings are not a network namespace or a comprehensive
sandbox. Candidate programs still execute. Review candidate scripts and source,
and enforce network isolation externally when required. Git local repository
configuration must also be provisioned as trusted input.

All generated logs, temporary HOME, npm cache, Go build cache, Go temporary
storage, build artifacts, smoke runtime, and packages live under the run
directory. External dependency/browser caches are inputs. Preflight commands
also use fresh process groups with bounded TERM-5-second/KILL-5-second cleanup;
their combined captured output is limited to 256 KiB without allocating a run.
Resource monitoring checks every two seconds; filesystem scans and command
cleanup add overhead, so a trip can overshoot temporarily. This scan is not a
hard process-memory cap. An externally enforced 2 GiB memory limit, no swap,
and CPU affinity are separate controls; the driver neither establishes nor
claims them. `GOMAXPROCS=2`, Go build concurrency 1, race-test parallelism 2,
and browser workers 1/retries 0 remain explicit. Race tests set CGO to 1;
release builds set CGO to 0.

The gate checks:

Before candidate quality checks, it executes the external driver's adjacent
`tests/test_publication_gate*.py` suites as a named regression phase. Their
hashes and the driver hash are verified before and after execution; preflight
alone records them as not run.

- Module integrity, tracked-file gofmt, vet, and race tests.
- Diagram contracts; TypeScript, ESLint, formatting, i18n, and service-worker
  scripts; Node unit tests.
- Four synthetic diarization Python suites, startup warmup policy, and Python
  client tests with warnings treated as errors.
- UI inventory, performance budget, axe audit, and serial Playwright E2E.
- Four CGO-disabled builds with trimpath, embedded development version, and
  verified VCS/platform build settings.
- Deterministic allowlisted ZIPs, independently reopened for exact membership,
  regular-file permissions, timestamps, and content digests.
- An executed packaged Linux/amd64 binary with loopback listener/PID ownership,
  models JSON, source index marker, missing/unknown model errors, version log,
  and listener cleanup.

The models endpoint must expose model IDs under `id` or `modelId` fields.
A contract mismatch blocks the gate for investigation rather than silently
weakening the assertion. The smoke test uses no engine executable, existing
profile, weight, inference request, or model download.

The public responsive E2E spec writes exactly three synthetic PNGs under the
excluded screenshot directory. They must be absent initially. After browser
execution, including failure, the gate moves only these known newly generated
files into `synthetic-screenshots/` and reapplies sparse checkout if needed with
lazy fetching disabled. Harvest uses exclusive copies that work across
filesystems, rejects symlinks and nonregular payloads, verifies content and
permissions, and only then removes inventoried originals. Existing destinations
are never overwritten. Verification failures preserve originals and block the
gate. Any unexpected generated source file blocks the final cleanliness check.
Known Playwright report directories receive the same treatment; the normal E2E
invocation redirects test output and disables the HTML reporter.

The JSON receipt records driver SHA256 separately from source commit/tree,
commit epoch, lockfile SHA256, tool versions, command argv, working directory,
complete environment overrides, exit codes, elapsed times, log hashes, resource
thresholds, failures, package hashes, and controlled source exceptions. A
preflight failure has JSON output rather than a run-directory receipt.
A hard machine failure or SIGKILL can leave the last incremental receipt
incomplete; it must not be interpreted as a pass.

## Package contract and issue 208 acceptance matrix

Packages use version `dev-<sha7>`. The separately published v0.2.1 remains a
different release. README content is the pinned tracked README; its historical
version statements do not rename these development packages.

| Issue 208 acceptance item | Gate evidence |
| --- | --- |
| Four release platforms | Windows/amd64, Linux/amd64, Linux/arm64, Darwin/arm64 ZIPs |
| Configuration example included | Required tracked `hub.config.example.json` in every ZIP |
| License distribution | Required tracked README, LICENSE, THIRD_PARTY_NOTICES |
| Runtime web parity | All tracked regular `web/**` files, verified against Git blob OIDs |
| No runtime/private extras | Exact member allowlist; no symlinks or recursive directory copying |
| Reproducible contents | Sorted members, commit-based ZIP timestamps, stable JSON and manifest |
| Candidate build identity | Source SHA/tree, Go version, target, CGO setting, build flags |
| Integrity | Internal MANIFEST.sha256 and relative-basename external SHA256SUMS |
| Native smoke | Packaged Linux/amd64 executed and listener removed |
| Other platforms | Crosscompiled and package-inspected; execution UNASSESSED |

`BUILD-INFO.json` excludes usernames, host paths, and build wall-clock time.
The internal manifest covers every file except itself. It uses paths relative
to the package's top-level directory.

Git blob verification applies to package inputs, preventing ignored files,
untracked assets, source cache symlinks, logs, models, data, recordings, private
driver files, or Git history from entering packages.

## Acceptance, limitations, and approval boundary

A nonzero exit, failed receipt, incomplete receipt, changed source, formatting
defect, missing dependency, missing browser, occupied port, resource violation,
or failed quality check is a hard block. A numerical target cannot override it.

The public reference has a reported gofmt defect in
`download_lifecycle_test.go`. The separate `patches/public-gofmt.patch` changes
only three whitespace alignments. Applying it dirties the pinned checkout, so
the original public SHA must fail the gate until a separately reviewed commit
contains the correction. Do not bypass the cleanliness or gofmt check. Test
the resulting candidate using its actual full commit SHA.

Axe uses a baseline of 66 contrast violations. Passing its ratchet means no
detected baseline regression; it does not establish WCAG compliance. Native
Windows, macOS, and Linux/arm64 execution remain UNASSESSED. A control host can
later execute Linux/arm64 with separately labelled evidence.

The overall rubric remains Reliability 25%, Security/privacy/licensing 20%,
UX/accessibility 20%, Portability/release 15%, Docs/onboarding 10%, and
Tests/performance/maintainability 10%. Missing evidence is UNASSESSED.
Critical security and rights blockers remain independent of any score.
The nine gate areas are a local milestone only. The overall weighted 4.5
assessment remains UNASSESSED; missing evidence and independent critical or
rights blockers cannot be converted into a pass by a numerical target.
This gate awards no arbitrary scores and establishes no privacy-history or
licensing-rights clearance.

Publication requires separate human review of provenance, package and receipt
hashes, rights, security, known accessibility debt, native-platform evidence,
release notes, and unresolved blockers. A local pass is not approval to
publish or deploy.

Rollback requires no live-release action: preexisting running releases are
untouched. Retain or manually remove only the identified run directory under
the organization's retention policy. Never remove user data, shared caches,
prior results, or running release directories as gate cleanup.

Run the gate's self-contained regressions outside the candidate:

```bash
python3 -B -m unittest discover \
  -s /opt/local-gate/tests -p 'test_publication_gate*.py'
```

These tests need Python and Git; the process cleanup test additionally uses
Linux `/proc`. They do not require Go, Node, browsers, or network access.
