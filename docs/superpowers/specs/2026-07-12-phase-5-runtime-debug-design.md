# Phase 5 Runtime and Debug Design

**Date:** 2026-07-12

**Status:** Approved for implementation planning

## 1. Objective

Give an MCP client one controlled feedback loop for running, observing, debugging, and interacting with a Godot 4.6 project. Phase 5 adds managed process control with incremental output, an attach-only Godot DAP client, and an authenticated running-game bridge for live scene inspection, bounded input injection, and screenshots.

Phase 5 is complete when one public MCP flow can start the sample game, read known output, inspect and change observable runtime state through a named input action, capture a valid PNG, hit and inspect a known breakpoint, step and continue, and stop without leaving a process, credential, transport, or session artifact behind.

## 2. Scope

### In scope

- One `RuntimeSessionCoordinator` controlling one active normal or debug session.
- A shell-free `ProcessRunner` with exact child ownership, bounded output rings, incremental cursors, exit detection, and graceful/forced stop.
- A bounded DAP client that attaches to the coordinator-owned debug process.
- An injected GDScript runtime bridge with authenticated loopback transport and a negotiated sequenced-file fallback.
- Live scene-tree, node-property, input, and screenshot operations.
- Exactly 13 public tools:
  - `godot_run_project`
  - `godot_stop_project`
  - `godot_run_output`
  - `godot_debug_launch`
  - `godot_debug_set_breakpoint`
  - `godot_debug_continue`
  - `godot_debug_step`
  - `godot_debug_stack`
  - `godot_debug_inspect`
  - `godot_runtime_scene_tree`
  - `godot_runtime_get_node`
  - `godot_runtime_input`
  - `godot_runtime_screenshot`
- Recorded process/DAP/bridge fixtures and live Godot 4.6 acceptance.
- Architecture, traceability, runbook, and CI updates.

### Out of scope

- Editor mutation and persistence, which remain Phase 3 responsibilities.
- LSP or source refactoring, which remain Phase 4 responsibilities.
- Headless batch/export and general filesystem tooling, which remain Phase 6 responsibilities.
- Global audit/cache/concurrency middleware, which remains Phase 7 work.
- Arbitrary script evaluation inside the running game.
- DAP-owned OS process spawning.
- Mid-session bridge transport switching or request replay after execution may have begun.
- Platform-generic arbitrary input-event construction.

## 3. Dependencies and Public Inventory

Phase 5 consumes Phase 1 configuration, logging, errors, and editor transport; Phase 2 authenticated editor execution for installing or updating bridge hooks; Phase 3 project-setting and lifecycle patterns where applicable; and Phase 4's bounded TCP protocol and exact-child process lessons without coupling runtime state to the LSP session.

The existing 38 tools remain unchanged. Phase 5 adds exactly 13 names for a total inventory of 51. Runtime session state is independent of editor WebSocket and LSP state after bridge bootstrap, but bootstrap that needs plugin resolution or hook injection fails honestly when the editor is unavailable.

## 4. Accepted Architecture Decisions

### Q-010: one launch owner

`ProcessRunner` is the only component allowed to spawn, own, observe, or terminate the game process. `godot_run_project` starts a normal managed session. `godot_debug_launch` starts the same managed process with debug/DAP arguments, then `DapClient` performs protocol initialization and attach. DAP never independently launches another process.

This prevents duplicate games, split PID/output ownership, inconsistent arguments, and competing teardown.

### Q-011: plugin-resolved runtime storage

The editor plugin resolves the canonical absolute form of the project's `user://` directory through Godot APIs and returns it over the authenticated editor channel. The host never derives this path from operating-system conventions. The coordinator creates one random session subdirectory beneath a plugin-approved `.mcp` root and accepts screenshot/file results only inside that canonical session directory.

### Q-012: negotiated, locked bridge transport

Every launch receives a random session ID, random secret token, protocol version, and preferred authenticated loopback endpoint. The injected bridge attempts a bounded socket handshake. If that handshake cannot complete, both peers select sequenced file IPC before any runtime request is accepted. The chosen transport is immutable for that session.

There is no automatic switching or replay after a request may have executed. A failed selected transport makes the bridge unavailable until a new runtime session starts.

## 5. Components

### RuntimeSessionCoordinator

Owns the public runtime state machine:

`idle -> starting -> running | debug_ready -> stopping -> idle`

Failure branches transition through `failed` and perform the same ordered cleanup before returning to `idle`. It allocates opaque session IDs, rejects stale-session calls, serializes launch/stop, binds process, bridge, and optional DAP lifetimes, and exposes immutable session status. Only one active session is allowed.

### ProcessRunner

Spawns the configured Godot executable with an argument array and no shell. It owns the exact `ChildProcess`, PID, stdout/stderr readers, exit/error listeners, and stop escalation. It uses independent bounded ring buffers for normalized output records and monotonic cursors. Ring overwrite is reported as lost records rather than silently changing cursor meaning.

Stop first requests graceful termination through the managed process/session boundary, waits a finite deadline, then escalates only against the exact tracked child. Windows tree termination is exact-PID, deadline-bounded, and handles spawn errors and stalls. Natural exit atomically clears ownership so a recycled PID is never signaled.

### DapClient

Implements DAP `Content-Length` framing separately from LSP state while reusing proven bounded-parser patterns. It correlates sequence IDs, handles events, captures advertised capabilities, and supports initialize, attach, configuration completion, setBreakpoints, continue, next, stepIn, threads, stackTrace, scopes, variables, disconnect, and terminate where Godot advertises them.

Frame IDs, scope IDs, and variable references belong to one stopped event and one runtime session. Continue, step, process exit, reconnect, or stop invalidates them. Unsupported capabilities return `feature_disabled`; DAP loss may degrade an otherwise healthy runtime session to process-plus-bridge.

### RuntimeBridgeBootstrap

Uses the authenticated editor/plugin boundary to obtain the canonical `user://` root and ensure the narrow bridge autoloads are available for the launched project. It passes session credentials and endpoint/fallback configuration to the child without logging or returning the secret. Bootstrap artifacts are versioned, session-scoped, and cleaned during stop.

### RuntimeBridgeClient

Owns one selected transport, monotonic request IDs, bounded pending work, per-request deadlines, response correlation, and teardown. The socket protocol uses authenticated, versioned length-bounded JSON frames. File fallback uses atomic publication within the approved session directory, one host request writer, one game response writer, `req-<id>.json` and `resp-<id>.json`, and immediate response cleanup after bounded reading.

Unknown, stale, duplicate, oversized, or wrong-session responses are ignored or fail the session closed; they never settle another request.

### GDScript runtime bridge

The injected bridge exposes only:

- bounded live scene-tree snapshot;
- allowlisted serializable node-property inspection;
- named action press/release and explicit key/mouse-button events;
- viewport PNG capture inside the approved session screenshot directory.

It verifies protocol version, session ID, token, method, parameters, request bounds, and response bounds. It processes requests sequentially on the main thread and never evaluates caller-provided GDScript.

## 6. Session and Data Flow

### Launch

1. Validate project, optional scene, arguments, mode, editor/bootstrap availability, and safety policy.
2. Allocate session ID/token and resolve the canonical bridge root through the plugin.
3. Prepare versioned autoload/bootstrap configuration.
4. Start the `ProcessRunner`-owned Godot child.
5. Negotiate and lock the runtime bridge transport.
6. For debug mode, connect DAP to the coordinator-owned process and complete attach/configuration.
7. Publish `running` or `debug_ready` only after required subchannels are ready.

If DAP is unsupported or fails after the game and bridge become healthy, the coordinator records the debug failure and may expose process-plus-bridge operation. `godot_debug_launch` itself returns an error rather than claiming a debug-ready session.

### Runtime request

Every request validates the opaque session ID and current state, allocates one monotonic request ID, sends through the locked transport, waits once within a shared deadline, validates the correlated bounded response, and normalizes structured output. No fallback or replay happens after send.

### Stop

Stop is idempotent and independently attempts every cleanup stage while preserving the first failure:

1. Reject new runtime requests and cancel bounded pending waits.
2. Disconnect/end DAP and invalidate debug references.
3. Close the bridge, delete session request/response/screenshot/bootstrap artifacts, and clear credentials.
4. Ask the exact managed game to quit gracefully.
5. Force only the exact owned child if still alive.
6. Detach listeners, finalize output/exit metadata, and return to `idle`.

## 7. Public Tool Contracts

All tools use strict Zod inputs and outputs, UTF-8 byte limits, finite deadlines, and JSON-compatible normalized values. Every call except launch carries the opaque runtime session ID.

### Process tools

`godot_run_project` accepts an optional contained `res://` scene and bounded argument strings. It returns session ID, `normal` mode, PID, bridge transport, and start time.

`godot_stop_project` accepts session ID and returns already-stopped, graceful, forced, exit, and cleanup outcomes without signaling any unowned process.

`godot_run_output` accepts session ID, `since`, and a bounded limit. It returns running/exit state, bounded timestamped stdout/stderr records, `next`, and explicit lost/truncated metadata.

### Debug tools

`godot_debug_launch` accepts optional contained scene, bounded arguments, and optional initial breakpoints. It returns the managed session plus negotiated DAP capabilities only after attach/configuration.

`godot_debug_set_breakpoint` replaces the requested breakpoints for one existing contained `.gd` file and returns verified locations.

`godot_debug_continue` continues a validated stopped thread.

`godot_debug_step` accepts `over` or `into` and a stopped thread.

`godot_debug_stack` returns bounded threads and stack frames with contained source locations and truncation.

`godot_debug_inspect` accepts a current stopped frame and optional variable reference/page cursor. It returns bounded scopes or variables and pagination metadata. It does not evaluate arbitrary expressions.

### Runtime bridge tools

`godot_runtime_scene_tree` returns a bounded live hierarchy with node/depth truncation.

`godot_runtime_get_node` accepts a bounded live NodePath and optional allowlisted property names, returning serializable values plus omissions.

`godot_runtime_input` accepts exactly one named action operation or one validated key/mouse-button event. Named actions support press, release, or press-and-release with a finite hold duration. Raw event classes and arbitrary property dictionaries are rejected.

`godot_runtime_screenshot` captures the root viewport and returns logical session path, canonical absolute path, width, height, byte size, SHA-256 hash, and PNG format. The file must exist as a bounded regular file inside the canonical session directory.

## 8. Annotations and Safety

- `godot_run_output`, `godot_debug_stack`, `godot_debug_inspect`, `godot_runtime_scene_tree`, and `godot_runtime_get_node` declare `readOnlyHint: true`.
- Launch, stop, breakpoint changes, continue, step, input, and screenshot declare `readOnlyHint: false`; they change runtime state or create an ephemeral file and are never routed through editor UndoRedo.
- Screenshot capture declares `destructiveHint: false`, but it is not called read-only because it creates a session artifact.
- Stop declares `destructiveHint: true`; other tools declare `destructiveHint: false` unless a later safety review demonstrates irreversible runtime impact.
- All 13 tools declare `openWorldHint: true` because they observe or control an external child process, DAP peer, bridge peer, or filesystem artifact.
- Read tools are idempotent except cursor-based output retrieval, whose result changes as the process emits output. Launch, continue, step, input, and screenshot are non-idempotent. Stop and breakpoint replacement are idempotent for the same validated state.
- Safety mode gates launch/input/debug mutation consistently with existing policy behavior.
- A second launch never replaces a live session. It returns `godot_error` with the active state and stop guidance.
- Tokens, raw environment blocks, unrestricted command lines, and arbitrary output tails never appear in public results or ordinary logs.

## 9. Errors and Bounds

Use existing codes:

- `invalid_args`: invalid paths, session IDs, cursors, arguments, events, breakpoints, frames, references, or bounds.
- `godot_error`: invalid runtime state, second launch, process crash, malformed DAP/bridge traffic, or screenshot failure.
- `not_connected`: required DAP or bridge subchannel unavailable.
- `editor_required`: canonical path resolution or bridge injection needs the editor/plugin.
- `timeout`: shared launch, handshake, request, stop, or capture deadline exhausted.
- `feature_disabled`: Godot does not advertise the requested DAP capability.
- `blocked_by_policy`: launch, debug mutation, or input rejected by safety mode.

Named constants bound DAP/bridge frames and buffers, pending requests, launch arguments, output records/bytes, scene nodes/depth, properties, strings, stack frames, scopes, variables, screenshots, files, and every lifecycle deadline. Reconnect, negotiation, polling, fallback, and cleanup loops have shared wall-clock deadlines or explicit attempt caps.

## 10. Testing and Acceptance

### Deterministic process tests

- shell-free exact arguments and environment;
- simultaneous launch rejection;
- bounded stdout/stderr ring wrap, incremental cursor, and lost-record reporting;
- spawn error, natural exit, graceful stop, forced exact-child stop, PID reuse safety, and cleanup error aggregation.

### Recorded DAP tests

- split/coalesced framing, correlation, events, capability capture, deadlines, and malformed traffic;
- initialize/attach/configuration order;
- breakpoint replacement and verification;
- stopped event, threads, stack, scopes, paginated variables, continue, step over/into, invalidation, disconnect, and degradation.

### Recorded bridge tests

- plugin-resolved canonical root and session containment;
- authenticated socket success;
- pre-request file fallback negotiation;
- immutable transport selection and no replay;
- monotonic IDs, sequential game execution, stale/duplicate/wrong-session responses, bounded files/frames, timeouts, and cleanup;
- scene, node, input, screenshot, and JSON normalization bounds.

### Live Godot acceptance

Use isolated copied projects and allocated ports. Through public MCP:

- start a sample game and read a known stdout record;
- inspect a known live tree and property;
- inject `jump` and observe a known state change;
- capture a PNG with expected dimensions, size, hash, and containment;
- debug-launch, hit a known breakpoint, verify stack and variable value, step, continue;
- stop and prove exact process exit plus removal of session artifacts.

The suite skips only when the configured Godot executable is absent. When present, launch, protocol, assertion, compilation, screenshot, cleanup, or timeout failures are fatal. Windowed visual acceptance is preferred; headless/CI renderer differences are documented and assertions remain deterministic.

### Regression

- exact 51-tool public inventory;
- all Phase 1–4 tests, smokes, architecture checks, and live suites;
- typecheck, build, docs integrity, generated architecture artifacts, and fail-closed CI.

## 11. Documentation and Architecture

- Resolve Q-010, Q-011, and Q-012 with the accepted decisions above.
- Update runtime sequence, components, dependencies, lifecycles, traceability, and rendered artifacts from implemented evidence.
- Document process ownership, bridge negotiation, DAP capability boundaries, all 13 contracts, session invalidation, safety annotations, runbook commands, renderer caveats, and teardown behavior.
- Do not relabel Phase 6–8 work as implemented.

## 12. Risks and Mitigations

- **Duplicate or orphan game process:** one coordinator and one exact process owner; attempt-all bounded teardown.
- **DAP partial support:** capability gates and honest process-plus-bridge degradation.
- **Bridge replay or split-brain:** negotiate once before requests, lock transport, never replay after send.
- **Credential exposure:** random per-session secret, loopback/file containment, redaction, cleanup.
- **File IPC races:** session directory, monotonic IDs, atomic publication, single writers, bounded polling and cleanup.
- **Runtime main-thread stalls:** sequential bounded requests, timeouts, and no claim of in-process cancellation.
- **Large scene/variables/output/screenshots:** named byte/count/depth limits with truncation or fail-closed errors.
- **Screenshot renderer variance:** deterministic fixture dimensions/content checks and documented headless differences.
- **Stale debug/runtime handles:** session and stopped-generation binding with invalidation on resume, exit, or stop.

## 13. Deliverables

- `RuntimeSessionCoordinator`, `ProcessRunner`, `DapClient`, bridge bootstrap/client, and injected runtime autoloads.
- Exactly 13 bounded public runtime/debug tools.
- Recorded process, DAP, and bridge fixtures with comprehensive tests.
- Real Godot sample-game acceptance for run/read/inspect/input/screenshot/debug/stop.
- Updated README, architecture atlas, open-question decisions, traceability, CI, and SDD evidence.
