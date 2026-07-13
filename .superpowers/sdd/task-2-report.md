# Phase 5 Task 2 Report

## Status

Implemented the single-session runtime coordinator and exactly three public process MCP tools. No later Phase 5 task was implemented.

Commit: `bc3291673ebaacb5e5a887a6a2548dd4899b1912` (`feat: add runtime session process tools`).

## TDD evidence

- RED coordinator: `npm test -- --run tests/runtime-session.test.ts` failed because `../src/runtime/session.js` did not exist (0 tests collected, exit 1).
- GREEN coordinator: the focused coordinator suite passed 4/4.
- RED process tools: `npm test -- --run tests/runtime-process-tools.test.ts` failed 3/3 because the three tools were absent.
- GREEN process tools and integration: the required focused command passed 17/17 across 4 files.

## Final verification (fresh)

Run from `server`:

1. `npm test -- --run tests/runtime-session.test.ts tests/runtime-process-tools.test.ts tests/server.test.ts tests/mcp-stdio.test.ts`
   - Exit 0; 4 files passed; 17 tests passed.
2. `npm run typecheck`
   - Exit 0; `tsc --noEmit` reported no errors.
3. `npm run build`
   - Exit 0; `tsc` reported no errors.
4. `npm test -- --run`
   - Exit 0; 32 files passed, 3 skipped; 343 tests passed, 4 skipped.

## Self-review

- Session IDs are 128-bit random hex values; the 256-bit runtime token is stored only in coordinator ownership and injected into child environment, never snapshots/tool results.
- Launch conflicts and stale IDs fail closed. Natural exit invalidates the session.
- Failed start cleanup uses `ProcessRunner.stopCurrent()` so the coordinator never guesses child ownership.
- Teardown attempts DAP, bridge, then exact process, preserves the first failure, clears credentials/handles, and returns the coordinator to idle.
- Tool schemas are strict and enforce contained `res://` scenes, 32 arguments, 1,024 UTF-8 bytes per argument, 8,192 total UTF-8 bytes, safe nonnegative cursors, and limits 1-500.
- The disconnected default returns the stable standard `not_connected` structured error independently of editor/LSP availability.

## Concerns

- Bridge and DAP are intentionally lifecycle-only injected seams in this task; authentication/bootstrap and protocol clients belong to later tasks.
- Runtime tool output schemas are exact success schemas with an explicit registry opt-in for the standard structured error envelope.

## Review fixes

Follow-up fixes were implemented test-first:

Fix commit: `130213b44dde0420297391a7299f6fedd1121e4b` (`fix: harden runtime session teardown`).

- RED: 4 new regressions failed for repeated stop retention, asynchronous natural-exit cleanup/racing stop, attached-channel failed-start cleanup, and hostile runtime DTO leakage.
- GREEN: focused runtime suites passed 11/11 after implementation.
- A first full verification found the error-compatible registry wrapper was too broad and regressed LSP/registry tests; it was restricted to explicitly opted-in runtime tools.

Final fresh verification from `server`:

1. `npm test -- --run tests/runtime-session.test.ts tests/runtime-process-tools.test.ts tests/server.test.ts tests/mcp-stdio.test.ts`
   - Exit 0; 4 files passed; 21 tests passed.
2. `npm run typecheck`
   - Exit 0.
3. `npm run build`
   - Exit 0.
4. `npm test -- --run`
   - Exit 0; 32 files passed, 3 skipped; 347 tests passed, 4 skipped.

Review outcomes:

- One last terminal stop result is retained and keyed by session ID; a new launch replaces it and unrelated stale IDs remain invalid.
- Natural exit is monitored asynchronously and shares one teardown promise with explicit stop, closing DAP then bridge then exact process without unhandled rejection.
- Failed launch closes any starting-state DAP/bridge seams in order, preserves the launch error first in an aggregate, and retains failed ownership when `stopCurrent()` is unconfirmed.
- Runtime tools define exact success DTO schemas and opt into standard-error compatibility in the registry without affecting other tools.
- DTO normalization reads only own data descriptors and explicitly copies reviewed fields, dropping child IDs, secrets, inherited values, accessors, and extras. Text content is the JSON serialization of structured content.

Remaining concern: natural-exit observation is a short unref'ed polling monitor because the reviewed `ManagedProcess` interface intentionally exposes state but no exit subscription seam.

## Second review-fix pass

This pass was also test-first:

Fix commit: `5b3fdefa3eca873e478dc34e2c416ff45cdd5f86` (`fix: retain unconfirmed runtime ownership`).

- RED: new tests showed normal-stop and close failures cleared unconfirmed exact-child ownership, and the registry compatibility wrapper removed required fields from advertised success schemas.
- GREEN: unconfirmed teardown now always retains the owned session in retryable `failed` state, blocks launch, keeps/restarts natural-exit monitoring when a managed process remains, and retries the same child ID.
- Launch `bridgeTransport` is now explicitly optional in the session/tool contract and is validated only when present.
- The global compatible-output flatten/refinement was removed. Runtime tools advertise exact success DTO schemas with required fields and no error fields; standard structured `isError` responses continue through the registry error path.

Fresh verification:

1. `npm test -- --run tests/runtime-session.test.ts tests/runtime-process-tools.test.ts tests/registry.test.ts tests/server.test.ts tests/mcp-stdio.test.ts`
   - Exit 0; 5 files passed; 29 tests passed.
2. `npm run typecheck`
   - Exit 0.
3. `npm run build`
   - Exit 0.
4. `npm test -- --run`
   - Exit 0; 32 files passed, 3 skipped; 350 tests passed, 4 skipped.

SDK note: the MCP SDK client validates any structured error against a cached success schema after `listTools`; the error-path test therefore calls the disconnected tool without first populating that client-side cache. The server/registry response remains structured with `isError: true` and does not add fake success fields.

## Third review-fix pass — NEEDS_CONTEXT

No implementation or commit was made because the pinned MCP SDK (`@modelcontextprotocol/sdk` 1.29.0) cannot directly accept the required structural Zod union as a tool output schema.

TDD RED evidence:

- A same-client regression (`connect -> listTools -> call disconnected runtime tool`) fails because the client validates structured `isError` content against the cached strict success schema.
- A registry regression requiring an `anyOf` with separate strict success and strict `{code,message,hint[,data]}` branches also fails with the current exact-object registry behavior.

Pinned-SDK inspection and direct probe:

- The public `AnySchema` TypeScript type includes arbitrary Zod schemas, including `ZodUnion`.
- Runtime `normalizeObjectSchema` in `dist/esm/server/zod-compat.js` accepts only a root Zod object or raw object shape and returns `undefined` for a union.
- Directly registering `z.union([strictSuccess, strictError])` causes `tools/list` to omit `outputSchema` entirely.
- Calling that directly registered tool then returns `isError: true` with `Cannot read properties of undefined (reading '_zod')`.

The requested fallback instruction was therefore followed: schema flattening, optional-field weakening, and fake success fields were not introduced. Resolution requires either an SDK upgrade/fix that supports object-union output schemas end-to-end, or authorization for a lower-level/custom MCP registration path outside the reviewed registry abstraction.

## Approved SDK-compatible error policy

The user approved resolving the pinned-SDK limitation by keeping exact success output schemas and omitting `structuredContent` only for error results. The registry error path now returns:

Fix commit: `3c77ac365c59c4c85ea46310328072d27354d9b2` (`fix: make tool errors schema compatible`).

- `isError: true`;
- one JSON text content item containing exactly `{code,message,hint,data?}`;
- no `structuredContent`, preventing clients from validating an error payload against a cached success schema.

Success results are unchanged and still return identical JSON text plus structured content.

TDD evidence:

- RED: same-client `connect -> listTools -> callTool` regressions failed for disconnected runtime, invalid runtime service output, and representative core errors because the client validated structured errors against cached exact success schemas.
- GREEN: the focused registry/errors/runtime/session/core/server/stdio set passed 40/40 after the minimal global `toToolError` change and contract assertion updates.
- All existing error assertions, including skipped live Phase 4 assertions, were updated to parse the stable JSON text payload and verify structured content is absent where relevant.

Fresh final verification:

1. `npm test -- --run tests/registry.test.ts tests/errors.test.ts tests/runtime-session.test.ts tests/runtime-process-tools.test.ts tests/core-tools.test.ts tests/server.test.ts tests/mcp-stdio.test.ts`
   - Exit 0; 7 files passed; 40 tests passed.
2. `npm test -- --run`
   - Exit 0; 32 files passed, 3 skipped; 350 tests passed, 4 skipped.
3. `npm run typecheck`
   - Exit 0.
4. `npm run build`
   - Exit 0.

Exact success schemas remain strict and unchanged; no permissive schema, union flattening, or fake success fields were added.

Final post-commit rerun note: the combined focused command initially hit the stdio test's 3-second response timeout under parallel load (no malformed frame or assertion mismatch). `tests/mcp-stdio.test.ts` immediately passed 2/2 in isolation, followed by clean typecheck, build, and full 350/350 non-skipped tests.
