# Phase 4 Task 7 Report

## Status

Implemented and verified. Task 7 documents the exact 38-tool branch surface, including all seven Phase 4 LSP contracts, resolves only the Phase 4 portion of `Q-002`, updates implemented architecture evidence without relabeling future Phase 5–8 work, regenerates checked-in diagrams, and records the Tasks 1–6 review ledger. Whole-branch review remains controller-owned and has not been dispatched or represented as complete.

## TDD evidence

RED: `node --test tests/architecture/*.test.mjs` exited 1 with the three new Phase 4 documentation assertions failing because the README lacked all seven LSP contracts, Phase 4's dependency remained unresolved, and atlas boundaries remained planned/inferred-only.

GREEN after documentation/source changes and rendering: `node --test tests/architecture/*.test.mjs` exited 0 with 90 passed, 0 failed, and 1 explicitly optional external-source-archive check skipped.

## Implemented integration

- README: exactly 38 tools; exact seven LSP names, inputs, structured outputs, and read-only annotations; zero-based UTF-16 positions; exact-disk synchronization; configuration defaults; exact manual command; visible-editor attachment; owned-child-only shutdown; Godot 4.6 workspace-symbol limitation; document-symbol alternative; actionable `not_connected`, `feature_disabled`, and diagnostics-timeout guidance.
- Architecture: Phase 4's solid Phase 1 API dependency and completed Phase 2 coordination/regression milestone; Phase 6 remains open; implemented Phase 4 channel/component/adapter behavior; implemented lifecycle operations while retaining the named state model's honest inferred-projection status.
- Q-002: accepted narrowly for Phase 4, explicitly unresolved for Phase 6.
- Traceability/rendered artifacts: source rows updated and all eleven atlas artifacts regenerated; Task 7 changed the requested Phase 4-relevant SVGs and manifest as determined by source digests.
- Ledger: exact reviewed ranges and already-recorded focused/live evidence for Tasks 1–6. Portable atomic mutable-path authorization remains deferred to Phase 6/7.

## Complete verification matrix

- `cd server; npm test -- --run; npm run typecheck; npm run build; npm run docs:check` — exit 0. Unit suite: 28 files passed / 3 environment-gated files skipped; 301 tests passed / 4 skipped. Typecheck, build, and offline-doc integrity check passed (`1065` classes, `24256` members, `9697180` bytes).
- `node --test tests/architecture/*.test.mjs` — exit 0; 90 passed, 0 failed, 1 optional external-archive check skipped.
- Exact supplied `GODOT_PATH`; `node tests/godot/run-smoke.mjs` — exit 0; all named transport, parser, execution, introspection, Phase 3, and lifecycle smokes reported PASS. The Mono executable emitted expected environmental `.NET SDK 8.0.28` and forced-editor teardown/leak noise during negative/lifecycle probes; no smoke assertion, compilation gate, or lifecycle gate was ignored.
- Exact supplied `GODOT_PATH` and resolved fixture `GODOT_PROJECT_PATH`; `npm run test:live` — 1/1 passed.
- Same environment; `npm run test:live:phase3` — 1/1 passed.
- Same environment; `npm run test:live:phase4` — 2/2 passed, including Godot 4.6 capability honesty.

## Concerns and deferred work

- Godot 4.6 does not advertise `workspace/symbol`; the stable tool correctly returns `feature_disabled` and directs users to per-document symbols.
- Portable Node APIs do not provide a cross-platform atomic path-authorization-plus-open primitive. Phase 4's canonical pre/post-open checks and same-handle read narrow the race; broader hostile-filesystem containment remains deferred to Phase 6/7.
- Phase 6's dependency strength under `Q-002`, broader `FsGuard`, and Phase 7 uniform hardening remain open and are not claimed here.
- The controller must request and adjudicate the whole-branch review before marking Phase 4 complete.

## Changes-requested correction

Review of initial Task 7 commit `5c5bd51` requested exact public contract detail rather than summary output names. The correction expands all seven input schemas and normalized structured-output variants, including nested positions/ranges, completion trigger context, optional normalized fields, diagnostic and signature truncation categories, symbol recursion/location fields, native found variants, and workspace error outcomes. The architecture regression now cross-checks the production registrations/schema markers and requires representative nested/output tokens in the runbook.

The existing Task 7 range is `fe729ec..e04e59d`: initial integration commit `5c5bd51` followed by exact-contract correction `e04e59d`. Re-review then requested one final narrow correction: distinguish malformed successful workspace-symbol payload normalization from LSP request/protocol failure and repair the ledger metadata. That final correction commit and approval are pending at this point in the report. The controller will finalize the exact corrected range and review result only after approval; whole-branch review remains controller-owned and pending.
