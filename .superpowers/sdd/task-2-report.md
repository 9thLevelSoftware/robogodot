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
