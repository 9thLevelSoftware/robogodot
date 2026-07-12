# Phase 3 Task 3 report

## Outcome

Implemented five curated scene tools and RPC commands for lifecycle, persistence, current-scene inspection, and deterministic bounded tree traversal. Lifecycle and persistence bypass `EditorUndoRedoManager`; live tests verify save does not add a history entry.

## RED evidence

- `cd server && npm test -- --run tests/phase3-scene-tools.test.ts`
- Result: 3 expected failures, 1 pass. Registrations were absent, dispatch never occurred, and tree structured content was missing. The path safety case passed only because an unknown tool could not dispatch.
- Added `tests/godot/phase_3_scene_smoke.gd`, then ran the real smoke runner.
- Result: expected parse failures for missing `scene_open`, `scene_new`, `scene_save`, `scene_tree`, `scene_current`, and compat wrappers.

## GREEN evidence

- Focused server: 5/5 tests passed (including a separate RED/GREEN cycle for the empty path of a new unsaved scene).
- TypeScript typecheck and build passed.
- Full server suite: 20 files passed, 1 skipped; 165 tests passed, 1 skipped.
- Full real Godot 4.6.2 smoke runner exited 0 and printed `PASS phase 3 scene lifecycle` (along with all prior smoke passes).

## API resolution

The current official EditorInterface documentation identifies `get_unsaved_scenes()`, `close_scene()`, `add_root_node()`, `open_scene_from_path()`, `save_scene()`, and `save_scene_as()`. The supplied 4.6.2 binary does not expose `get_unsaved_scenes` or `get_open_scene_roots` at runtime and does not statically bind `close_scene`/`add_root_node`; the latter two are nevertheless present through the public dynamic method surface and the live new-scene test passes.

All access is behind `godot_compat.gd`. Compat prefers `get_unsaved_scenes()` when available. On the supplied binary it uses public `is_object_edited(root)` for non-MCP edits and explicit lifecycle dirty state for MCP-created new scenes. The smoke test marks the root through `EditorInterface.set_object_edited(root, true)` and verifies unconfirmed discard is rejected. Missing public close/add methods return `ERR_UNAVAILABLE`, producing an actionable command failure rather than pretending success. No private editor API is used.

## Safety and bounds

- Server and Godot both reject noncanonical, absolute, backslash, empty-component, and traversal project paths before persistence/lifecycle work.
- Existing different save targets require `overwrite: true`; saving the current path remains allowed.
- Unsaved open/new requires `discardUnsaved: true`.
- Tree traversal is iterative deterministic preorder, respects depth 1..32, page limit 1..500, numeric cursor offset, and checks the serialized response against 262,144 UTF-8 bytes before adding each node.
- Open/new annotations are lifecycle/non-idempotent and non-destructive; save is destructive/idempotent and explicitly described as non-undoable; current/tree are read-only.

## Concern

Dirty-scene detection is strongest on builds exposing `get_unsaved_scenes()`. The supplied 4.6.2 fallback combines public edited-object state with MCP lifecycle state because the authoritative list method is unavailable. This is tested, but future compatibility testing should retain both API paths.
