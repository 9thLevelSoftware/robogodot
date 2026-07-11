# Phase 2 Task 2 Report

## Status

DONE. The real-Godot parity gate exits 0 and is included in the bounded Godot smoke orchestrator.

## Canonical shapes

The committed-intent shared fixture `tests/fixtures/variant-vectors.json` defines `$type` tagged JSON shapes:

- `{"$type":"Vector2","x":number,"y":number}`
- `{"$type":"Vector3","x":number,"y":number,"z":number}`
- `{"$type":"Color","r":number,"g":number,"b":number,"a":number}`
- `{"$type":"NodePath","path":string}`
- `{"$type":"Rect2","x":number,"y":number,"width":number,"height":number}`

Godot 4.6 semantics were chosen: `#RRGGBBAA` treats the last byte as alpha. Color serialization rounds channels to seven decimal places to make Godot's float32 Color storage and TypeScript byte-semantically equal; `0x80` alpha is canonically `0.5019608`. JSON numbers do not promise integer/float Variant preservation across runtimes.

## TDD evidence

RED TypeScript:

`npx vitest run tests/type-parser.test.ts`

Failed before production code existed with `Cannot find module '../src/util/type-parser.js'` and zero tests collected.

RED Godot:

`Godot_v4.6.2-stable_mono_win64_console.exe --headless --path . --script tests/godot/variant_parity_smoke.gd`

Failed before production code existed with `Preload file res://addons/godot_control_mcp/util/type_parse.gd does not exist`.

GREEN TypeScript:

`npx vitest run tests/type-parser.test.ts`

Result: 1 file passed, 26 tests passed.

Baseline server suite (before Task 2): without a token, six Task 1 tests fail because `GODOT_MCP_TOKEN` is required. With `GODOT_MCP_TOKEN=0123456789abcdef0123456789abcdef`: 10 files passed, 1 skipped; 75 tests passed, 1 skipped.

## Blocker evidence

After implementation, two real-Godot parity invocations emitted no stdout or stderr and did not exit. One was allowed to exceed 30 seconds. Each left both the console wrapper and engine child alive:

- first run: PIDs 8536 (console), 6444 (engine), start 14:19:46
- second run: PIDs 15448 (console), 17368 (engine), start 14:20:33

The four processes were terminated explicitly. `--version` on the same executable returned normally as `4.6.2.stable.mono.official.71f334935`. No `.godot` diagnostic files were produced in the worktree. Per task-owner direction, work stopped rather than weakening or bypassing the real-Godot shared-vector gate.

## Root cause and fix

A bounded rerun with stdout/stderr redirected exposed the output that the prior unbounded interactive runs had hidden. Godot 4.6.2 failed to compile `type_parse.gd` because three `:=` locals in `parse_variant_literal` were derived from a `Variant`, so GDScript could not infer their types (`text`, `hex`, and `open`). The parity script's `_init()` then attempted to call `parse_variant_literal` on the failed preload and the SceneTree process remained alive rather than reaching its final `quit()`.

The minimal parser fix adds explicit `String`, `String`, and `int` annotations to those three locals. No parser behavior or parity expectation was weakened. `tests/godot/run-smoke.mjs` now runs the parity smoke and applies a 30-second timeout that terminates the full Windows process tree before reporting the failed invocation.

RED evidence (bounded at 5 seconds): timeout with GDScript parse errors at `type_parse.gd:130`, `:133`, and `:138`, followed by `Nonexistent function 'parse_variant_literal'`; the process tree was killed.

GREEN evidence using the same executable and invocation after the type annotations: exit 0 with `variant parity smoke: 15 valid, 10 invalid`.

Final verification:

- `node tests/godot/run-smoke.mjs`: exit 0; Phase 1, Phase 2 auth, variant parity, missing-token, and editor lifecycle smokes passed.
- `npm test -- --run`: 12 files passed; 102 tests passed (including all 26 parser tests).
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0.
- `git diff --check`: exit 0 (line-ending conversion warning only).

## Review hardening

The follow-up review added identical traversal limits in both runtimes: maximum depth 32 with the root at depth 0, and maximum 10,000 visited nodes/elements. Parse overflow is `invalid_args`. Serialization uses path-scoped container identity tracking so cycles become canonical `UnknownVariant` descriptions while repeated noncyclic references remain ordinary values; depth and node overflow are also described rather than recursed into.

The shared fixture now covers 17 valid and 17 invalid vectors, including escaped NodePaths, numeric grammar, exact tagged fields, and nonfinite values. Focused generated tests cover exact depth/node boundaries and overflow, prototype-sensitive dictionary keys, Array/Dictionary cycles, repeated references, Object/Node/Resource descriptions, and unsupported Variant fallback.

Process supervision was extracted to `tests/godot/process-runner.mjs`. Windows cleanup uses `taskkill /T` with its own five-second deadline and preserves the original timeout on taskkill error/hang. Unix children start in a dedicated process group and timeout cleanup signals only that negative group PID.

Review RED evidence:

- `npx vitest run tests/type-parser.test.ts`: 2 failures; missing depth rejection and `RangeError: Maximum call stack size exceeded` on a cyclic Array.
- Real Godot parity after the first new tests: rejected malformed number grammar incorrectly and could not produce a Node path while running in constructor-time `_init()`.
- Process-runner race test: expected the original timeout but received `Godot exited with code 1` when tree termination emitted child exit before cleanup completed.

Review GREEN evidence:

- `npx vitest run tests/type-parser.test.ts`: 38 tests passed.
- Real Godot parity: exit 0; 17 valid and 17 invalid shared vectors plus runtime serializer checks passed.
- `node --test tests/godot/process-runner.test.mjs`: 4 tests passed.
- `node tests/godot/run-smoke.mjs`: all five Godot smokes passed.
- Full server: 12 files passed; 114 tests passed.
- `npm run typecheck`, `npm run build`, and `git diff --check`: exit 0.

## Concerns

Godot logs expected warnings while rejecting non-finite exponent fixtures, and the Mono editor smokes report the environment's missing .NET SDK plus existing shutdown RID-leak diagnostics. All smoke processes still exit 0, and neither warning affects the parity result.
