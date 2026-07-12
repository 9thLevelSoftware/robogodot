# Task 6 report

## Outcome

Phase 3 exposes exactly 31 public MCP tools (8 existing plus 23 curated, no aliases). `createServer` constructs one `MutationLane` and shares it across node, signal, instance, and project-setting mutation registrations. The public live acceptance uses an authenticated `JsonRpcClient`, in-memory MCP transport, and curated tools for authoring, persistence, reads, FIFO proof, and restart proof. A public `godot_script_run` call is used only as the headless equivalent of human Ctrl-Z; it is not presented as an undo API.

## RED evidence

1. `npm run test:live:phase3` failed against Godot 4.6.2 when typed string literals were not JSON-quoted at the Godot Variant boundary. The acceptance fixture was corrected to use the documented literal representation.
2. The next live run failed because JSON numeric signal flags arrive in Godot as a float and `edit.gd` required the runtime type `int`, rejecting valid public input `flags: 0`. This proved a production boundary defect.
3. `node --test tests/architecture/phase3-review-regressions.test.mjs` failed before documentation/CI changes because README lacked the Phase 3 contract, Q-005 remained proposed, and CI lacked the new live command.
4. The first full architecture run failed three stale assertions that still required Q-005 to be unresolved and the old Phase 3 handoff label.

## GREEN evidence

- Signal flags now accept only integral numeric values whose integer value is within the existing 0–15 mask; fractional and out-of-range values remain rejected.
- `npm run test:live:phase3`: 1 passed against pinned Godot 4.6.2, covering scene creation, typed nodes/properties, fixture instancing, signal connection, resource create/save/load, exact absent project setting, concurrent FIFO mutations, save/open persistence, full undo verification, restart invalidation of handles, and bridge reconnection.
- `npm test -- --run`: 178 passed, 2 live tests skipped without `GODOT_PATH`.
- `npm run typecheck && npm run build && npm run docs:check`: passed.
- Architecture/process-runner matrix: 91 passed, 1 documented external-archive skip.
- Repository architecture renderer regenerated views 03/04/05/07 and `node docs/architecture/render.mjs --check` passed.
- Godot smoke command exited successfully; the existing harness emits expected negative-fixture diagnostics and an environment .NET SDK warning.

## Documentation and architecture

README documents the 31/23 inventory, annotations by operation class, normal Ctrl-Z semantics, lifecycle/persistence exclusions, FIFO lane, canonical path and byte/page/depth bounds, exact read-only method allowlist, session-scoped resource handles, fail-closed dirty and project-setting recovery behavior, overwrite TOCTOU, and deferred Phase 6/7 realpath/atomic no-replace hardening. Q-005 is accepted as exact prior-presence/value restoration or rejection. Atlas source, traceability, rendered SVGs, and manifest were updated through the repository renderer.

## CI

Both OS jobs retain pinned Godot 4.6.2 and all existing checks. `npm run test:live:phase3` runs immediately after the existing live acceptance.
