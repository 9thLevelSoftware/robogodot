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

## Major review-fix pass

- Replaced the raw-token socket greeting with mutual HMAC-SHA256 authentication using independent 32-byte client/server nonces and distinct domain labels. Client proof comparison is fixed-time; concurrent `connect()` calls share one owned attempt and all failed-attempt listeners, timers, and sockets are destroyed before file fallback.
- Locked both peers to one transport: authenticated socket selection disables file polling; authenticated file selection stops the listener and drops the socket. Published requests are never replayed.
- Replaced recursive output copying with descriptor-only bounded normalization: no accessors/prototypes, proxy traps caught, finite JSON values only, cycle rejection, depth 32, nodes 1,000, arrays/objects 500, and strings 8,192 bytes. Malformed/zero/oversized/invalid-UTF8/receive-overflow frames are rejected.
- Hardened file requests with canonical link-free root revalidation, random exclusive temporary files, flush/close, atomic no-replace hard-link publication, stable regular response identity reads, shared deadlines, and exact request/temp/response cleanup.
- Added safe JSON-number integer handling and generation-owned held input. Action press/release/press-release uses actual Input state; delayed releases occur once and cleanup invalidates timers and releases held state.
- Scene property reads now use an explicit built-in allowlist, exclude script variables/custom getters, call `get` once, reject non-finite values, and defensively track visited nodes.
- Screenshot capture rejects headless/unavailable viewport readback before texture access, validates dimensions/PNG size, publishes through a random flushed temporary file with no-overwrite checks, and verifies the final artifact before returning metadata.

### Review-fix RED/GREEN evidence

- RED: normalization invoked getters and accepted hostile/deep/cyclic values; concurrent connect was not coalesced; forged acknowledgements were accepted; MAX_SAFE request IDs mutated to an unsafe integer. GREEN: focused Vitest passes all new cases.
- RED: the expanded authenticated Godot smoke initially exposed JSON float IDs, JSON float input bounds, missing `StringName` serialization, a GDScript type-inference compile failure, and action events not updating actual Input state. GREEN: the smoke now calls all four methods sequentially, proves depth bounds/custom getter non-invocation/action release/token redaction/artifact cleanup, checks bounded headless readback failure, and verifies a real 8x6 PNG publication.
- Systematic-debugging evidence: the apparent headless hang reproduced with the direct smoke command. Verbose redirected output localized it to `runtime_bridge.gd:103` type inference; the dependent script then attempted `.new()` on an uncompiled resource and its async error path never quit. The smoke now uses safe assertions/final failure exit, so subsequent failures exited immediately with their real payloads.

### Fresh review-fix verification

- `cd server && npm test -- --run tests/runtime-bridge-client.test.ts`: PASS, 1 file / 8 tests.
- `cd server && npm test -- --run --hookTimeout=30000`: PASS, 34 files passed / 3 skipped; 372 tests passed / 4 skipped.
- `cd server && npm run typecheck`: PASS.
- `cd server && npm run build`: PASS.
- `$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; node tests/godot/run-smoke.mjs`: PASS, including both Phase 5 markers.

### Remaining concerns

- The installed headless Godot uses the dummy renderer, so authenticated `runtime.screenshot` proves its bounded unavailable-readback response; the same smoke separately exercises the exact production PNG publication path with a real encoded 8x6 image. Live non-headless viewport readback remains environment-gated.
- Automated tests do not yet inject every reviewed filesystem race (junction replacement during every poll, forced Godot rename/flush failures) or a delayed socket acknowledgement arriving after fallback. Repeated identity checks and transport locks are implemented, but these specific fault injections remain coverage gaps.
- Key/mouse validation and delayed release share the generation-owned release implementation with the action path, but the real Godot smoke asserts actual Input state only for actions.

## Re-review correction pass

- Added a distinct authenticated `hello_confirm` message after server-proof verification. The runtime remains transport-undecided and continues file polling after sending its proof; it locks socket only after fixed-time verification of the confirmation. The client uses one shared three-second deadline and owns/destroys the provisional socket on delayed/lost proof before selecting file fallback.
- Normalized the complete request before serialization, sizing, ID mutation, or publication. Array normalization now obtains guarded own descriptors, validates the own data `length`, accepts only bounded indexed data descriptors, represents holes as null, and never calls accessors, `toJSON`, array iteration methods, or proxy traps.
- Made every action/key/mouse press generation-owned, including indefinite action presses and zero-duration key/mouse presses. Explicit release forgets the held record; timed release, explicit cleanup, `InputBridge._exit_tree`, and `RuntimeBridge._exit_tree` release each remaining record once. Cleanup remains idempotent.
- Runtime file polling now accepts only canonical positive-safe-integer `req-<id>.json` names whose body ID matches. Cleanup recognizes only exact request/response names and exact 32-hex temporary-file grammar, preserving unrelated prefix-like files.

### Re-review TDD evidence

- RED: accessor arrays were read by `.map`, proxied arrays escaped bounded descriptor handling, hostile request params invoked a getter through `JSON.stringify`, and delayed server proof still selected socket. GREEN: focused tests prove zero invocations/publications, unchanged request ID after rejection, and delayed proof falling back to a usable file bridge with zero confirmations.
- RED: synchronous bridge removal left an indefinite action pressed because only timed events were stored in `_held`. GREEN: every press is now stored with a stable signature/release value, and the real Godot smoke proves removal from the tree synchronously releases it.
- The real smoke additionally publishes a body-ID-mismatched canonical request and verifies no response, then proves exact owned files are removed while three prefix-like foreign files survive two cleanup calls.

### Fresh re-review verification

- `cd server && npm test -- --run tests/runtime-bridge-client.test.ts`: PASS, 1 file / 10 tests.
- `cd server && npm run typecheck`: PASS.
- `cd server && npm run build`: PASS.
- `cd server && npm test -- --run --hookTimeout=30000`: PASS, 34 files passed / 3 skipped; 374 tests passed / 4 skipped.
- `$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; node tests/godot/run-smoke.mjs`: PASS, including `PASS phase 5 authenticated bridge bootstrap` and `PASS phase 5 locked runtime bridge`.

### Re-review residual concern

- TCP delivery acknowledgement cannot provide distributed common knowledge that the runtime processed the final confirmation. The client selects socket only after the OS accepts the authenticated confirmation write; if the provisional socket fails or the server proof misses the shared deadline, it is destroyed before file fallback and the runtime has not locked. No request is replayed after publication.
