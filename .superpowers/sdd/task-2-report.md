# Phase 3 Task 2 report

## RED

Command:

`cd server && npm test -- --run tests/phase3-node-tools.test.ts`

Observed: exit 1; 1 failed file, 4 failed tests. Tool listing returned no node tools, bridge dispatch count was zero, and unknown tools had no normalized structured error. This was the expected missing-feature failure.

Real Godot integration RED:

`$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; node tests/godot/run-smoke.mjs`

Observed: exit 1 after prior smokes passed. `commands/edit.gd` failed compilation on inferred return types, so the eight edit commands could not register and the Task 2 smoke timed out. This was corrected with explicit `Dictionary`/`Variant` types before the GREEN run.

## GREEN and implementation

- `server/src/tools/node.ts`: registers exactly eight public node tools, strict inputs, UTF-8 byte bounds, annotations, curated response validation, mutation-lane invalidations, and the exact three-method/zero-argument read-only allowlist.
- `server/src/server.ts`: installs the node slice with a shared `MutationLane`.
- `addons/godot_control_mcp/commands/edit.gd`: canonical edited-scene path resolution, live property descriptors, Variant parsing/serialization, compact stale-tree hints, ownership, and eight RPC handlers.
- `addons/godot_control_mcp/edit_controller.gd`: inverse operations for delete, reparent, and duplicate in addition to the approved add/rename/property foundation.
- `addons/godot_control_mcp/plugin.gd`: registers the eight `edit.node_*` methods.
- `server/tests/phase3-node-tools.test.ts`: public MCP names, strict schemas, annotations, mapping, UTF-8 rejection, unsafe method rejection, and malformed response normalization.
- `tests/godot/phase_3_node_smoke.gd` and `tests/fixtures/godot_project/phase3/node_fixture.tscn`: real editor add/undo/redo, initial property, rename, Variant property set, duplicate, reparent, delete, stale path, and prototype-like property coverage.
- `tests/godot/run-smoke.mjs`: includes the Task 2 editor smoke.
- Updated earlier exact tool-list assertions to account for the new public slice.

## Verification

Focused command:

`cd server && npm test -- --run tests/phase3-node-tools.test.ts tests/type-parser.test.ts && npm run typecheck && npm run build`

Observed: 2 files passed, 42 tests passed; typecheck and build exited 0.

Full server suite:

`cd server && npm test -- --run`

Observed: 19 files passed, 1 skipped; 156 tests passed, 1 skipped; exit 0.

Real Godot:

`$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; node tests/godot/run-smoke.mjs`

Observed: exit 0, including `PASS phase 3 edit controller foundation`, `PASS phase 3 undoable node tools`, and all prior/lifecycle smoke pass markers.

## Self-review

- Scope is limited to the eight Task 2 tools; scene instancing and later-phase APIs were not added.
- Read-only methods are exactly `get_path`, `get_child_count`, and `is_inside_tree`, and the public schema requires an empty argument tuple.
- Mutation calls are serialized and invalidate scene plus affected-node tags; reads bypass the lane.
- Live property lookup uses own Godot metadata iteration, so prototype-like JavaScript keys are not privileged.
- Removed/duplicated subtrees are retained through UndoRedo references; reparent snapshots original parent/index/owner/global transform.

## Concerns

- The Mono editor reports a missing .NET 8.0.28 SDK and renderer/object leak warnings on shutdown; these are environment noise already present in the suite and do not affect exit status.
- Later lifecycle scans can report a pre-existing global script-class cache collision (`GodotMCPTypeParse hides a global script class`) after repeatedly copying the addon in one runner invocation. The isolated Task 2 editor smoke compiles and passes, and the runner exits 0.

## Review remediation RED/GREEN

RED command:

`cd server && npm test -- --run tests/phase3-node-tools.test.ts`

Observed: exit 1; 2 failed, 4 passed. A 256-byte property name was rejected before dispatch (expected one call, received zero), and `NaN` was dispatched (expected two calls, received three). These failures directly demonstrated the incorrect 255-byte property bound and permissive `z.unknown()` Variant input.

Godot integration RED:

`$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; node tests/godot/run-smoke.mjs`

Observed: exit 1 in the expanded node smoke. Canonical comparison initially used the editor-internal scene-tree path rather than the external `/root/<edited-scene>` namespace, causing valid add/rename operations to fail. `_path` was corrected to canonicalize relative to the edited scene root.

GREEN focused server command:

`cd server && npm test -- --run tests/phase3-node-tools.test.ts tests/type-parser.test.ts && npm run typecheck && npm run build`

Observed: exit 0; 2 files passed, 46 tests passed; typecheck and build passed.

GREEN full server command:

`cd server && npm test -- --run`

Observed: exit 0; 19 files passed, 1 skipped; 160 tests passed, 1 skipped.

GREEN focused Godot command used a clean fixture addon copy and fresh port with `phase_3_node_smoke.gd`.

Observed: exit 0 with `PASS phase 3 undoable node tools`. The smoke asserts exact forward/history/undo/redo behavior for add, rename, property, duplicate, reparent, and delete; subtree/owner/index/global-transform restoration; invalid primitive and object property types; invalid initial properties; traversal rejection; and bounded hierarchical stale hints.

GREEN full Godot command:

`$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; $env:GODOT_MCP_SMOKE_PORT='19223'; node tests/godot/run-smoke.mjs`

Observed: exit 0 in 29.4 seconds, including all prior pass markers and `PASS phase 3 undoable node tools`.

Review implementation notes:

- Shared `variantLiteralSchema = z.json()` now rejects non-JSON/cyclic/non-finite inputs before bridge dispatch while accepting Phase 2 typed JSON representations and literal strings.
- Property and method names have independent 256-byte schemas; node names remain 255 bytes.
- Each RPC has an exact strict response schema and plugin results no longer contain redundant inner `ok` fields.
- All parsed properties are checked against the live descriptor type and object class before any undo action is created.
- External paths require exact canonical resolution; stale hints contain a bounded hierarchy (64 nodes, 2048 characters).
- New EditorInterface version-sensitive access is isolated in `godot_compat.gd`.

## Final focused test hardening

Server command:

`cd server && npm test -- --run tests/phase3-node-tools.test.ts`

Observed: exit 0; 1 file passed, 8 tests passed. The registration test now compares all four annotation fields for every mutation and read node tool.

Expanded focused Godot RED used a clean fixture copy, fresh port 19224, and `phase_3_node_smoke.gd`.

Observed: exit 1. The new assertions reported `redo add restores initial property and owner` and `undo delete restores explicit recursive owners`, proving the undo actions did not preserve recursive ownership. The controller was corrected to register recursive do-owner properties for add/duplicate and snapshot/register recursive undo-owner properties for delete before committing the action.

Focused Godot GREEN repeated the clean-fixture command with port 19225.

Observed: exit 0 in 7.7 seconds with `PASS phase 3 undoable node tools`. Delete undo restored the target at its original sibling index with child/grandchild hierarchy, distinct stored positions, and explicit owners; redo removed the retained whole subtree. Add redo restored `Vector2(10, 20)` and the edited-scene owner.

Full bounded Godot command:

`$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; $env:GODOT_MCP_SMOKE_PORT='19226'; node tests/godot/run-smoke.mjs`

Observed: exit 0 in 27.9 seconds, including `PASS phase 3 edit controller foundation`, `PASS phase 3 undoable node tools`, and all bounded runner pass markers.
