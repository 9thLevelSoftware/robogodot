# Phase 5 Task 7 Report

## Status

Implemented the six attach-only public debug tools, integrated the coordinator-owned process/bridge/DAP lifecycle into production startup, raised the exact inventory from 45 to 51, added the deterministic Phase 5 project, and completed the two-flow real-Godot Phase 5 acceptance.

## TDD and implementation evidence

- RED: focused debug-tool/inventory tests failed with zero `godot_debug_*` registrations; coordinator tests failed because launch/delegation did not exist.
- GREEN: the exact six names, strict schemas, annotations, dispatch, containment, stopped references, step enum, and exact 51-name in-memory/stdio inventories pass.
- Coordinator launch owns one deadline, starts only through `ProcessRunner`, connects the runtime bridge, then attaches DAP. Godot's transient `not_running` attach response is retried with fresh attach-only clients inside the same deadline; no DAP path spawns a process.
- Breakpoints accept one canonical contained project-relative `.gd` file and replace its line set. Continue/step delegate to `DapClient`, which invalidates stopped references before exposing request completion. Stack/inspect are copied from own data only and never evaluate expressions.
- Production cleanup attempts editor bridge, runtime coordinator, LSP client, LSP host, and MCP server in order and rethrows the first error.
- The runtime fixture renders 320x180, prints `PHASE5_READY`, exposes `RuntimeTarget.jump_count`, responds to `phase5_jump`, and has local `phase5_value = 42` at the tested breakpoint.

## Real Godot findings

- Godot JSON parses wire numbers as integral floats, so runtime bootstrap validation now accepts only finite exactly-integral int/float values.
- Windows `user://` config paths arrive with backslashes; the launcher normalizes separators before canonical validation.
- `--remote-debug` must precede the script `--` separator or Godot treats it as a user argument.
- Godot 4.6.2 accesses DAP `source.checksums` even though it is optional in DAP. Sending an explicit empty array eliminates the engine error and makes the verified breakpoint stop reliably.
- DAP initially returns `not_running` while the remote debugger finishes registering. Retrying attach inside the original launch deadline yields `debug_ready` without weakening the deadline.

## Verification

- Focused debug/session/server/stdio/live-support: 40/40 passed.
- Fresh server suite with live variables removed: 38 files passed, 4 skipped; 422 tests passed, 6 skipped.
- `npm run typecheck`, `npm run build`, and freshly built stdio inventory: passed; inventory is exactly 51.
- Exact supplied Godot path, Phase 5 command: 2/2 public-MCP flows passed together. Normal flow proves output/tree/property/input/PNG dimensions/hash/containment/stop/artifact and PID cleanup. Debug flow proves attach/breakpoint/stopped stack/local `42`/step/continue/stop.
- Existing live Phase 3: 1/1 passed. Existing live Phase 4: 2/2 passed. Existing live editor acceptance passed on fresh standalone rerun.
- Godot smoke reached and passed the Phase 5 authenticated bootstrap and locked runtime bridge after its action timing was made deterministic. A later unrelated Phase 3 node smoke timed out while pre-existing Godot editor processes were present, so the aggregate smoke command did not finish green in this run.

## Concerns

- The aggregate Godot smoke remains non-green due to the later Phase 3 node timeout described above; the Phase 5 smoke itself passes.
- Mono emits the environment's known missing .NET SDK 8.0.28 warning. The Phase 5 fixture is GDScript-only and all Phase 5 assertions pass despite it.
- Unrelated dirty `.superpowers/sdd/progress.md` and `task-2-report.md` were preserved and are excluded from the Task 7 commit.

## Post-handoff aggregate-smoke resolution

- The controller identified four stale headless Godot smoke processes from July 11 whose command lines targeted this workspace (`phase_1_smoke.gd` and `phase_2_auth_smoke.gd`). Only those exact recorded PIDs and their exact child processes were terminated.
- The unchanged aggregate command was rerun with the exact configured Godot executable and passed with exit code 0 in 122.2 seconds, including Phase 5 bootstrap/runtime markers and all later Phase 3/editor lifecycle smokes.
- The earlier timeout is therefore resolved as stale test-process interference, not a Task 7 regression. The known missing .NET SDK warning remains non-fatal for these GDScript-only fixtures.

## Independent-review fixes

- Root cause: the launch deadline was computed once but only inspected after awaited stages returned. A delayed bootstrap/prepare, `ProcessRunner.start`, bridge connect, or DAP attach could therefore outlive the budget and later publish ownership into an already-failed session. The coordinator now races every stage against the same absolute deadline, adopts resources only from an in-budget result, and attaches late-result cleanup for prepared bootstrap state, exact child process, bridge attachment, and every DAP client. The direct debug-launch path uses the same bounded start/attach behavior.
- RED command: `cd server; npm test -- --run tests/runtime-session.test.ts tests/live-support.test.ts`. Before implementation, delayed prepare/start/connect cases each hit Vitest's 5000 ms test timeout and the setup cleanup test failed with `acquireWithCleanup is not a function` (4 failures). A separate direct-attach RED command, `npm test -- --run tests/runtime-session.test.ts -t "direct debug launch"`, also hit the 5000 ms timeout.
- GREEN command: `cd server; npm test -- --run tests/runtime-session.test.ts tests/live-support.test.ts` passed 2 files, 34/34 tests. Fake-timer cases deterministically prove timeout at prepare, start, connect, integrated DAP attach, and direct DAP attach, then resolve each abandoned promise and assert exact late cleanup plus idle coordinator state.
- Live Phase 5 now rereads the returned screenshot path with Node filesystem APIs, verifies the PNG signature and `IHDR`, parses exact 320x180 dimensions, compares exact byte count, recomputes SHA-256 for equality, and proves canonical equality/containment of both returned relative and absolute paths beneath the exact `.mcp/<sessionId>` artifact root.
- Live harness acquisition now pre-registers reverse-order cleanup before environment mutation, bridge start/poll, or MCP connection awaits. Client, server, runtime, editor bridge, and exact environment restoration are independently attempted after setup failure. The deterministic setup-failure test proves order `client, server, runtime, bridge, env`, preserves the setup error, tolerates cleanup errors, and restores absence versus value exactly.

### Fresh verification after review fixes

- Focused debug/session/server/stdio/live-support: `cd server; npm test -- --run tests/runtime-session.test.ts tests/live-support.test.ts tests/debug-tools.test.ts tests/server.test.ts tests/mcp-stdio.test.ts` passed 5 files, 47/47 tests on the final rerun.
- Full server suite without live environment variables: `cd server; Remove-Item Env:GODOT_PATH -ErrorAction SilentlyContinue; Remove-Item Env:GODOT_PROJECT_PATH -ErrorAction SilentlyContinue; npm test -- --run` passed 38 files with 4 skipped, 428 tests with 6 skipped, exit 0 in 77.51 s.
- Fresh compilation and exact inventory: `cd server; npm run typecheck; npm run build; npm test -- --run tests/server.test.ts tests/mcp-stdio.test.ts` passed typecheck/build and 10/10 tests. Both in-memory and freshly built stdio assertions compare the complete ordered inventory of exactly 51 tool names.
- Exact Phase 5 command with `GODOT_PATH=C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe` and resolved fixture `GODOT_PROJECT_PATH`: `cd server; npm run test:live:phase5` passed 1 file, 2/2 public-MCP flows, exit 0 in 12.42 s.
- Aggregate command with the same exact Godot executable: `node tests/godot/run-smoke.mjs` exited 0 in 60.2 s, including `PASS phase 5 authenticated bridge bootstrap` and `PASS phase 5 locked runtime bridge` plus all later smokes. The environment's known missing .NET SDK 8.0.28 warning and intentional negative-fixture diagnostics remain non-fatal.
