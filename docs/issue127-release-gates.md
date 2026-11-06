# SanoTTS CPU recipe validation and acceptance gates

The optional Linux CPU recipe pins its build inputs and keeps model files separate from the image context. It does not migrate or repair an existing Windows/Docker installation. Reference issue #127 remains an operational acceptance task.

## Verified source and native runtime checks

- Offline build-phase regressions cover fresh/reused outputs, corrupted archives, missing notices and mismatched reuse configuration.
- The private RC built the pinned v0.9.3 engine from an empty build directory (524 build steps), passed both upstream SanoTTS tests, and generated a non-silent 24 kHz WAV through the actual hub UI. Playback and restart/history preservation passed.
- Static Compose validation checks loopback binding, explicit opt-in, no restart policy, separate named state volumes, read-only model access, hub-only startup and skipped warm-up. It does not start a container.

## Remaining acceptance

Container image/ABI validation, Windows storage repair and production rollout were not exercised. The native Linux result does not establish those outcomes. No model weights are included in this PR; weight redistribution terms remain unresolved. Keep issue #127 open until its platform-specific storage, synthesis and durable-history evidence is complete. The PR description records exact RC source/artifact identities and validation limits.
