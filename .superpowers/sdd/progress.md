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
| 7 — docs/integration | `fe729ec..ec68042` | Approved after exact-contract, ledger, and workspace-symbol semantics corrections | Compliant | Architecture 90 passed / 1 optional skip; docs check and build passed; complete matrix recorded in `task-7-report.md` |

## Capability and deferral ledger

- Public Phase 4 inventory is exactly seven read-only `godot_lsp_*` tools, bringing the current branch inventory to exactly 38 tools.
- Godot 4.6 does not advertise `workspace/symbol`; `godot_lsp_workspace_symbols` returns `feature_disabled`. Per-document symbols are the supported alternative.
- The Phase 4 part of `Q-002` is resolved: Phase 1 is the API prerequisite; completed Phase 2 is a coordination and regression milestone. Phase 6 dependency strength remains open.
- Portable Node APIs cannot make mutable-path authorization and `open()` fully atomic on every platform. Phase 4 narrows the race with canonical pre/post-open validation and same-handle reads; hostile-filesystem atomicity remains deliberately deferred to Phase 6/7.
- Phase 6 broader `FsGuard` and Phase 7 uniform safety/audit/cache hardening remain deferred and are not claimed by Phase 4.

---

## Phase 4 closeout (post-merge residual)

**Status: complete** (2026-07-20)

### Residual code

- `LspHost` returns structured `editor_required` when auto-start is enabled without usable `GODOT_PATH` / `GODOT_PROJECT_PATH` / validated paths (design §10). Previously threw plain `Error`.

### Docs / register

- README: until Phase 7, `GODOT_MCP_MODE` only gates `godot_script_run`.
- Q-001 marked resolved per ADR 0002.
- Phase 4 plan banner: Implemented (historical checkboxes retained).

### Verification gate (local)

| Suite | Result |
|---|---|
| Architecture | PASS (90 pass / 1 skip) |
| Server unit | PASS (318 pass / 4 skip) |
| Typecheck / build / docs:check | PASS |
| Godot smoke | PASS |
| Live phase 1–2, 3, 4 | PASS (Godot 4.6.2 mono console) |

### Explicitly deferred

- System-wide mode for curated mutations → Phase 7
- Mutation lane for lifecycle/persistence/script → Phase 7
- DAP consumer → Phase 5 implementation

---

## Phase 5 design gate

| Artifact | Status |
|---|---|
| [ADR 0003](../../docs/decisions/0003-phase-5-runtime-session.md) | Accepted — Q-010 / Q-011 / Q-012 |
| [Phase 5 design](../../docs/superpowers/specs/2026-07-20-phase-5-runtime-debug-design.md) | Authored |
| [Phase 5 plan](../../docs/superpowers/plans/2026-07-20-phase-5-runtime-debug.md) | Authored (Tasks 1–8) |
| Implementation | Follow-on after this PR |

### Decisions summary

- ProcessRunner sole OS spawn; DAP attach-only via RuntimeSession.
- Godot publishes `sessionId` + `ipcRootAbs`; host never invents `user://`.
- v1 transport = sequenced file IPC only; sockets deferred.
