# Phase 4 Code Intelligence (LSP) Design

**Date:** 2026-07-11

**Status:** Approved for implementation planning

## 1. Objective

Expose Godot 4.6's built-in GDScript Language Server as seven read-only MCP tools. The tools provide project-grounded diagnostics, completion, hover, signature help, document symbols, capability-gated workspace symbols, and native Godot API documentation without reimplementing language intelligence.

Phase 4 is complete when the mock protocol suite passes, live Godot diagnostics match a deliberate editor-visible GDScript error, the supported code-intelligence tools return bounded structured results, unavailable service behavior is actionable, and the opt-in headless host can launch and tear down an editor process it owns.

## 2. Scope

### In scope

- A reusable TCP LSP transport with `Content-Length` framing, request correlation, notifications, deadlines, and bounded messages.
- An initialized LSP session with capability capture, reconnect, document restoration, and graceful shutdown.
- Exact full-text `didOpen` and `didChange` synchronization for `.gd` files beneath the configured project root.
- Bounded storage and retrieval of pushed `textDocument/publishDiagnostics` notifications.
- Seven MCP tools:
  - `godot_lsp_diagnostics`
  - `godot_lsp_completion`
  - `godot_lsp_hover`
  - `godot_lsp_signature_help`
  - `godot_lsp_document_symbols`
  - `godot_lsp_workspace_symbols`
  - `godot_lsp_native_symbol`
- An opt-in headless LSP host using the configured Godot executable and project.
- Mock-protocol, MCP-contract, unavailable-service, live-editor, and live-headless-host acceptance tests.
- Architecture and user documentation updates, including resolution of `Q-002` for Phase 4.

### Out of scope

- Rename, formatting, code actions, references, definitions, or other unplanned LSP methods.
- Applying completion edits or mutating source files.
- A server-built recursive workspace index.
- Caller-supplied virtual document text.
- General filesystem tooling, exports, UID management, or the Phase 6 `FsGuard` API.
- General caching, audit middleware, or global concurrency controls assigned to Phase 7.
- DAP, game-process control, or runtime inspection assigned to Phase 5.

## 3. Dependency Decision

Resolve `Q-002` for Phase 4 as follows: Phase 1 is the API prerequisite because Phase 4 consumes resolved config, logging, and structured errors. The completed Phase 2 spine is a coordination milestone and regression baseline, not an LSP API dependency. Phase 4 remains independent of the editor-plugin WebSocket and Phase 3 mutation lane.

The implementation must preserve Phase 1 through Phase 3 behavior and tests.

## 4. Architecture

### 4.1 Components

`LspTransport` owns one TCP socket. It encodes and parses LSP frames, correlates numeric JSON-RPC request IDs, routes notifications, enforces frame and buffer limits, applies request deadlines, and rejects pending work when the socket generation ends. It contains no Godot document or tool semantics.

`LspSession` owns protocol lifecycle. It connects, sends `initialize`, records the returned server capabilities and Godot extension data, sends `initialized`, exposes request and notification operations only when ready, reconnects after unexpected loss, and performs `shutdown` followed by `exit` during graceful teardown. Each successful connection receives a monotonically increasing generation number.

`LspDocuments` maps validated `res://` URIs to canonical project files. It reads exact bytes from disk, sends `didOpen` on first synchronization, sends full-text `didChange` when bytes differ, increments document versions monotonically, and restores open documents after reconnect. It never normalizes indentation, line endings, or encoding content.

`LspDiagnostics` consumes `textDocument/publishDiagnostics`. It retains bounded latest publications per URI and allows diagnostics calls to wait for a publication causally following the current synchronization. A timed-out wait may return the latest stored publication marked `fresh: false`; if no publication exists, the tool returns a `timeout` error.

`LspHost` probes the configured endpoint before launching anything. When automatic hosting is enabled and no service answers, it starts `GODOT_PATH --editor --headless --lsp-port <port> --path <project>`, captures bounded stdout and stderr, and tracks ownership of that child. It never terminates an editor it did not launch.

`tools/lsp.ts` defines the seven MCP contracts, validates bounded inputs, checks negotiated capabilities, synchronizes documents where required, maps LSP payloads to bounded outputs, and uses the shared registry/error conventions.

### 4.2 Data flow

For a document-position request:

1. The MCP registry validates the tool schema.
2. The tool validates and resolves the `res://` URI beneath the configured project root.
3. `LspDocuments` reads exact disk bytes and synchronizes the document.
4. `LspSession` ensures a ready initialized connection.
5. The tool checks the required negotiated capability.
6. `LspTransport` sends a correlated request with a deadline.
7. The tool bounds and normalizes the response into `structuredContent`.
8. The registry returns the same JSON representation in text content.

Diagnostics differ at step 6: they wait for a pushed `publishDiagnostics` notification rather than invoking an unsupported pull-diagnostics method.

Native-symbol lookup does not require a project document. It invokes Godot's custom `textDocument/nativeSymbol` request using `native_class` and `symbol_name`; an omitted MCP member is encoded as an empty `symbol_name` for class lookup.

## 5. Protocol and Lifecycle

The modeled session states are `disconnected`, `connecting`, `initializing`, `ready`, `reconnecting`, `shutting_down`, and `exited`.

- First use starts connection lazily.
- Only one connect/initialize attempt may be active at once.
- Requests are unavailable until initialization completes.
- Unexpected socket loss rejects every pending request, clears generation-owned diagnostic waiters, and enters bounded reconnect.
- A stale response or notification from an earlier generation cannot settle current work.
- After reconnect and initialization, previously open documents are replayed with their latest exact text before the session reports ready.
- Explicit shutdown stops reconnect, sends `shutdown`, sends `exit`, closes transport, and terminates only an owned host child.
- Process teardown is idempotent.

Reconnect uses bounded exponential backoff consistent with existing project transport conventions. Tests use injected clocks or short deterministic delays rather than real production waits.

## 6. Document and Path Contract

- Public document inputs use `res://` URIs only.
- Phase 4 accepts only paths ending in `.gd`.
- URI length and segment count are bounded.
- Percent-encoded traversal, absolute paths, alternate schemes, NUL bytes, and `..` escapes are rejected.
- The configured project root and target file are resolved with real filesystem identity; the target must remain beneath the project root after symlink or junction resolution.
- The target must be an existing regular file.
- Disk bytes are authoritative. Callers cannot submit replacement text.
- Text is decoded as UTF-8. Invalid UTF-8 is `invalid_args` with a corrective hint.
- Full-document synchronization is used even if incremental synchronization is advertised.
- Document versions start at one for each session-owned document and increase on changed disk bytes. Unchanged bytes do not emit redundant `didChange` notifications.
- Public positions are zero-based LSP positions. `character` is a UTF-16 code-unit offset, and out-of-range positions are rejected before the LSP request.

This narrow read boundary is local to Phase 4 and does not claim to implement the broader Phase 6 `FsGuard` contract.

## 7. Tool Contracts

Every tool declares `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, and `openWorldHint: false`. Descriptions state that Godot LSP support is partial and that Phase 4 does not expose rename, formatting, or code actions.

### `godot_lsp_diagnostics`

Input: `uri` and optional bounded `waitMs`.

Synchronizes exact disk content and waits for a matching pushed diagnostics publication. Output includes the URI, synchronized document version, `fresh`, and bounded diagnostic entries containing range, normalized severity, optional code/source, message, and bounded related information.

### `godot_lsp_completion`

Input: `uri`, `position`, optional trigger context, and optional bounded `limit`.

Output contains a bounded list of labels, kinds, detail, documentation, insert text, sort/filter text, and text edits when supplied by Godot. The tool never applies edits or resolves additional items implicitly.

### `godot_lsp_hover`

Input: `uri` and `position`.

Output contains `found`, normalized bounded Markdown or plain text, and an optional range. A protocol `null` result maps to `found: false` rather than an error.

### `godot_lsp_signature_help`

Input: `uri` and `position`.

Output contains bounded signatures, documentation, parameters, `activeSignature`, and `activeParameter`. Empty protocol results map to an empty successful result.

### `godot_lsp_document_symbols`

Input: `uri`.

Output contains a bounded hierarchical symbol tree with name, detail, kind, range, selection range, and children. Depth and total nodes are capped, and truncation is declared.

### `godot_lsp_workspace_symbols`

Input: a bounded `query` and optional bounded `limit`.

The tool invokes `workspace/symbol` only if the initialized server advertises workspace-symbol capability. Godot 4.6 does not register that method, so its live result is `feature_disabled` with a version-specific explanation. The stable MCP contract remains available for later compatible Godot versions. Phase 4 does not fabricate a recursive filesystem index.

### `godot_lsp_native_symbol`

Input: `nativeClass` and optional `member`.

The tool calls Godot's custom `textDocument/nativeSymbol` method with `native_class` and `symbol_name`, encoding an omitted `member` as an empty `symbol_name` for the 4.6 extension. Output contains the bounded native symbol tree and rendered documentation returned by the running engine. A missing symbol returns a successful `found: false` result.

## 8. Capability Policy

Capabilities are captured from `initialize` and treated as connection-generation state. A tool must not infer support merely because a method exists in this design.

- Standard tools require their corresponding advertised server capability.
- Godot's custom native-symbol method is enabled only when the initialize payload or the pinned 4.6 compatibility profile identifies a supported Godot server.
- Absent capabilities produce `feature_disabled`, not `not_connected` or an empty fabricated success.
- Unsupported workspace symbols remain a registered tool so the MCP interface is stable across engine maintenance versions.

## 9. Headless Host Policy

Add `GODOT_MCP_LSP_AUTO_START`, defaulting to `false`. Only `true` or `1` enables it.

When enabled:

- `GODOT_PATH` must name a usable executable.
- `GODOT_PROJECT_PATH` must name a project directory containing `project.godot`.
- The host first attempts to attach to `127.0.0.1:GODOT_LSP_PORT`.
- If unavailable, it launches one child with `--editor --headless --lsp-port <port> --path <project>`.
- Startup uses a bounded deadline and bounded captured diagnostics.
- Port-race recovery re-probes before retrying and never kills the process that won the port unless it is the tracked child.
- The server records whether the session is attached or owned.
- Shutdown terminates only the owned child and waits for bounded graceful exit before forceful child-only termination.

Automatic hosting remains optional because a visible editor provides the most representative project state and avoids surprising background processes.

## 10. Errors and Bounds

Use existing structured error codes:

- `invalid_args`: invalid schema semantics, URI, extension, UTF-8, position, bounds, missing file, or path escape.
- `not_connected`: no reachable LSP and automatic hosting is disabled or cannot establish a service.
- `editor_required`: automatic hosting was requested without usable Godot or project configuration.
- `timeout`: connection, initialization, request, shutdown, or diagnostics wait exceeded its deadline.
- `feature_disabled`: the connected LSP lacks the requested capability.
- `godot_error`: LSP error response, malformed protocol payload, frame violation, or unexpected host failure.

Every error includes a concrete hint. Unavailable-service hints include the exact configured command for starting the headless editor, with paths safely quoted for display.

The implementation defines explicit constants for maximum frame bytes, receive-buffer bytes, pending requests, synchronized documents, document bytes, diagnostic entries, completion items, symbol nodes/depth, documentation bytes, query bytes, and deadline ranges. Limit breaches fail closed or truncate only where the output schema declares truncation.

## 11. Testing Strategy

### Unit and mock-protocol tests

- Encode correct UTF-8 byte `Content-Length`.
- Parse fragmented headers, fragmented bodies, and multiple frames in one chunk.
- Reject malformed headers, duplicate/invalid lengths, oversized frames, oversized receive buffers, invalid JSON, and invalid JSON-RPC envelopes.
- Correlate out-of-order results and errors.
- Remove timed-out requests without affecting later responses.
- Route notifications separately from responses.
- Perform `initialize`/`initialized`, capture capabilities, and perform `shutdown`/`exit`.
- Coalesce simultaneous connection attempts.
- Reject pending work on disconnect and ignore stale-generation traffic.
- Reconnect and restore synchronized documents.
- Validate exact-byte full-text synchronization, version increments, unchanged-file suppression, path containment, UTF-16 positions, and diagnostic freshness.
- Validate headless attach, launch, port race, startup diagnostics, and owned-child-only teardown with injected process/socket boundaries.

### MCP contract tests

- Register exactly seven new unique LSP tools.
- Assert schemas, annotations, descriptions, structured outputs, bounds, and error mappings.
- Prove workspace-symbol capability gating and native-symbol compatibility gating.
- Prove LSP tools work independently of editor-plugin WebSocket status.

### Live Godot 4.6 tests

- Use the configured Godot 4.6 editor and a scratch project fixture.
- Confirm a deliberate GDScript error produces the expected URI, range, severity, and message signal.
- Confirm completion at a known position contains an expected member.
- Confirm hover, signature help, and document symbols return known fixture data.
- Confirm native lookup for `Sprite2D` returns engine documentation.
- Confirm workspace symbols return `feature_disabled` on Godot 4.6.
- Confirm no-service behavior returns `not_connected` with an actionable command.
- Confirm opt-in headless hosting launches, serves a request, and tears down its owned child.

### Regression and documentation gates

- Run all server tests, typecheck, build, and documentation integrity checks.
- Run Phase 1 through Phase 3 live and Godot smoke suites.
- Validate architecture diagrams, traceability, and resolved open-question records.
- Keep CI live-Godot behavior fail-closed for missing required PASS markers or compilation failures.

## 12. Documentation Changes

- Document the seven tools and their capability boundaries in the README.
- Document `GODOT_MCP_LSP_AUTO_START`, the LSP port variable, and the exact manual launch command.
- Resolve `Q-002` for Phase 4 without changing the still-separate Phase 6 decision.
- Update the component, dependency, lifecycle, and traceability architecture views to match implemented state ownership.
- Record that Godot 4.6 lacks registered `workspace/symbol` support and that RoboGodot returns `feature_disabled` rather than approximating it.

## 13. Risks and Mitigations

- **Godot LSP capability gaps:** negotiate and gate every tool; preserve stable MCP names without fabricating results.
- **Pushed diagnostics race:** associate waits with synchronization generation/version and declare stale cached results explicitly.
- **TCP parser resource exhaustion:** cap frames, buffers, pending requests, and documents before allocation growth.
- **Reconnect confusion:** tag all pending work and notifications with the connection generation and restore documents before ready.
- **Path escape or link traversal:** use real filesystem containment beneath the configured project root.
- **Unexpected background editor ownership:** disable auto-host by default and terminate only a tracked child.
- **Position mismatch:** expose zero-based UTF-16 positions and validate against exact text without reformatting.
- **Test flakiness:** isolate protocol logic behind deterministic mocks and reserve process/socket timing for bounded live acceptance tests.

## 14. Deliverables

- Reusable LSP transport, session, document synchronization, diagnostics store, and optional host manager.
- Seven read-only MCP tools with bounded schemas and honest capability handling.
- Mock LSP server fixtures and comprehensive protocol tests.
- Live visible-editor and opt-in headless-host acceptance coverage.
- Updated README, configuration documentation, architecture atlas, traceability, and `Q-002` record.
