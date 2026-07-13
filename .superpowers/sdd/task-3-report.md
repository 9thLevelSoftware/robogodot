# Phase 5 Task 3 Report

Status: complete

## Delivered

- Added `RuntimeBootstrap.prepare` / `cleanup` with the authenticated 15-second, 32-KiB RPC bounds.
- Added strict request/response parsing, canonical `.mcp/<session>` containment, regular-file resource verification, symlink/junction denial, exact idempotent cleanup, and partial-write cleanup.
- Kept the runtime token only in a mode-0600, versioned ephemeral JSON config. It is absent from public launch results, logs, child argv, and project settings.
- Added plugin `runtime.prepare`, canonical `user://` storage helpers, fixed manifest resources, and a child-only `SceneTree` launcher with a Task 4 bridge installation seam.
- Added the Phase 5 bootstrap Godot smoke marker without persistent autoload/project changes.

## TDD evidence

- Server RED: focused Vitest failed because `../src/runtime/bootstrap.js` did not exist.
- Server cleanup RED: link-swapped cleanup resolved instead of rejecting; then passed after canonical link denial.
- Server resource RED: an unverified launcher directory was accepted; then passed after canonical regular-file/resource-suffix validation.
- Godot RED: named smoke reached Phase 5 and failed because `commands/runtime.gd` and compatibility methods did not exist.
- Router RED: oversized authenticated method name returned method-not-found instead of invalid-request; then passed after the 128-byte method bound.

## Fresh verification

- `cd server && npm test -- --run tests/runtime-bootstrap.test.ts`: PASS, 12/12 (included in the fresh full run below).
- `cd server && npm test -- --run`: PASS, 33 files passed / 3 skipped; 362 tests passed / 4 skipped.
- `cd server && npm run typecheck`: PASS.
- `cd server && npm run build`: PASS.
- `$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; node tests/godot/run-smoke.mjs`: PASS, including `PASS phase 5 authenticated bridge bootstrap`.
- `git diff --check`: PASS.

## Self-review

- Confirmed no Task 3 edit to `project.godot` and no runtime autoload registration.
- Confirmed no OS-name/platform guessing.
- Confirmed prior authenticated transport and session behavior remains covered by the full server and Godot suites.
- Existing Godot smoke output still includes known Mono SDK/leak diagnostics; the runner exits 0 and the required Phase 5 marker is present.
