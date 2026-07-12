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

## Comprehensive fix pass RED/GREEN evidence

RED server run: `npm test -- --run tests/phase3-scene-tools.test.ts` produced 3 expected failures: the 1024-byte multibyte boundary/canonical cursor contract was absent, the old recursive tree schema rejected flat parent/depth records, and lifecycle responses lacked structured state/reason. After implementation the focused result is 6/6 passing.

The first live fix run failed on conservative state expectations and save verification. The supplied 4.6.2 artifact does not expose `get_unsaved_scenes`; the implementation now treats absence of authoritative evidence as `unknown`, with a reason, and requires `discardUnsaved:true`. `is_object_edited` is traversed across the entire edited subtree and may establish dirty state but never cleanliness. Live coverage edits a child directly and confirms both unknown and dirty states reject unconfirmed replacement.

The next live RED exposed that headless `save_scene_as` leaves the public edited-object flag set. Save-as now first verifies canonical `scene_file_path` and a fresh reload as `PackedScene`, then clears the public edited flag and rechecks it before clearing lifecycle bookkeeping or returning success. Invalid destinations, unconfirmed existing targets, confirmed pre-existing overwrite, and reload are exercised. Save uses the returned `Error` and requires `OK`. Target existence is rechecked immediately in the command before save; an unavoidable residual OS race remains between that check and Godot's write.

Tree traversal is now streaming iterative preorder with a 100,000-record skip ceiling. Records are unique flat `{name,class,path,parent?,depth,children}` values where children are canonical paths. A canonical decimal cursor advances by records emitted. A 512-byte conservative JSON-RPC envelope reserve covers `{jsonrpc,id,result}` including the 128-byte maximum request id; result construction is capped at 261,632 UTF-8 bytes, and a single record that cannot fit fails rather than returning the same cursor. A live 500-node multibyte wide tree verifies the complete router response stays at most 262,144 bytes, every truncated page advances, and concatenated pages contain all 503 records without duplicates or skips.

Lifecycle history validation uses per-result scene histories: open/new/reopen assert the resulting scene history has no undo action. Save, save-as, and confirmed overwrite compare the same live scene history version before/after and assert invariance. This avoids comparing histories belonging to freed/replaced roots.

Direct Godot compatibility tests accept an exact 1024-byte multibyte canonical `res://` path and reject the over-boundary value. Server tests enforce the same byte boundary and reject noncanonical decimal cursors without bridge dispatch. Corrupt existing scenes are preflighted as `PackedScene` and rejected before editor switching.

## Router-envelope and traversal follow-up

RED added to `phase_1_smoke.gd`: a successful command returned 140,000 multibyte characters under a valid 128-byte maximally JSON-escaped control-character ID. Before the central router guard, the complete serialized JSON-RPC response exceeded 262,144 bytes. GREEN: `command_router.gd` now serializes the exact complete response with the actual ID and replaces an oversized success with a bounded structured error carrying the same ID. Error construction is also measured and reduced to a bounded fallback; the accepted 128-byte ID ceiling makes the same-ID fallback safely fit. The smoke test asserts same ID and complete response size.

Tree preorder now uses only depth-proportional frames `{node,next_child_index,depth}`. It advances via `get_child_count()` and one `get_child(index)` at a time, never `get_children()` and never a pushed sibling set. A live wide-tree invariant requests cursor 1/limit 1 and asserts the internal visit count is exactly two (the skipped root and requested first child), demonstrating traversal does not visit/store the remaining 499 wide siblings. Stable order, cursor progress, and concatenated-page coverage remain green.

The overwrite TOCTOU limitation is narrowed to the unavoidable interval after the immediate target-existence revalidation and before Godot performs its write. Atomic filesystem replacement is intentionally outside Task 3 scope.

## Capped child-path record follow-up

The tree record contract now includes `childCount` and `childrenTruncated`, and `children` is explicitly capped at 64 canonical child paths. Record construction calls `get_child(index)` at most `min(childCount, 64)` times; traversal still uses its separate depth-proportional frame state to cover every node. The live wide-root cursor 0/limit 1 test has 502 children and asserts exactly 64 paths, `childCount == 502`, `childrenTruncated == true`, and an internal child-reference materialization count of 64. Existing concatenated-page checks still prove all 503 nodes appear once without gaps, so the preview cap does not alter traversal completeness or cursor semantics. The exact TypeScript response schema enforces the metadata and 64-entry maximum.
