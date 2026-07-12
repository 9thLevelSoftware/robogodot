# Phase 4 Task 5 — TDD Report

## Status

Implemented attach-first, opt-in Godot headless LSP hosting and integrated its independently injectable lifecycle into `runServer`.

## RED evidence

1. Initial focused run:
   - Command: `npm test -- --run tests/config.test.ts tests/lsp-host.test.ts tests/server.test.ts`
   - Result: exit 1; missing `src/lsp/host.ts`, missing `lspAutoStart`, invalid values not rejected, and LSP lifecycle cleanup absent (11 failed tests plus the missing-module suite).
2. Startup cleanup regression:
   - Command: `npm test -- --run tests/lsp-host.test.ts`
   - Result: exit 1; `terminates its exact child when bounded startup fails` observed zero termination calls.
3. Startup deadline regression:
   - Command: `npm test -- --run tests/lsp-host.test.ts`
   - Result: exit 1; bounded-startup assertion observed 301 probes, exceeding the <=30 bound.

## GREEN evidence

- Focused verification: 3 files passed, 40 tests passed.
- Full unit verification: 28 files passed, 2 skipped; 269 tests passed, 2 skipped.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0.
- `git diff --check`: exit 0.

## Implemented behavior

- Strict `GODOT_MCP_LSP_AUTO_START`: only `true`/`1` enable, `false`/`0`/unset disable, all other values use the required exact error.
- Attach probe always precedes spawn. Attached services are never owned or terminated.
- Spawn is shell-free with exact reviewed argv/options and only the exact returned child is tracked.
- Probe/startup and teardown are bounded; stdout/stderr diagnostics retain only the last 16,384 bytes each.
- Child error/exit is detected during startup; service is re-probed to resolve a port race before ownership is assigned.
- Failed startup terminates its exact child; successful owned startup terminates only that child; close/ensure are idempotent.
- Production creates one host/session/client, supplies `ensureAvailable` as `beforeConnect`, injects the client into MCP tools, and attempts bridge/client/host/server shutdown in order while rethrowing the first cleanup error.
- Added the isolated `test:live:phase4` script without adding a live test to the default suite.

## Self-review

No process-name kill, shell invocation, default auto-start, or live-Godot unit dependency was introduced. No later-task files were implemented. Remaining environment concern: the live Phase 4 test file and local Godot validation belong to Task 6 and were intentionally not run here.

## Required fix cycle

### RED evidence

- Added deterministic tests for close racing a delayed attach probe, delayed path validation, and an immediately spawned child; project directories missing a regular `project.godot`; child exit during an awaited successful probe; and startup-listener removal.
- Command: `npm test -- --run tests/lsp-host.test.ts`
- Result: exit 1, 6 failed / 7 passed. Failures showed attached/owned results leaking through close races, spawning after close during validation, missing `project.godot` acceptance, dead-child ownership, and retained listeners.

### GREEN evidence

- Host-only cycle: 13/13 passed; typecheck passed.
- Final focused command: `npm test -- --run tests/lsp-host.test.ts tests/config.test.ts tests/server.test.ts`
  - 3 files passed; 46 tests passed.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0.
- Full suite `npm test -- --run`: 28 files passed, 2 skipped; 275 tests passed, 2 skipped.

### Fixes

- Added explicit `open`/`closing`/`closed` host state and synchronous close gating. Close serializes with in-flight ensure work; later ensure calls reject.
- State is checked after attach probes, path validation, spawn, startup probes, and race re-probes. A close racing spawn terminates only that exact child and cannot publish ownership.
- Production validation requires a regular Godot file (plus executable access on non-Windows), a project directory, and a regular `project.godot` marker before spawn.
- Child failure observed while a successful probe is awaited triggers a fresh probe; an external winner is classified attached and the dead child is never owned.
- Startup error, exit, stdout, and stderr listeners are detached on every decision/error path. Default teardown removes its one-shot exit listener even on timeout/escalation.

## Final lifetime-listener fix cycle

### RED evidence

- Added tests distinguishing startup listeners from owned-lifetime listeners, clearing an exited owned child before attaching an external replacement, and bounded post-readiness/shutdown output capture.
- Command: `npm test -- --run tests/lsp-host.test.ts`
- Result: exit 1, 3 failed / 12 passed. The owned child had no lifetime exit listener, retained stale `owned` state after exit, and captured zero post-readiness output bytes.

### GREEN evidence

- Host cycle: 15/15 passed; typecheck passed.
- Final focused command: `npm test -- --run tests/lsp-host.test.ts tests/server.test.ts`
  - 2 files passed; 23 tests passed.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0.
- Full suite `npm test -- --run`: 28 files passed, 2 skipped; 277 tests passed, 2 skipped.

### Fixes

- Startup listeners are still removed at readiness, then replaced with distinct owned-lifetime exit/stdout/stderr listeners.
- The exact child exit callback clears `ownedChild` and ownership only when the stored identity is still that child, then detaches its lifetime listeners.
- `close()` leaves the lifetime exit/output listeners active during exact-child termination and detaches them after termination completes, without killing an already-exited child or an attached external replacement.
- Output emitted after readiness and during shutdown remains bounded to the final 16,384 bytes per stream.
- Completed ensure promises are cleared, allowing an exited owned child to be followed by a fresh attach probe rather than returning stale ownership.

## Owned-lifetime error-listener fix cycle

### RED evidence

- Added tests emitting `error` after readiness and synchronously from the termination seam.
- Command: `npm test -- --run tests/lsp-host.test.ts`
- Result: exit 1, 2 failed / 15 passed. The owned child had zero error listeners, so both emissions produced unhandled EventEmitter throws and no bounded diagnostics/close result.

### GREEN evidence

- Host cycle: 17/17 passed.
- Final focused command: `npm test -- --run tests/lsp-host.test.ts tests/server.test.ts`
  - 2 files passed; 25 tests passed.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0.
- Full suite `npm test -- --run`: 28 files passed, 2 skipped; 279 tests passed, 2 skipped.

### Fixes

- Owned readiness now installs a lifetime `error` listener alongside exit/stdout/stderr listeners; startup-specific error listeners remain removed.
- Lifetime child errors are retained as the first exact-child failure and appended through the existing 16,384-byte stderr cap.
- Close keeps the error listener installed throughout terminate/kill, attempts termination and listener cleanup, then rejects with the captured child error (or termination error) so outer attempt-all server cleanup remains intact.
- Exact exit and completed close detach error, exit, stdout, and stderr lifetime listeners.
