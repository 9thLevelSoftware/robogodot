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

## Security hardening follow-up

- Launcher argv paths are rejected before open/delete unless they are the exact canonical `user://.mcp/<32hex>/bridge-config-v1.json` shape with link-free root/session/config components. Invalid external files are left untouched.
- Launcher config validation now binds the JSON session ID to its parent directory, rechecks file size/mtime and link status before consumption, and canonicalizes scenes through `globalize_path`/`localize_path` before requiring and loading a `PackedScene`.
- Every successful `runtime.prepare` is tracked as owned by the current authenticated transport lifecycle. Disconnect and plugin exit attempt cleanup for every exact owned session and clear ownership without crossing sessions.
- Server config publication now uses an exclusive bounded temporary file, same-handle write, fsync, mode tightening, close, and an atomic no-replace hard-link publication followed by temp unlink. Collision and failure paths do not overwrite an existing final config and remove temporary artifacts.
- Server recursive cleanup now snapshots only link-free canonical entries, records filesystem identity, and revalidates root containment and entry identity immediately before each unlink/rmdir. Plugin cleanup similarly preflights links and repeats path/link plus available size/mtime checks before each removal.

### Follow-up TDD and verification

- RED: nested-session junction cleanup resolved; config collision removed a pre-existing final; injected partial publication was not routed through the new seam; external launcher invocation deleted its invalid file; owned-session lifecycle APIs were absent.
- GREEN: focused bootstrap suite PASS, 14/14.
- Fresh full server suite PASS: 33 files passed / 3 skipped; 364 tests passed / 4 skipped.
- Fresh TypeScript typecheck and build PASS.
- Fresh named Godot smoke PASS with `PASS phase 5 authenticated bridge bootstrap`; the external config invocation was rejected and the file remained byte-for-byte unchanged.

### Portable residual risk

Filesystem pathname validation and removal remain multi-step operations. Node identity revalidation substantially narrows swaps but cannot make the full recursive pathname walk atomic across all supported platforms. Godot exposes link and file metadata checks but not portable directory-handle-relative unlink or stable inode handles; its size/mtime identity check is weaker. Windows mode `0600` is not an ACL guarantee, so the secret remains protected primarily by the user-owned canonical session directory. A native handle-relative/ACL implementation should be considered in Phase 6/7; this report does not claim the portable race is eliminated.
