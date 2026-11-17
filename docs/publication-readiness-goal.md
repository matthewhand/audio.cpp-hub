# Publication-readiness goal

Set on 18 November 2026 (Australia/Sydney). This goal continues the verified source handoff and the user's supplied strategic handover.

## Intended outcome

Prepare an independently reviewed Audio.cpp Hub release candidate that earns at least 4.5/5 under the original weighted rubric, with no unresolved critical defect or high-severity publication privacy/rights blocker. Keep standalone transcription and Read Aloud independently usable; conversations remain an optional composition.

The overall score is currently **unassessed**. Completing the local publication gate is one milestone and does not by itself establish 4.5/5.

## Rubric

| Category | Weight |
| --- | ---: |
| Reliability and correctness | 25% |
| Security, privacy and licensing | 20% |
| UX and accessibility | 20% |
| Portability and release operations | 15% |
| Documentation and onboarding | 10% |
| Tests, performance and maintainability | 10% |

Reviewers must link each component score to evidence for the same frozen candidate. Missing evidence remains unknown. A weighted average cannot override a hard publication blocker.

## Baselines and ownership

- Public baseline: `62acde3f822ea6bf58ad8b0505a52ff47ffbcad3`; source tree `c53a09b4045afce59007946cca644eee72927ae3`.
- Reconciled private application: `c1e68194960cf9822023dd68261fa9be7220dc08`, branch `closeout/max-to-gtx-20261118`, canonical development checkout `/home/matthewh/dev/audio.cpp-hub-dev-private` on Ubuntu-GTX.
- Gate implementation branch: `gate/publication-20261118`, in a separate private worktree.
- The private repository's `main` at `13d1a96e22be7154969e54d87a741f479f44f1dc` is archival recovery material.
- The twelve public PRs are integrated privately; they are not all present in the public baseline. Tests and packages must identify which source they accept.

## Current milestone: local publication gate

1. Pin source and independent driver identities; preserve the original Grok draft and all prior receipts.
2. Use existing dependencies and tools; enforce offline resolution, bounded concurrency/deadlines, unique output and owned-process cleanup.
3. Pass backend verification and relevant synthetic regressions on the pinned source.
4. Pass frontend, metadata, inventory, performance-budget and diagram checks.
5. Pass a fresh-server browser suite with one worker and zero retries; report accessibility debt accurately.
6. Build the four package targets with exact source/version/toolchain metadata.
7. Independently inspect exact package contents, configuration examples, licence notices, manifests and checksums.
8. Execute the packaged Linux amd64 candidate with an owned loopback listener and bounded synthetic HTTP contracts.
9. Produce a release-parity dossier against published v0.2.1, including limitations, onboarding and rollback procedure.

No overall score is awarded merely by counting these checks.

## Further acceptance before a defensible publication rating

- Resolve the exact proposed release scope and public closeout of reconciled PRs.
- Review the concrete payload and proposed Git-history exposure for privacy, rights and licensing. Private issue #6 remains a separate history/rights workstream; closed PR #154 does not prove historical exposure retired.
- Address the known accessibility contrast debt and verify keyboard, mobile and desktop journeys on the intended candidate.
- Establish supported model/engine versions and actual management/network/retention boundaries.
- Prepare rights-cleared, bounded TTS, transcription, history, cancellation and recovery acceptance. Real model inference, production switches and Windows recovery retain their execution gates.
- Verify rollback with isolated fixture state; production rollback execution is separate.
- Obtain independent category ratings and calculate the weighted result.
- Present the concrete payload and remaining consequences for explicit publication approval.

## Authorization and preservation

Current work covers isolated private implementation, source inspection, local synthetic tests and package preparation. Public pushes/merges/tags/uploads/releases, hosted CI, deployment, live model inference, media-history rewriting and Windows recovery are not authorized by this local milestone.

Preserve current services, models, state, recordings, rollback paths, original agent work and unrelated dirty routing changes. Max is paused for new builds because its 5 GiB root free-space floor is breached. The bounded GTX validation plan uses an owned tmpfs workspace, a 6 GiB available-RAM reserve, a 4 GiB root free-space floor, an externally enforced 2 GiB memory limit with no swap, two-CPU affinity, Go package concurrency one and one browser worker. This is a temporary execution exception below the host runbook's 10 GiB storage target; it does not remedy host storage pressure. All test network traffic is confined to an isolated loopback namespace. Do not treat the older handover's capacity numbers as current.

Research issues #16, #17 and #18 are completed specifications. Their runtime acceptance remains separate; do not reopen or duplicate those plans.
