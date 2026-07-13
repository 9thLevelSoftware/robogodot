# Task 6 Report — Bounded attach-only DAP client

## Outcome

Implemented and committed the bounded attach-only DAP transport/client beneath the existing runtime coordinator layers. `DapClient` has no spawn or process-runner dependency; it accepts coordinator-owned loopback endpoint, runtime session, process, and optional bridge metadata. `ProcessRunner` remains the sole OS process owner, and the coordinator's existing DAP-before-bridge-before-process cleanup ordering is unchanged.

Commit: `fde1537 feat: add attach-only Godot DAP client`

## Files committed

- `server/src/runtime/dap-transport.ts`
- `server/src/runtime/dap-client.ts`
- `server/tests/mock-dap.ts`
- `server/tests/dap-transport.test.ts`
- `server/tests/dap-client.test.ts`

Pre-existing dirty changes in `.superpowers/sdd/progress.md` and `.superpowers/sdd/task-2-report.md` were preserved, not edited, and not staged. This report was written after the scoped Task 6 commit and is not part of that commit.

## TDD evidence and exact commands

All commands ran from `C:\Users\dasbl\Documents\RoboGodot\.worktrees\codex-phase-5\server` unless noted.

1. RED transport:
   - `npm test -- --run tests/dap-transport.test.ts`
   - Result: exit 1; suite could not import missing `../src/runtime/dap-transport.js`. This was the expected missing-feature failure.
2. First transport GREEN/debug cycle:
   - `npm test -- --run tests/dap-transport.test.ts`
   - Result: exit 1; 8 passed, 2 failed. Root causes were test fixtures: a 10 ms default expired during mock polling, and `maxBufferBytes: 64` violated the intended `frame <= buffer` option invariant.
   - Fixture-only corrections were made, then the same command returned exit 0; 10/10 passed.
3. RED client:
   - `npm test -- --run tests/dap-client.test.ts`
   - Result: exit 1; suite could not import missing `../src/runtime/dap-client.js`. This was the expected missing-feature failure.
4. Client debug cycles:
   - `npm test -- --run tests/dap-client.test.ts`
   - Initial result: exit 1; 3 passed, 5 failed, with four late rejection reports. Root causes: capability checks occurred after readiness checks; resume state rejected stale handles as disconnected; and the initialized-event waiter lacked an immediate rejection observer.
   - `npm test -- --run tests/dap-transport.test.ts tests/dap-client.test.ts`
   - Intermediate result: assertions passed but exit 1 because one initialized-event timeout was handled too late. An immediate cleanup observer fixed the lifecycle leak.
   - Rerun result: exit 0; 18/18 passed.
5. Additional RED lifecycle/binding tests:
   - `npm test -- --run tests/dap-client.test.ts`
   - Result: exit 1; 7 passed, 2 failed, proving thread handles lacked generation-bound references and cancelled attach incorrectly published degraded state.
   - After minimal fixes, `npm test -- --run tests/dap-transport.test.ts tests/dap-client.test.ts` returned exit 0; 19/19 passed.
6. Coordinator close RED:
   - `npm test -- --run tests/dap-client.test.ts -t "uses the DAP disconnect handshake"`
   - Result: exit 1; expected `disconnect`, observed prior `configurationDone`, proving `close()` destroyed the socket without the required live-session DAP handshake.
   - After the lifecycle fix, focused DAP verification returned exit 0; 20/20 passed.

## Final fresh verification

The following chained commands ran after the last implementation/refactor change:

```powershell
npm test -- --run tests/dap-transport.test.ts tests/dap-client.test.ts
npm run typecheck
npm run build
npm test -- --run
```

Results:

- Focused DAP tests: exit 0; 2 files passed, 20/20 tests passed.
- Typecheck: exit 0; `tsc --noEmit` produced no errors.
- Build: exit 0; `tsc` produced no errors.
- Full server suite: exit 0; 37 files passed and 3 skipped; 405 tests passed and 4 skipped out of 409.
- `git diff --cached --check`: exit 0 before commit.
- Scoped staged stat: exactly five Task 6 files, 372 insertions.
- Commit command from the worktree root: `git commit -m "feat: add attach-only Godot DAP client"`; exit 0, commit `fde1537`.

## Design decisions

- DAP framing is independent of LSP: separate buffer, monotonic numeric request sequence, pending map, event listeners, and no JSON-RPC/generation reuse.
- Transport defaults are the approved 1 MiB frame, 2 MiB buffer, 128 pending requests, and 5-second request deadline. Input and envelope violations fail closed, reject pending requests, clear timers, detach socket listeners, and destroy the socket.
- Attach uses only an injected/default TCP socket factory and coordinator-provided metadata. No spawn, child-process, `ProcessRunner`, terminate-tree, or launch request exists in the DAP implementation.
- Lifecycle ordering is `initialize` response, `attach` response, `initialized` event, initial `setBreakpoints`, then capability-gated `configurationDone`.
- One shared attach deadline covers connection and configuration. Mid-attach `close()` cancels attachment, destroys any late socket, and remains disconnected rather than publishing degradation.
- Live coordinator `close()` performs the DAP `disconnect` request before closing transport; attach cancellation and exited cleanup close immediately. Resume commands invalidate stopped references before request completion is exposed.
- Threads, frames, scopes, and variable references carry `{ runtimeSessionId, stoppedGeneration, id }`. Stale or cross-session handles return `invalid_args`.
- Read bounds are 64 threads, 256 frames, 64 scopes, 500 variables per page, and 8,192 UTF-8 bytes for names/values/types. Long UTF-8 fields use bounded logarithmic prefix selection.
- `inspect` sends only `scopes` and `variables`; tests assert that no `evaluate` request is emitted.
- Capability gates return `feature_disabled` for configuration completion, terminate, and nonzero variable paging when the adapter does not advertise support.
- DAP failure retains coordinator-owned process/bridge metadata and exposes explicit `process_plus_bridge` degradation metadata without claiming debug readiness.

## Self-review

- Confirmed production DAP files contain no `spawn`, `child_process`, `ProcessRunner`, `evaluate`, LSP, or JSON-RPC dependency.
- Confirmed the mock records zero spawn calls and tests assert attach-only behavior.
- Confirmed malformed JSON, missing/duplicate/negative/oversized content length, fragmented/coalesced frames, UTF-8 length, out-of-order responses, pending limits, request deadlines, response errors, listener isolation, close rejection, and separate DAP identifiers are covered.
- Confirmed initialization/configuration order, capability failures, attach timeout, cancellation, graceful disconnect, events/exit, degradation, stopped-handle invalidation, pagination/count caps, and no-evaluate inspection are covered.
- Confirmed the commit contains exactly the five requested Task 6 code/test files.

## Concerns

None. Integration of this client into public Phase 5 debug tools/coordinator launch wiring is intentionally left to the later plan task that consumes `DapClient`; Task 6 only provides the approved attach-only layer.

## Review correction wave — 2026-07-13

The Task 6 review findings were addressed without changing Task 7/tools or the runtime coordinator/process ownership layers.

### RED evidence

From `C:\Users\dasbl\Documents\RoboGodot\.worktrees\codex-phase-5\server`:

```powershell
npm test -- --run tests/dap-transport.test.ts tests/dap-client.test.ts
```

Initial review-regression result: exit 1; 2 files failed; 21 tests passed and 10 failed out of 31, with two unhandled-rejection reports caused by failing-test cleanup. The failures reproduced the reviewed gaps: never-settling socket acquisition did not cancel, late sockets were not destroyed, public breakpoints were admitted while attaching, initialized waiter listener remained, stale threads/stackTrace/scopes/variables responses were normalized with the new generation, and transport subscriber sets remained populated. The sequence-exhaustion RED also exposed a mock-only overflow because its synthetic response sequence added 10,000 to `Number.MAX_SAFE_INTEGER`; that fixture was corrected to use a valid independent response sequence. The concurrent-breakpoint RED originally awaited the incorrectly admitted request, so it was corrected to assert wire ordering without blocking on the defect.

### GREEN/debug evidence

```powershell
npm test -- --run tests/dap-transport.test.ts tests/dap-client.test.ts
```

Result after the correction wave: exit 0; 2 files passed; 31/31 tests passed.

```powershell
npm run typecheck
```

First result: exit 1 with two `TS2322` cleanup-callback inference errors in `dap-client.ts`. Root cause: callbacks initialized as `() => undefined` were inferred more narrowly than replacement `() => void` listener removers. Both cleanup variables were explicitly typed `() => void`.

```powershell
npm run typecheck; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm test -- --run tests/dap-transport.test.ts tests/dap-client.test.ts
```

Result: exit 0; typecheck clean and focused DAP tests 31/31 passed.

After self-review tightened socket ownership across a synchronously consumed deadline and moved stopped-token checks literally before response-body parsing, the final focused/typecheck command was rerun:

```powershell
npm test -- --run tests/dap-transport.test.ts tests/dap-client.test.ts; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm run typecheck
```

Result: exit 0; 2 focused files passed, 31/31 tests passed, and `tsc --noEmit` completed without errors.

### Final build and regression evidence

```powershell
npm run build; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm test -- --run
```

Result: exit 0. Build (`tsc`) completed without errors. Full server suite: 37 files passed and 3 skipped; 416 tests passed and 4 skipped out of 420.

### Review fixes and self-review

- Socket acquisition now receives an `AbortSignal`, races an owned abort path, rejects attach immediately on close, and retains a settlement handler that destroys any socket delivered after close or timeout. The default TCP factory also destroys its in-progress socket on abort.
- The initialized-event waiter now owns an explicit cancel operation that clears its timer and listener on initialize/attach failure or close.
- Public `setBreakpoints` now requires `ready` or `stopped`; attach-only initial breakpoint configuration continues through its private ordering path.
- `threads`, `stackTrace`, `scopes`, and `variables` capture the stopped generation before sending and validate state/generation immediately after each await, before parsing or normalizing the returned body. References are created only with the captured generation.
- Transport failure/close snapshots the one-shot close subscribers, clears event/closed listener sets and pending timers, then isolates each close callback. Repeated close cannot notify again.
- Deterministic tests now cover last safe sequence/exhaustion, late response after timeout, duplicate responses, and isolation from subsequent requests.
- `ProcessRunner` remains the sole process owner; no spawn, Task 7, tool-registration, or coordinator lifecycle changes were introduced.

Review-wave concerns: none.
