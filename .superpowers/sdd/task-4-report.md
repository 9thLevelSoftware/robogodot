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
