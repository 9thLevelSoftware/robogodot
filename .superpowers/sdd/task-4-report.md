# Phase 5 Task 4 Report

Status: complete

## Delivered

- Added a versioned, token-authenticated loopback TCP bridge using bounded length-prefixed JSON frames and an atomic same-session file fallback.
- Added immutable per-client transport selection, monotonic safe IDs, 32-request concurrency limits, five-second maximum deadlines, stale/wrong-session/duplicate response rejection, close cancellation, and plain JSON output normalization.
- Added sequential main-thread GDScript dispatch for the exact `runtime.scene_tree`, `runtime.get_node`, `runtime.input`, and `runtime.screenshot` methods.
- Added scene depth/node/property bounds, JSON-safe property forms, bounded input validation, contained PNG publication and response bounds, plus exact bridge-artifact cleanup.
- Extended only the launcher injection seam; no project configuration or autoload was edited.

## TDD evidence

- RED: `cd server && npm test -- --run tests/runtime-bridge-client.test.ts` failed because `bridge-client.js` did not exist.
- GREEN: the focused suite passed 4/4 after implementing framing, negotiation, socket/file transport behavior and the mock runtime.
- Full-suite regression RED: all assertions passed but Vitest reported two unhandled `ENOENT` poller races from overlapping mock file ticks.
- GREEN: serialized mock polling removed the cleanup race; the fresh full suite completed with no unhandled errors.
- Godot smoke exercises the depth and input bounds and forces compilation of all injected bridge scripts; the complete named runner includes both Phase 5 markers.

## Fresh verification

- `cd server && npm test -- --run tests/runtime-bridge-client.test.ts`: PASS, 4/4.
- `cd server && npm test -- --run --hookTimeout=30000`: PASS, 34 files passed / 3 skipped; 368 tests passed / 4 skipped.
- `cd server && npm run typecheck`: PASS.
- `cd server && npm run build`: PASS.
- `$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; node tests/godot/run-smoke.mjs`: PASS, including `PASS phase 5 authenticated bridge bootstrap` and `PASS phase 5 locked runtime bridge`.
- `git diff --check`: PASS.

## Self-review and concerns

- Tokens remain confined to the ephemeral config and authenticated wire/file requests; no token is returned by public APIs or emitted by bridge diagnostics.
- Socket binding is explicitly `127.0.0.1`; socket selection is authenticated before requests and file selection occurs only when that pre-request handshake fails.
- Requests are never replayed across transports after publication.
- Known environment noise remains the existing Mono SDK/leak diagnostics in editor smokes; the bounded runner exited 0 and found no forbidden script/compile diagnostics for the new smoke.
- Portable file publication uses same-directory rename. As elsewhere in the phase, filesystem pathname operations are not handle-relative and cannot eliminate every cross-platform replacement race.
