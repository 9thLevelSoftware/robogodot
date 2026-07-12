# Phase 3 Task 5 report

## Status

Implemented resource handles and exactly restorable project settings from approved head `40397b44f0f064e3a4dfb505e832fa89b1bbcf02`.

## RED

- Server: `cd server && npm test -- --run tests/phase3-resource-project-tools.test.ts` failed with 4 expected failures because the six tool registrations/modules did not exist (the malformed-payload loop was vacuously green while the tool was absent).
- Godot: the targeted editor smoke failed to parse because `resource_handles.gd`, resource/project RPCs, the persistence wrapper, and `set_project_setting` did not exist.
- During GREEN, the full server suite exposed the expected stale stdio tool-list assertion (176 passed, 1 failed); its required six-name expectation was updated.

## GREEN

- Targeted server test: 5/5 passed.
- Full server suite: 177 passed, 1 skipped; typecheck and build both exited 0.
- Targeted Godot editor smoke: exited 0 and printed `PASS phase 3 resource project`.
- Full `node tests/godot/run-smoke.mjs`: exited 0 and included the Task 5 PASS marker.

## Implementation

- `server/src/tools/resource.ts`: three exact bounded curated resource tools, opaque handle schema, canonical path validation, explicit overwrite, and non-Ctrl-Z persistence annotation.
- `server/src/tools/project.ts`: get/set/list schemas, safe own-property keys, canonical pagination, exact response validation, and shared FIFO mutation lane for setting set.
- `addons/godot_control_mcp/resource_handles.gd`: session-static Resource-only dictionary with 128-bit `Crypto` randomness encoded as 22-character base64url tokens; standard `Object.get()` is backed by `_get`; clear is called on plugin entry and exit.
- `commands/edit.gd`, `edit_controller.gd`, `godot_compat.gd`, and `plugin.gd`: six RPCs, ClassDB Resource validation, canonical saves, stable sorted setting pages, persistence wrapper, and one ProjectSettings-context UndoRedo action.
- Setting mutations preflight both the requested value and exact prior value/absence with persistence before history creation. Undo of absence passes null; do and undo both save and verify existence/value.
- Smoke preserves and restores the fixture `project.godot` bytes after exercising real persistence.

## Files

- Created: `server/src/tools/resource.ts`, `server/src/tools/project.ts`, `server/tests/phase3-resource-project-tools.test.ts`, `addons/godot_control_mcp/resource_handles.gd`, `tests/godot/phase_3_resource_project_smoke.gd`.
- Modified: `server/src/server.ts`, `server/tests/mcp-stdio.test.ts`, `addons/godot_control_mcp/commands/edit.gd`, `addons/godot_control_mcp/edit_controller.gd`, `addons/godot_control_mcp/godot_compat.gd`, `addons/godot_control_mcp/plugin.gd`, `tests/godot/run-smoke.mjs`.

## Self-review and concerns

- Corrected the GDScript `Object.get` collision by using `_get`, retaining the required public `handles.get(handle)` shape.
- Corrected fixture mutation by restoring exact original `project.godot` bytes in the smoke.
- No Task 5 correctness blocker found.
- Environment concern: Godot Mono reports a missing `.NET SDK 8.0.28` and known headless RID/ObjectDB leak diagnostics; the named targeted and full smoke commands still exit 0. The existing lifecycle tail also emits expected/error-path plugin diagnostics and pre-existing fixture compile noise while its runner exits 0.

## Review-fix RED/GREEN (follow-up)

- RED command: `$env:GODOT_MCP_TOKEN='0123456789abcdef0123456789abcdef'; Godot --headless --editor --path tests/fixtures/godot_project --script tests/godot/phase_3_resource_project_smoke.gd`.
- RED result: parse failures for missing `exact_variant.gd`, injected random/persistence seams, and bounded descriptor helper. First implementation run then exposed two genuine assertion failures in negative-zero semantics and the mutable injected-save fixture; both were corrected and rerun.
- Focused GREEN server: `cd server && npm test -- --run tests/phase3-resource-project-tools.test.ts` — 5/5 passed.
- Focused GREEN Godot: the editor command above — exit 0 with `PASS phase 3 resource project`.
- Full server: `cd server && npm test -- --run && npm run typecheck && npm run build` — 177 passed, 1 skipped; typecheck/build exit 0.
- Full Godot: `$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; node tests/godot/run-smoke.mjs` — exit 0.
- Added one recursive exact comparator, exact resource post-set checking, bounded 20,000-setting scan, injected collision/exhaustion and persistence-failure tests, three-attempt rollback recovery, blocked fail-safe with explicit recovery data/history, Tier B guidance, and `ConfigFile` disk readback after do/undo.
- Scope decisions: symlink/junction containment remains deferred to Phase 6/7 `FsGuard`; atomic no-replace resource publication is unavailable through the current public Godot API and remains the accepted narrow external overwrite TOCTOU risk for Task 6 documentation.
- Float definition: non-finite floats are unsupported; Godot normalizes negative-zero Variant values, so exact comparison follows that normalized equality.

## Final lifecycle/lifetime test follow-up

- Lifecycle RED: the first focused editor run attempted public `EditorInterface.set_plugin_enabled`, but the addon registry is not populated for this `--script` fixture, so Godot rejected the boundary and both invalidation assertions failed.
- Lifecycle GREEN: the isolated focused fixture instantiates the actual `plugin.gd` `EditorPlugin`, adds/removes/re-adds it to the live tree (real `_enter_tree`/`_exit_tree` callbacks), and proves handles created before first entry, before exit, and before re-entry are invalidated. The final removal/free stops the listener and prevents port conflicts.
- Controller lifetime GREEN: an accepted setting action is created by a helper-local temporary `EditController`; after the helper returns, undo/redo are invoked directly through ProjectSettings' compat history. Exact in-memory values and `ConfigFile` on-disk values are verified in both directions, proving the history retains the callback receiver.
- Focused command: `$env:GODOT_MCP_TOKEN='0123456789abcdef0123456789abcdef'; Godot --headless --editor --path tests/fixtures/godot_project --script tests/godot/phase_3_resource_project_smoke.gd` — exit 0, `PASS phase 3 resource project`.
- Full command: `$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; node tests/godot/run-smoke.mjs` — exit 0; the runner required and observed `PASS phase 3 resource project`.
