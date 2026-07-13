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
