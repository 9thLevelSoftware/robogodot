# Task 6 report: live Godot 4.6 editor and owned-host acceptance

## Status

Implemented and verified. The live Phase 4 suite passes against the exact supplied Godot 4.6.2 Mono console executable, and the full server regression/typecheck/build pass.

## Commands and outputs

### TDD red/green support tests

`cd server; npm test -- --run tests/live-support.test.ts`

- RED: 3 failures (`allocateLoopbackPort is not a function`; `waitForProcessExit is not a function`).
- GREEN: 1 file passed, 10 tests passed. After exact-PID polling coverage was added: 11 support tests pass as part of the full suite.

`cd server; npm test -- --run tests/lsp-diagnostics.test.ts tests/lsp-tools.test.ts`

- RED: missing diagnostic URI remap and disconnected native-symbol returned `feature_disabled` instead of `not_connected`.
- GREEN: targeted diagnostics/tools regressions pass in the subsequent 81-test targeted run.

`cd server; npm test -- --run tests/lsp-session.test.ts -t "serverInfo is omitted"`

- RED: expected native-symbol support `true`, received `false`.
- GREEN: Godot 4.6 capability-shape fallback added and included in passing targeted/full runs.

### Live debugging runs

All live commands used:

`$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; $env:GODOT_PROJECT_PATH=(Resolve-Path '..\tests\fixtures\godot_project'); npm run test:live:phase4`

Observed red sequence and root causes:

1. Diagnostics timed out because Godot parsed the invalid workspace fixture before synchronization and did not republish on the first open.
2. Unavailable native-symbol returned `feature_disabled` because capability gating happened before session readiness.
3. Owned startup timed out after about 1.7 seconds because immediate connection refusals made the nominal 15-second attempt loop elapse too quickly.
4. Godot's initialize response omitted `serverInfo`; its exact capability payload had document symbols enabled, workspace symbols disabled, and completion trigger characters including `.` and `$`.
5. Godot emitted diagnostics URIs as `file:///C%3A/...`, while Node canonicalized the same path as `file:///C:/...`.
6. Godot first published empty diagnostics, then the undeclared-identifier diagnostic; the public tool now waits within the same caller budget for the later publication.
7. Godot completion labels are display labels such as `queue_free()`; public normalization now exposes the symbol label `queue_free` while preserving insert text.
8. Godot document symbols are hierarchical; the live assertion recursively consumes the public hierarchy to check `phase4_sum`.
9. Windows signal termination did not reliably reap the Godot console child. The owned host now falls back to exact spawned PID tree termination (`taskkill /pid <pid> /t /f`), never a process-name search, and acceptance condition-polls that PID until absent.

Final live output:

```
Test Files  1 passed (1)
Tests       2 passed (2)
Duration    10.28s (fresh final run; an earlier passing run was 9.81s)
Exit code   0
```

### Targeted regression

`cd server; npm run typecheck; npm test -- --run tests/lsp-host.test.ts tests/lsp-documents.test.ts tests/lsp-session.test.ts tests/lsp-diagnostics.test.ts tests/lsp-tools.test.ts tests/live-support.test.ts`

Output before the final small URI/completion additions: typecheck exit 0; 6 files passed; 81 tests passed. All additions are covered by the final full run below.

### Final full verification

`cd server; npm test -- --run; npm run typecheck; npm run build`

```
Test Files  28 passed | 3 skipped (31)
Tests       290 passed | 4 skipped (294)
typecheck   exit 0
build       exit 0
```

The skips are the existing environment-gated live/archive suites. The explicitly enabled Phase 4 live suite was run separately and passed fail-closed.

## Godot quirks / environment notes

- The supplied Mono editor logs `.NET Sdk not found. The required version is '8.0.28'.` This does not prevent GDScript LSP acceptance.
- The fixture project references the RoboGodot editor addon but the fixture directory does not include it, so Godot logs that the addon directory was not found and disables it. This does not affect the standalone Godot LSP.
- The fixture is temporarily made valid before launch, synchronized through public MCP, then restored to its exact required invalid contents to deterministically force a valid-to-invalid diagnostic publication. A `finally` restores the required fixture bytes on every test exit.
- No fixed readiness sleeps or process-name kills are used. Polling is bounded and condition-driven; ports are OS-assigned.

## Self-review

- CI preserves the pinned download/checksum behavior and adds `GODOT_PROJECT_PATH` plus the fail-closed Phase 4 invocation without `continue-on-error`.
- Public MCP is used for every acceptance assertion.
- Unavailable hints include exact allocated `--lsp-port` and `--path` arguments.
- Owned teardown observes the exact child PID captured from the production host spawn.
- `git diff --check` passed (only Git's local LF-to-CRLF warnings were printed).

## Follow-up hardening

After review, native-symbol capability detection was tightened and teardown paths were hardened further.

- Captured the exact serverInfo-omitted Godot initialize result. It contains only generic LSP capabilities and no affirmative Godot-specific extension field.
- Removed the generic capability-shape heuristic. When explicit `serverInfo` does not identify Godot 4.6, initialization now makes a bounded request to Godot's proprietary `textDocument/nativeSymbol` method and enables the capability only after a valid bounded object/array response.
- Added an impostor test with the identical generic capability shape whose proprietary request returns method-not-found; native symbols remain disabled.
- Wrapped owned-host calls/assertions in `try/finally`, always closes the owned harness, condition-checks its exact PID, and retains the primary failure while appending a cleanup failure.
- Visible editor cleanup now escalates on Windows from bounded signal waiting to exact-PID `taskkill /pid <pid> /t /f`, followed by exact-PID liveness polling.
- Production taskkill now has finite timeout handling, synchronous/spawn-error handling, nonzero-exit handling, listener/timer cleanup, and no process-name lookup. Tests cover spawn error, stalled child, and synchronous exit during listener registration.

Focused command:

`cd server; npm test -- --run tests/live-support.test.ts tests/lsp-session.test.ts tests/lsp-host.test.ts`

```
Test Files  3 passed (3)
Tests       50 passed (50)
Exit code   0
```

Real live command (same exact `GODOT_PATH` and fixture `GODOT_PROJECT_PATH` shown above):

```
Test Files  1 passed (1)
Tests       2 passed (2)
Duration    12.29s
Exit code   0
```

Full verification before the final timer-race test:

```
Test Files  28 passed | 3 skipped (31)
Tests       293 passed | 4 skipped (297)
typecheck   exit 0
build       exit 0
```

Fresh final combined verification after all changes:

`$env:GODOT_PATH='<exact supplied executable>'; $env:GODOT_PROJECT_PATH=(Resolve-Path '..\tests\fixtures\godot_project'); npm run test:live:phase4; npm test -- --run; npm run typecheck; npm run build`

```
Phase 4 live: 1 file passed, 2 tests passed, duration 8.73s
Full suite:   31 files passed, 298 tests passed (live environment enabled, so no skips)
typecheck:    exit 0
build:        exit 0
overall:      exit 0
```
