# Phase 4 Task 4 Report

## Status

Implemented the seven bounded public MCP LSP tools and registered them unconditionally, bringing the exact public inventory to 38. The tools use a structural `LspToolClient`, remain independent of editor WebSocket status, strictly gate negotiated capabilities, issue only the specified LSP requests, and return `not_connected` through the standalone fallback.

## TDD evidence

### RED 1 — public inventory and tool contracts

Command:

`cd server && npm test -- --run tests/lsp-tools.test.ts tests/server.test.ts tests/mcp-stdio.test.ts`

Observed: exit 1; 6 failures. The new inventory tests reported 31 instead of 38, the LSP inventory was empty, and calls reported each `godot_lsp_*` tool as absent. This was the expected failure caused by the missing production registration and implementation.

### GREEN 1 — seven public tools

After the minimal implementation and disconnected fallback, the focused suite passed except for the fallback returning `feature_disabled`. Changing the disconnected client's capability check to raise its dedicated `not_connected` error produced a clean focused pass and a clean typecheck.

### RED 2 — nested range bounds

Command:

`cd server && npm test -- --run tests/lsp-tools.test.ts`

Observed: exit 1; 1 failure. A hover response containing line `1_000_001` and a nonnumeric line was returned instead of omitted. This proved the nested remote-range bound was not enforced.

### GREEN 2 — nested range bounds

Added strict remote-position normalization (integer, zero through 1,000,000) and omitted invalid ranges. The focused public verification then passed: 3 files, 14 tests.

## Verification

- Focused/public: `npm test -- --run tests/lsp-tools.test.ts tests/server.test.ts tests/mcp-stdio.test.ts` — 3 files passed, 14 tests passed.
- Full server suite: `npm test -- --run` — 27 files passed, 2 skipped; 240 tests passed, 2 skipped.
- Typecheck: `npm run typecheck` — passed.
- Build: `npm run build` — passed.
- Patch hygiene: `git diff --check` — passed.

The first full-suite run exposed one pre-existing Phase 3 inventory assertion that selected the last six tools. It was updated to select the six resource/project tools by their stable prefixes; the subsequent full suite passed.

## Self-review

- Confirmed all seven descriptions explicitly exclude rename, formatting, and code actions.
- Confirmed exact annotations are read-only, non-destructive, idempotent, and closed-world.
- Confirmed workspace symbols are never synthesized and `workspace/symbol` is not called when capability-gated.
- Confirmed native lookup sends exactly `{ native_class, symbol_name }` and maps `null` to `found: false`.
- Confirmed inputs, nested collections, recursion depth/node counts, positions, and normalized strings are bounded.

## Concerns

None. The two skipped tests are the repository's existing opt-in live tests.

## Review-fix TDD evidence

### RED 3 — strict normalization and honest truncation

Added focused regressions for signature parameter-label unions and truncation flags, malformed completion entries and invalid text edits, getter/inherited-property rejection across completion/symbol/hover/native paths, and diagnostic omission metadata with the public position ceiling.

Command: `cd server && npm test -- --run tests/lsp-tools.test.ts tests/lsp-diagnostics.test.ts`

Observed: exit 1; 5 failures. Signature output retained arbitrary parameter labels without truncation metadata; completion silently omitted malformed entries and emitted an invalid edit; accessor-backed data executed a throwing getter; diagnostics lacked omission metadata and retained an out-of-public-range position.

### GREEN 3 — descriptor-safe bounded results

Implemented own-data-descriptor reads throughout arbitrary LSP result normalization. Inherited properties and accessors are rejected without executing getters. Completion now declares malformed/accessor/limit omissions and emits text edits only with both a valid range and bounded new text. Native malformed non-null payloads now return `godot_error`.

Signature help now accepts parameter labels only as bounded strings or exact bounded integer pairs, caps signatures and parameters at 64, bounds documentation, and reports signature/parameter/malformed/string truncation separately. A subsequent RED test proved oversized parameter documentation was not setting the string flag; the focused test failed with `strings: false`, then passed after descriptor-safe source-byte accounting was added. A final RED test used a hostile property-descriptor proxy and failed with `godot_error`; guarded descriptor inspection now fails closed as a declared omission without propagating the trap.

Diagnostics snapshots now carry aggregate `truncated` plus category flags for diagnostic count, tags, related information, strings, positions, and malformed entries. The public tool propagates those flags, positions are capped at 1,000,000, and diagnostic arrays/properties use descriptor-safe reads.

### Review-fix verification

- Focused public and diagnostics: `npm test -- --run tests/lsp-tools.test.ts tests/server.test.ts tests/mcp-stdio.test.ts tests/lsp-diagnostics.test.ts` — 4 files passed, 31 tests passed.
- Typecheck: `npm run typecheck` — passed.
- Build: `npm run build` — passed.
- Full server suite: `npm test -- --run` — 27 files passed, 2 skipped; 246 tests passed, 2 skipped.
- Patch hygiene: `git diff --check` — passed.

Review-fix concerns: none. The two skipped tests remain the repository's opt-in live tests.
