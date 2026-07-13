# Phase 5 Task 5 Report

Status: complete

## Files changed

- `server/src/tools/runtime.ts`: added the four strict public MCP schemas, annotations, dispatch, and descriptor-only success normalization.
- `server/src/runtime/session.ts`: attached request-capable runtime bridges to active sessions; added scene, node, input, and verified screenshot operations; preserved bridge-before-process teardown.
- `server/tests/runtime-bridge-tools.test.ts`: added in-memory public MCP coverage for inventory, annotations, bounds, union exclusivity, exact output/error behavior, stale sessions, bridge absence, session dispatch, and PNG verification.
- `server/tests/server.test.ts`: advanced the exact intermediate inventory from 41 to 45.
- `server/tests/mcp-stdio.test.ts`: advanced the freshly built stdio inventory to 45.

`server/src/server.ts` required no textual edit: Task 2 had already centralized all runtime registration through `registerRuntimeTools`, so adding the four registrations after the existing process registrations in that function exposes them in the required order.

## Design choices

- Public bridge session IDs are non-empty and bounded to 128 UTF-8 bytes; NodePaths to 1,024 bytes; property/action names to 256 bytes; depth to 1–32; hold duration to 0–2,000 ms; property lists to 64; scene results to 1,000 nodes; screenshots to 16 MiB.
- Input uses one strict discriminated shape at a time: named action, explicit key, or explicit mouse button. Cross-variant fields are rejected before dispatch.
- Scene output declares node and depth truncation independently. Node property output declares every requested property omitted by the allowlisted bridge or by safe JSON normalization.
- Public normalization reads only own data descriptors, catches proxy traps, rejects accessors/cycles/non-finite values, and copies results into fresh/frozen plain data. Bridge tokens, child handles, inherited fields, and mutable internal values are never returned.
- Screenshot acceptance resolves the canonical session root and candidate, rejects root/file links and non-regular files, enforces containment and 16 MiB size, opens and reads the same file handle with stable identity/size/mtime checks, verifies PNG signature/IHDR dimensions and bridge claims, then returns normalized logical/canonical paths and a host-computed SHA-256.
- Bridge loss and deadlines map to stable `not_connected`/`timeout` errors; malformed bridge data and capture failures map to stable `godot_error`. MCP failures use `isError: true`, JSON text `{code,message,hint,data?}`, and no `structuredContent` through the accepted registry policy.
- Coordinator stop/failed-launch cleanup closes and invalidates DAP then bridge (including screenshot-root authority) before terminating the exact owned process.

## TDD evidence

- RED: `cd server && npm test -- --run tests/runtime-bridge-tools.test.ts tests/server.test.ts` failed 5 tests because all four tools were absent and inventory remained 41.
- GREEN: the same focused command passed after registration and implementation. An added coordinator-backed test initially failed with `Cannot read properties of undefined (reading 'getBridge')`, exposing an unbound service-method bug; binding operations to their service owner made it pass.
- Refactor/hardening kept the suite green while replacing array iteration and object reads with guarded own-descriptor copies and collapsing filesystem/proxy failures to stable public errors.

## Exact verification

- `cd server && npm test -- --run tests/runtime-bridge-tools.test.ts tests/runtime-session.test.ts tests/server.test.ts tests/mcp-stdio.test.ts`: PASS, 4 files / 24 tests.
- `cd server && npm test -- --run --hookTimeout=30000`: PASS, 35 files passed / 3 skipped; 379 tests passed / 4 skipped.
- `cd server && npm run typecheck`: PASS.
- `cd server && npm run build`: PASS.
- `git diff --check`: PASS.
- Fresh stdio coverage built `dist/index.js`, emitted only complete MCP frames, and asserted exactly 45 tools.

## Self-review

- Re-read the Task 5 brief and approved Phase 5 design against inputs, outputs, annotations, inventory, session state, teardown order, screenshot verification, own-data constraints, and error policy.
- Confirmed the unrelated dirty `.superpowers/sdd/progress.md` and `.superpowers/sdd/task-2-report.md` were neither edited nor staged by this task.
- Confirmed no token, raw bridge error, child ID, inherited field, or accessor-derived value reaches public success/error output.
- Confirmed all new public successes have text equal to `JSON.stringify(structuredContent)` and all failure paths omit error structured content.

## Commits

- `659d14d` — `feat: expose runtime bridge tools` (all Task 5 code and tests).
- This report is committed separately so it can record the immutable implementation commit hash.

## Concerns

- The deterministic screenshot fixture validates the host acceptance path with a minimal PNG header/IHDR. End-to-end rendered viewport capture remains covered by the environment-gated live Godot work in later Phase 5 tasks.
- Depth truncation is conservatively declared when a returned node reaches the caller's maximum depth; the approved Task 4 bridge exposes only an aggregate node-bound truncation flag and no child-count proof at the cutoff.

## Important-review fix wave

### Fixes

- Locked bridge attachment for the complete active-session lifetime. A second `attachBridge` now returns a stable `godot_error` without replacing or closing the original bridge, changing screenshot-root authority, or changing which bridge receives requests. Normal stop still closes the original bridge before the process.
- Completed the public-boundary matrix for coordinator-backed scene node/depth truncation, property omissions, accessor/revoked-proxy payloads, timeout and bridge-error mappings, and screenshot containment/identity/format verification.
- Screenshot checks now reject multi-link files (`nlink !== 1`) in addition to escaped canonical paths, symbolic links where the platform permits creating them, non-regular files, bad PNG signatures, IHDR dimension mismatch, claimed-size mismatch, and files over 16 MiB.
- The bounded screenshot read uses an injected production file-open dependency, enabling a deterministic same-handle `stat -> read -> stat` mutation test. Identity, byte count, size, and modification time must remain stable across the read.
- Malformed bridge/proxy failures map to stable `godot_error`; explicit deadline failures remain `timeout`, and known closed/socket/transport failures remain `not_connected`. Raw bridge error text is never exposed.
- Added an inline code comment documenting the accepted Minor: because Task 4 provides no child-count proof at the requested depth cutoff, reaching `maxDepth` conservatively declares depth truncation.

### Review-fix TDD evidence

- RED: `cd server && npm test -- --run tests/runtime-session.test.ts` failed the new duplicate-attachment test because the replacement bridge and root were accepted.
- GREEN: the same command passed 10/10 after locking the first attachment.
- RED: `cd server && npm test -- --run tests/runtime-bridge-tools.test.ts tests/runtime-session.test.ts` failed three expanded boundary cases: revoked proxies mapped to `not_connected`, hard links were accepted, and the deterministic same-handle open seam was unused.
- GREEN: the same command passed 19/19 after error classification, link-count rejection, and same-handle dependency injection. A test-fixture correction aligned the fake handle's initial device/inode with the real file so the intended post-read mutation assertion was reached.

### Fresh review-fix verification

- `cd server && npm test -- --run tests/runtime-bridge-tools.test.ts tests/runtime-session.test.ts tests/runtime-bridge-client.test.ts tests/runtime-process-tools.test.ts tests/server.test.ts`: PASS, 5 files / 42 tests.
- `cd server && npm test -- --run tests/mcp-stdio.test.ts`: PASS, 1 file / 2 tests; freshly built stdio inventory remains exactly 45.
- `cd server && npm run typecheck`: PASS.
- `cd server && npm run build`: PASS.
- `cd server && npm test -- --run --hookTimeout=30000`: PASS, 35 files passed / 3 skipped; 384 tests passed / 4 skipped.
- `git diff --check`: PASS.

### Review-fix concerns

- Symlink creation can require Windows Developer Mode or elevated privilege; that assertion runs when creation succeeds and tolerates only `EPERM`. The portable hard-link case always runs and proves link rejection through `nlink`.
- The conservative depth-truncation semantics remain the documented Minor noted above.

## Final raw-candidate correction

### Fix and TDD evidence

- Added a production filesystem dependency for screenshot `lstat`, matching the existing injected `open` dependency. This gives platform-independent proof of raw-link rejection without relying on Windows symlink privileges.
- RED: `cd server && npm test -- --run tests/runtime-bridge-tools.test.ts -t "lexical raw"` failed 1/1 because the raw-candidate `lstat` seam received zero calls.
- GREEN: `cd server && npm test -- --run tests/runtime-bridge-tools.test.ts -t "lexical raw|same-handle"` passed 2/2 after implementing the required ordering.
- Screenshot verification now resolves a relative bridge-returned path lexically against the expected session root (or normalizes an absolute candidate), `lstat`s that raw pathname, and rejects symbolic links, non-regular files, and multi-link files before `realpath`.
- Only after raw-path rejection does it canonicalize the root and candidate, enforce canonical containment, re-`lstat` the canonical target, and open that exact target. Both handle `fstat`s retain device, inode, link-count, size, and modification-time defenses around the bounded read.
- The deterministic fake-handle test now also proves that a link-count mutation from 1 to 2 across the same-handle read is rejected. The EPERM-tolerant real symlink integration assertion remains in place.

### Fresh final-correction verification

- `cd server && npm test -- --run tests/runtime-bridge-tools.test.ts tests/runtime-session.test.ts tests/runtime-bridge-client.test.ts tests/runtime-process-tools.test.ts tests/server.test.ts`: PASS, 5 files / 43 tests.
- `cd server && npm run typecheck`: PASS.
- `cd server && npm run build`: PASS.
- `cd server && npm test -- --run --hookTimeout=30000`: PASS, 35 files passed / 3 skipped; 385 tests passed / 4 skipped.
- `cd server && npm test -- --run tests/mcp-stdio.test.ts`: PASS, 1 file / 2 tests; freshly built stdio inventory remains exactly 45.
- `git diff --check`: PASS.
