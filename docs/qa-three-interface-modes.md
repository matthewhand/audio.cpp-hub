# Classic / Flow / Cockpit validation

Classic, Flow and Cockpit share the existing models, editor, results and polling. This change preserves the current header and loads alternate layouts on demand.

## Functional scope

- Classic remains default, sharing models, editor drafts, results and existing
  requests/polling with Flow and Cockpit.
- Flow uses existing local model routes and explains unavailable/unconfigured
  categories. Cockpit is read-only and displays task metadata without prompts.
- Stale instance feeds remain unverified, never fabricated healthy/zero state.
- Mobile drawers hide/inert the closed catalog and restore focus on close.
  Flow drawer trapping also handles initial focus on its tabindex=-1 list.
- Model selection uses native buttons with independent download/repository
  controls. A repository popover survives queued/irrelevant scroll events and
  closes when its anchor actually moves.
- Alternate modules and layout CSS load on demand. Critical mode controls use
  the existing stylesheet, preserving the initial request budget. Both CSS
  chunks are precached for offline use.

## Validation and limits

The focused mocked Chromium suite exercises: responsive 320–1920px,
EN/ZH, shared draft/state, keyboard mode and model selection, drawer focus,
1100/1101px transitions, blocked bootstrap, import retry, stale data and recovery,
private task payload exclusion, chronology, unknown times and read-only behavior.
Node unit tests, typecheck, ESLint, locale parity, SW precache, generated inventory
and initial resource budgets are checked separately.

The synthetic suite is not a live hub/model or screen-reader acceptance receipt.
The accompanying PR records the tested private RC and isolated-branch results. Screen-reader, platform and deployment acceptance remain separate from these source checks.
