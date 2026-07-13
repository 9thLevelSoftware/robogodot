# Phase 4 Final Review Fix Report

> Historical Phase 4 evidence follows. The current Phase 5 final-fix evidence is appended below.

Date: 2026-07-12

## Scope and outcome

Implemented only the three final-review findings:

1. `LspDocuments.sync` now binds every `didOpen`, `didChange`, and `didSave` notification to the generation returned by `ensureReady`. If a notification fails and readiness advances, the complete notification transaction is retried on the new generation. Document hash/text/version/generation state is committed only after one complete generation succeeds, so an uncommitted first sync cannot be missed by reconnect replay.
2. `godot_lsp_diagnostics` continues waiting after a causally post-sync empty publication within the original shared wall-clock budget. When the later wait returns only the same cached empty publication, the tool retains the observed fresh publication instead of downgrading it to stale. Pre-sync cache and no-cache timeout behavior remain in `LspDiagnostics` and its tests.
3. `LspHost` installs owned-lifetime listeners before detaching startup listeners, then rechecks startup failure, child identity, and lifetime-listener identity immediately before assigning `owned`. An exit during handoff is recovered as `attached` only after a successful external probe.

## TDD RED evidence

Command:

`cd server; npm test -- --run tests/lsp-documents.test.ts tests/lsp-tools.test.ts tests/lsp-host.test.ts`

Result: exit 1; 3 files failed; 5 tests failed and 45 passed. Expected failures were:

- all three document generation-drop cases used the unbound notification path;
- causal empty diagnostics returned `fresh:false`;
- child exit during listener handoff returned `owned`.

## TDD GREEN and focused verification

Command:

`cd server; npm test -- --run tests/lsp-documents.test.ts tests/lsp-tools.test.ts tests/lsp-host.test.ts tests/lsp-diagnostics.test.ts tests/lsp-session.test.ts`

Result: exit 0; 5 files passed; 87 tests passed.

## Full verification

- `cd server; git diff --check; npm run typecheck; npm run build; npm test -- --run`
  - Exit 0.
  - TypeScript typecheck passed.
  - Build passed.
  - Server suite: 28 files passed, 3 skipped; 306 tests passed, 4 skipped.
- `node docs/architecture/render.mjs --check`
  - Exit 0: `Atlas validation passed`.
- `node --test tests/architecture/*.test.mjs`
  - Exit 0: 90 passed, 1 skipped, 0 failed (91 total).
- `$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; node tests/godot/run-smoke.mjs`
  - Exit 0. All required PASS markers were observed, including Phase 1, transport/auth, variant parity, guarded execution, introspection, Phase 3 editor/node/scene/signal/resource flows, and plugin lifecycle smokes.
  - Godot emitted known Mono SDK/leak/intentional missing-token diagnostics during editor teardown; the smoke runner accepted all exact required PASS markers and exited 0.
- `$env:GODOT_PATH='<configured 4.6.2 console executable>'; $env:GODOT_PROJECT_PATH=(Resolve-Path '..\tests\fixtures\godot_project'); npm run test:live; npm run test:live:phase3; npm run test:live:phase4`
  - Exit 0.
  - Phase 1 live: 1 file, 1 test passed.
  - Phase 3 live: 1 file, 1 test passed.
  - Phase 4 live: 1 file, 2 tests passed.

## Concerns

- No functional concerns remain within the requested scope.
- The exact Godot smoke continues to print environment-specific Mono `.NET SDK 8.0.28` and shutdown leak warnings, but it exits 0 and all fail-closed PASS-marker checks succeed.

## Second final-fix pass (2026-07-12)

### Changes

- Added the named `MAX_SYNC_GENERATION_ATTEMPTS = 4` boundary. A generation that drops on every attempt now terminates as structured `not_connected`; successful one-generation retry behavior is unchanged.
- Diagnostics now creates one monotonic `performance.now()` deadline before document synchronization. Synchronization, the first publication wait, and all later empty-publication waits consume the same budget. The first wait receives only the remaining supported duration; less than the 100 ms store minimum returns structured `timeout` without starting an oversized wait.

### RED evidence

- `npm test -- --run tests/lsp-documents.test.ts tests/lsp-tools.test.ts`
  - The perpetual-flap regression entered the pre-fix unbounded retry loop and the run was terminated, directly reproducing the finding.
  - The delayed-sync regressions demonstrated that the pre-fix handler reset the full `waitMs` after synchronization and could pass an oversized first wait.

### GREEN evidence

- `npm test -- --run tests/lsp-documents.test.ts tests/lsp-tools.test.ts tests/lsp-diagnostics.test.ts tests/lsp-session.test.ts`
  - Exit 0: 4 files, 69 tests passed.
  - Includes all three successful one-retry notification-boundary cases, perpetual-flap bounded failure, delayed-sync timeout, and exact post-sync first-wait remainder.

### Second-pass full verification

- Typecheck and build: exit 0.
- Full server suite: exit 0; 28 files passed, 3 skipped; 309 tests passed, 4 skipped.
- Architecture render check: `Atlas validation passed`.
- Architecture tests: exit 0; 90 passed, 1 skipped, 0 failed.
- Exact configured Godot 4.6.2 smoke runner: exit 0 with all required PASS markers. The previously noted Mono SDK and teardown warning noise remains environmental and non-gating.
- Live Phase 1: exit 0; 1/1 passed.
- Live Phase 3: exit 0; 1/1 passed.
- Live Phase 4: exit 0; 2/2 passed.

---

# Phase 5 Whole-Branch Final-Fix Report

Date: 2026-07-13

## Design adjudications and implemented outcomes

1. Natural exit retains the exact managed process view and its drained ring until explicit `godot_stop_project`. `godot_run_output` returns `running:false`, exit metadata, stable cursors, and final records. Runtime and debug mutations fail closed after exit.
2. Process, bridge, and prepared/bootstrap artifacts are independently owned. A failed close remains attached to the same session, blocks launch, and is retried by the next exact stop/close. Late preparation cleanup is tracked while unresolved and a late failed close is retained rather than swallowed.
3. `godot_debug_launch` accepts at most 32 unique contained initial-breakpoint groups and 500 total lines. Groups are canonicalized and sent before `configurationDone` under the one launch deadline. Success exposes only three negotiated boolean capabilities: configuration-done, terminate, and variable paging. Inventory remains exactly 51 names.
4. DAP stack sources expose only contained normalized `res://` paths; absolute, traversal, accessor, and proxy-shaped remote paths fail closed or are omitted. Name-only sources remain safe.
5. Node file IPC requires `nlink === 1` before publication and before/during/after same-handle response reads. Godot 4.6 GDScript exposes neither portable link count nor descriptor identity, so its consumer uses one bounded `FileAccess` handle, verifies complete stable-length content, removes the pathname before dispatch, and authenticates session/token/filename ID/request ID/monotonic sequence. This preserves authenticated-content integrity and pathname-race safety without claiming unavailable Godot-side hard-link-count proof.
6. README distinguishes page `truncated` (more retained records remain) from `record.truncated` (shortened/invalid-UTF-8 line) and documents terminal retention, cleanup retry, debug launch, and precise file-IPC guarantees.

## RED and root-cause evidence

- Focused pre-fix command: `cd server; npm test -- --run tests/runtime-session.test.ts tests/debug-tools.test.ts tests/dap-client.test.ts tests/runtime-bridge-client.test.ts`
  - Exit 1: natural-exit tests observed eager invalidation/idle, launch schema lacked capabilities, and cleanup tests encoded unconditional ownership clearing.
- The `loseReadyAfterSend` bridge test intermittently reported `readinessWrites=0` only in the parallel four-file run. Root cause was its 25 ms test wall-clock budget expiring before Windows scheduled the mock's multi-turn TCP handshake; the protocol loss point had not occurred. The test-only deadline is now 250 ms (well below production's 3 s), while the synchronized assertion still requires exactly one readiness write. Production deadlines were not changed.

## GREEN and focused verification

- `cd server; npm run typecheck; npm test -- --run tests/runtime-session.test.ts tests/debug-tools.test.ts tests/dap-client.test.ts tests/runtime-bridge-client.test.ts tests/runtime-process-tools.test.ts`
  - Exit 0: typecheck passed; 5 files, 63 tests passed.
- `cd server; 1..3 | % { npm test -- --run tests/runtime-bridge-client.test.ts }`
  - Three consecutive exits 0; 14/14 tests passed in every run.
- Deterministic regressions cover final drain/cursor/later stop, bridge/bootstrap retry and launch blocking, late prepared cleanup failure, breakpoint forwarding/schema/capabilities, hostile source suppression, hard-link rejection, and documentation wording.

## Full verification

- `cd server; npm run typecheck; npm run build; npm test -- --run`
  - Exit 0: 38 files passed, 4 skipped; 439 tests passed, 6 skipped.
- `node docs/architecture/render.mjs --check`
  - Exit 0: Atlas validation passed.
- `node --test tests/architecture/*.test.mjs`
  - Exit 0: 95 passed, 1 external-archive skip.
- `cd server; npm run docs:check`
  - Exit 0: verified 1,065 classes, 24,256 members, 9,697,180 bytes.
- Exact inventory remains 51 through server, stdio, and architecture contract tests.
- Exact configured Godot 4.6.2 aggregate smoke command exited 0 with Phase 5 authenticated bootstrap and locked runtime bridge markers plus all prior markers.
- Exact configured live suites: Phase 1 1/1, Phase 3 1/1, Phase 4 2/2, Phase 5 2/2; all exited 0.

## Concerns

- Godot's GDScript API cannot prove hard-link count. The implemented and documented fallback is authenticated, monotonic, bounded, one-handle consumption with pathname removal before dispatch; Node performs exact link-count checks.
- The configured Mono binary continues to print the known missing .NET SDK 8.0.28 and teardown leak warnings. Required markers and all smoke/live processes exit 0.

## Narrow re-review correction (2026-07-13)

Four re-review findings were corrected without changing the accepted contracts:

- Every debug operation now checks the exact managed process is still running in `getDebug`, closing the pre-monitor-poll mutation window.
- Timed-out preparation tracks both late fulfillment and late rejection. Late fulfillment retains/retries failed artifact cleanup; late rejection clears the pending marker and releases an ownership-free failed session without unhandled rejection.
- Debug-launch normalization requires a capabilities object containing exactly three own data-property booleans. Missing, extra, accessor, proxy, or wrong-typed capability structures fail closed.
- Direct `RuntimeSessionCoordinator.debugLaunch` canonicalizes and forwards initial breakpoint groups into DAP attach, preserving the existing initialize → attach → initialized → breakpoints → configurationDone ordering.

RED: `npm test -- --run tests/runtime-session.test.ts tests/debug-tools.test.ts tests/dap-client.test.ts` exited 1 with five expected failures: late reject remained blocked, direct launch omitted breakpoints, pre-monitor debug reached DAP, and missing/extra capabilities were accepted. The initial regression also exposed eager promise construction in the test as two unhandled rejections; the test now invokes each operation sequentially.

GREEN:

- Focused runtime/debug/DAP: 3 files, 51/51 passed.
- Late fulfillment/rejection race subset: 2/2 passed in three consecutive runs.
- Typecheck/build/full server: exit 0; 38 files passed, 4 skipped; 446 tests passed, 6 skipped.
- Exact configured Phase 5 live: exit 0; 2/2 passed.
