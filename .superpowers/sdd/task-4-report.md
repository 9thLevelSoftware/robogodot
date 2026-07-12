# Phase 3 Task 4 report

## Result

Implemented undoable canonical PackedScene instancing and exactly three signal tools: bounded deterministic listing, connect, and disconnect. Mutations share the server FIFO `MutationLane`; Godot validates live sources/signals/targets/methods before creating history actions. Disconnect snapshots and restores the exact `Callable` flags.

## TDD evidence

- Server RED: `npm test -- --run tests/phase3-signal-instance-tools.test.ts` failed 3/4 because all four registrations and RPC mappings were absent.
- Server GREEN: focused suite passes 4/4.
- Godot RED: real Godot 4.6.2 smoke failed on nonexistent `EditController.instance_scene` before production implementation.
- Godot GREEN: real smoke prints `PASS phase 3 signal instance`; assertions cover owner/scene identity, one-action instance undo/redo, exact callable and flags, and unchanged history for duplicate/missing operations.

## Verification

- Full server: 21 files passed, 1 skipped; 170 tests passed, 1 skipped.
- TypeScript typecheck: passed.
- TypeScript build: passed.
- Full `tests/godot/run-smoke.mjs`: exit 0, including the new signal/instance smoke. The existing Godot editor run remains noisy with expected .NET SDK/editor cache/leak diagnostics.
- GDScript `--check-only` for modified command/controller scripts: passed.

## Design notes

- PackedScene loading accepts only canonical `res://` paths and rejects non-scenes.
- Instancing retains `scene_file_path`, assigns the instanced root to the edited-scene owner, and preserves nested scene ownership.
- Signal list sorts signal descriptors and connection records, caps args/connections/page size, limits cursor skip, and enforces the response envelope.
- Connect/disconnect validate the exact live signal and callable before `create_action`; invalid, duplicate, and missing operations cannot alter history.

## Review-fix RED/GREEN evidence

- RED: focused server suite failed three assertions: disconnect injected `flags: 0`, connect accepted mask bit 16, and the exact list response rejected missing `connectionCount`/`connectionsTruncated` support.
- GREEN: focused server suite passes 6/6. Connect accepts only safe integer flags 0..15; disconnect has no flags field/default and rejects extras before dispatch.
- Real Godot GREEN: the focused smoke covers inherited and script-declared signals, typed argument metadata, page-by-page cursor progression, invalid/end cursors, multibyte names, and 260 deliberately unordered eligible connections plus an out-of-scene connection. It verifies filter → stable sort → first-256 cap, `connectionCount: 260`, and truncation metadata.
- A real regression exposed that Godot can emit compile diagnostics yet exit 0. `run-smoke.mjs` now requires the named `PASS phase 3 signal instance` output marker; a process-runner test proves a misleading successful exit without the marker is rejected.
- Review-fix verification: focused server 6/6; full server 172 passed and 1 skipped; typecheck/build passed; focused Godot printed the named PASS marker; full Godot runner passed with the marker enforced.
