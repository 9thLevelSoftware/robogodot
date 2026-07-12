# Phase 4 Final Review Fix Report

Date: 2026-07-12

## Scope and outcome

Implemented only the three final-review findings:

1. `LspDocuments.sync` now binds every `didOpen`, `didChange`, and `didSave` notification to the generation returned by `ensureReady`. If a notification fails and readiness advances, the complete notification transaction is retried on the new generation. Document hash/text/version/generation state is committed only after one complete generation succeeds, so an uncommitted first sync cannot be missed by reconnect replay.
2. `godot_lsp_diagnostics` continues waiting after a causally post-sync empty publication within the original shared wall-clock budget. When the later wait returns only the same cached empty publication, the tool retains the observed fresh publication instead of downgrading it to stale. Pre-sync cache and no-cache timeout behavior remain in `LspDiagnostics` and its tests.
3. `LspHost` installs owned-lifetime listeners before detaching startup listeners, then rechecks startup failure, child identity, and lifetime-listener identity immediately before assigning `owned`. An exit during handoff is recovered as `attached` only after a successful external probe.

## TDD RED evidence

Command:

`cd server; npm test -- --run tests/lsp-documents.test.ts tests/lsp-tools.test.ts tests/lsp-host.test.ts`

Result: exit 1; 3 files failed; 5 tests failed and 45 passed. Expected failures were:

- all three document generation-drop cases used the unbound notification path;
- causal empty diagnostics returned `fresh:false`;
- child exit during listener handoff returned `owned`.

## TDD GREEN and focused verification

Command:

`cd server; npm test -- --run tests/lsp-documents.test.ts tests/lsp-tools.test.ts tests/lsp-host.test.ts tests/lsp-diagnostics.test.ts tests/lsp-session.test.ts`

Result: exit 0; 5 files passed; 87 tests passed.

## Full verification

- `cd server; git diff --check; npm run typecheck; npm run build; npm test -- --run`
  - Exit 0.
  - TypeScript typecheck passed.
  - Build passed.
  - Server suite: 28 files passed, 3 skipped; 306 tests passed, 4 skipped.
- `node docs/architecture/render.mjs --check`
  - Exit 0: `Atlas validation passed`.
- `node --test tests/architecture/*.test.mjs`
  - Exit 0: 90 passed, 1 skipped, 0 failed (91 total).
- `$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; node tests/godot/run-smoke.mjs`
  - Exit 0. All required PASS markers were observed, including Phase 1, transport/auth, variant parity, guarded execution, introspection, Phase 3 editor/node/scene/signal/resource flows, and plugin lifecycle smokes.
  - Godot emitted known Mono SDK/leak/intentional missing-token diagnostics during editor teardown; the smoke runner accepted all exact required PASS markers and exited 0.
- `$env:GODOT_PATH='<configured 4.6.2 console executable>'; $env:GODOT_PROJECT_PATH=(Resolve-Path '..\tests\fixtures\godot_project'); npm run test:live; npm run test:live:phase3; npm run test:live:phase4`
  - Exit 0.
  - Phase 1 live: 1 file, 1 test passed.
  - Phase 3 live: 1 file, 1 test passed.
  - Phase 4 live: 1 file, 2 tests passed.

## Concerns

- No functional concerns remain within the requested scope.
- The exact Godot smoke continues to print environment-specific Mono `.NET SDK 8.0.28` and shutdown leak warnings, but it exits 0 and all fail-closed PASS-marker checks succeed.
