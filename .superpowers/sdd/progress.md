# Phase 4 SDD Progress

Branch base: `1c4707761d227ac93fbf5222adc30b2ce1f43cb9`
Plan: `docs/superpowers/plans/2026-07-12-phase-4-code-intelligence-lsp.md`
Baseline: 22 test files passed, 2 skipped; 178 tests passed, 2 skipped.

| Task | Reviewed commit range | Implementation review | Independent spec review | Focused and integration evidence |
|---|---|---|---|---|
| 1 — bounded transport | `0a9b46f..9910c35` | Approved after transport-boundary and outbound-frame fixes | Compliant | 22 focused tests; final server suite 200 passed / 2 skipped; typecheck and build passed |
| 2 — session lifecycle | `9910c35..af00c7d` | Approved after race, replay, timeout, and reconnect-serialization fixes | Compliant | 40 focused tests; final server suite 218 passed / 2 skipped; typecheck and build passed |
| 3 — documents/diagnostics | `af00c7d..7ff5793` | Approved after extension, URI, waiter, normalization, and post-open realpath checks | Compliant | 17 focused tests; final server suite 235 passed / 2 skipped; typecheck and build passed |
| 4 — seven MCP tools | `7ff5793..70eef90` | Approved after descriptor-safe, bounded normalization hardening | Compliant | 15 tool tests; final server suite 252 passed / 2 skipped; typecheck and build passed |
| 5 — optional LSP host | `70eef90..638cff2` | Approved after close-race, child-lifetime, listener, and owned-error fixes | Compliant | 25 focused tests; final server suite 279 passed / 2 skipped; typecheck and build passed |
| 6 — live acceptance | `638cff2..fe729ec` | Approved after capability, identity, cleanup, and fixture-isolation fixes | Compliant | Phase 4 live 2/2; two normal parallel all-live runs 305/305; standard suite/typecheck/build passed |
| 7 — docs/integration | Initial commit `5c5bd51`; correction commit pending | **Changes requested:** exact seven-tool input/output documentation and stronger contract assertions required; re-review pending | Final Task 7 spec approval and controller-owned whole-branch review pending | Initial matrix recorded in `task-7-report.md`; corrected range will be finalized by the controller after approval. Do not mark Phase 4 complete before both gates pass |

## Capability and deferral ledger

- Public Phase 4 inventory is exactly seven read-only `godot_lsp_*` tools, bringing the current branch inventory to exactly 38 tools.
- Godot 4.6 does not advertise `workspace/symbol`; `godot_lsp_workspace_symbols` returns `feature_disabled`. Per-document symbols are the supported alternative.
- The Phase 4 part of `Q-002` is resolved: Phase 1 is the API prerequisite; completed Phase 2 is a coordination and regression milestone. Phase 6 dependency strength remains open.
- Portable Node APIs cannot make mutable-path authorization and `open()` fully atomic on every platform. Phase 4 narrows the race with canonical pre/post-open validation and same-handle reads; hostile-filesystem atomicity remains deliberately deferred to Phase 6/7.
- Phase 6 broader `FsGuard` and Phase 7 uniform safety/audit/cache hardening remain deferred and are not claimed by Phase 4.
