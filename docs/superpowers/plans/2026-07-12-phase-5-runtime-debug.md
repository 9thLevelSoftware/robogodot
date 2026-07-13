# Phase 5 Runtime and Debug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one bounded runtime feedback loop that can launch, observe, interact with, debug, screenshot, and cleanly stop a Godot 4.6 game through exactly 13 new MCP tools.

**Architecture:** One `RuntimeSessionCoordinator` owns one session and delegates OS process ownership exclusively to `ProcessRunner`, runtime requests to a negotiated-and-locked authenticated bridge, and debug requests to an attach-only `DapClient`. Every subchannel is independently bounded, generation/session scoped, fail-closed, and cleaned in an attempt-all teardown.

**Tech Stack:** TypeScript 7, Node.js 22 `child_process`/`net`/`fs`, MCP SDK 1.29, Zod 4, Vitest 4, DAP JSON-RPC framing, Godot 4.6.2 GDScript `SceneTree` runtime launcher/bridge nodes, authenticated loopback JSON and sequenced file IPC.

## Global Constraints

- `ProcessRunner` is the only OS process launch/ownership/termination authority; DAP attaches and never independently spawns.
- Exactly 13 approved Phase 5 names are added, bringing the public inventory from exactly 38 to exactly 51; no aliases or arbitrary runtime-eval tool.
- One opaque runtime session may be active; every non-launch call validates its session ID and stale handles never control a later session.
- Launch uses an argument array without a shell; stop may signal only the exact tracked child and uses bounded graceful then forced teardown.
- The plugin supplies the canonical absolute `user://` root; the server never derives it from OS conventions.
- Bridge transport is authenticated and selected before the first request: loopback socket preferred, sequenced file IPC fallback, then locked for the session with no switching or replay after send.
- Tokens and unrestricted environment/command/output data never enter MCP results or normal logs.
- DAP/bridge frames, buffers, pending requests, output rings, arguments, paths, trees, properties, stack/scopes/variables, screenshots, files, loops, and deadlines have named finite limits.
- Runtime launcher/bridge scripts expose only bounded scene tree, allowlisted node properties, named/explicit input, and screenshot operations; no caller-provided GDScript evaluation.
- Tool annotations exactly follow the approved design, including `readOnlyHint:false` for screenshot because it creates an ephemeral file and `openWorldHint:true` for all 13 tools.
- Preserve all Phase 1–4 public contracts, tests, process ownership, LSP lifecycle, editor authentication, mutation, and live-test isolation behavior.

---

## File structure

| File | Responsibility |
|---|---|
| `server/src/runtime/limits.ts` | Named process, bridge, DAP, output, tree, variable, screenshot, and deadline bounds. |
| `server/src/runtime/output-ring.ts` | Bounded monotonic stdout/stderr records and incremental cursor/loss contract. |
| `server/src/runtime/process.ts` | Shell-free exact-child launch, listeners, exit metadata, graceful/forced stop, and cleanup. |
| `server/src/runtime/session.ts` | One-session state machine, opaque IDs/secret, launch/stop serialization, stale-handle validation, and attempt-all teardown. |
| `server/src/runtime/bootstrap.ts` | Authenticated plugin call for canonical `user://`, bridge manifest/config creation, child launcher arguments, and session containment. |
| `server/src/runtime/bridge-protocol.ts` | Versioned authenticated envelopes, JSON-safe normalization, and response correlation types. |
| `server/src/runtime/bridge-client.ts` | Socket negotiation, file fallback selection, locked request transport, deadlines, and artifact cleanup. |
| `server/src/runtime/dap-transport.ts` | Independent bounded DAP framing/correlation/event routing. |
| `server/src/runtime/dap-client.ts` | Initialize/attach/configure, capabilities, stopped generations, breakpoints, stepping, stack/scopes/variables, and disconnect. |
| `server/src/tools/runtime.ts` | Three process and four runtime-bridge MCP tools. |
| `server/src/tools/debug.ts` | Six debug MCP tools and bounded result mapping. |
| `addons/godot_control_mcp/commands/runtime.gd` | Canonical `user://` resolution and bridge bootstrap RPC envelope. |
| `addons/godot_control_mcp/runtime/*.gd` | Versioned `SceneTree` runtime launcher, bridge coordinator, and scene/input/screenshot operations. |
| `server/tests/mock-dap.ts`, `server/tests/mock-runtime-bridge.ts` | Recorded bounded peers for deterministic protocol tests. |
| `tests/fixtures/godot_project/phase5/` | Sample scene/scripts proving output, input state, screenshot, and breakpoint inspection. |
| `server/tests/live-phase5.test.ts` | Real public-MCP see/run/debug/stop acceptance in an isolated copied project. |

---

### Task 1: Bounded output ring and exact-child ProcessRunner

**Files:**
- Create: `server/src/runtime/limits.ts`
- Create: `server/src/runtime/output-ring.ts`
- Create: `server/src/runtime/process.ts`
- Create: `server/tests/runtime-output-ring.test.ts`
- Create: `server/tests/runtime-process.test.ts`

**Interfaces:**
- Produces: `OutputRing.append(stream: "stdout" | "stderr", chunk: Uint8Array, at?: number): void` and `read(since: number, limit: number): OutputPage`.
- Produces: `ProcessRunner.start(options: ProcessStartOptions): Promise<ManagedProcess>` and `stop(childId: string): Promise<StopResult>`.
- `ManagedProcess` exposes opaque `childId`, PID, start time, running/exit snapshot, output page, and exact-child lifecycle only; it never exposes the token or mutable `ChildProcess` publicly.

- [ ] **Step 1: Write failing ring tests**

```ts
it("reports overwritten records without changing cursor meaning", () => {
  const ring = new OutputRing({ maxRecords: 3, maxBytes: 64, maxLineBytes: 16 });
  for (const text of ["one\n", "two\n", "three\n", "four\n"]) ring.append("stdout", Buffer.from(text));
  expect(ring.read(0, 10)).toMatchObject({
    records: [{ cursor: 1, text: "two" }, { cursor: 2, text: "three" }, { cursor: 3, text: "four" }],
    next: 4, lost: 1, truncated: false,
  });
});
```

Also test split UTF-8 chunks, CRLF normalization without content rewriting beyond terminators, partial final lines on exit, independent streams, byte eviction, cursor bounds, and record-page truncation.

- [ ] **Step 2: Run ring tests and confirm RED**

Run: `cd server && npm test -- --run tests/runtime-output-ring.test.ts`

Expected: FAIL because the runtime ring does not exist.

- [ ] **Step 3: Implement named limits and the minimal ring**

Use constants: 4,096 records, 1 MiB retained output, 16,384 UTF-8 bytes per line, and pages of 1–500 records. Decode streaming UTF-8 with fatal replacement accounting; never retain an unbounded partial line. Each normalized record is `{cursor, stream, at, text, truncated}`.

- [ ] **Step 4: Write failing exact-process tests**

Inject spawn, terminate-tree, clock, and timers. Prove exact argv and `{shell:false, windowsHide:true}`, spawn throw/error/exit, natural exit clearing, output capture, simultaneous start rejection at runner level, graceful timeout, exact-child force, kill-helper error/stall, PID reuse safety, listener cleanup, and idempotent stop.

```ts
expect(spawn).toHaveBeenCalledWith(godotPath, ["--path", projectPath, "res://phase5/main.tscn"], {
  cwd: projectPath, env: expect.any(Object), shell: false, windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
```

- [ ] **Step 5: Implement `ProcessRunner`**

Validate executable/project/scene before spawn. Store exact child identity before asynchronous readiness. Install lifetime error/exit/output listeners, bound startup to 15 seconds, graceful stop to 5 seconds, force helper to 7 seconds, and attempt listener/output finalization even when termination fails. A natural exit clears the current exact child before any later PID can be signaled.

- [ ] **Step 6: Verify Task 1**

Run: `cd server && npm test -- --run tests/runtime-output-ring.test.ts tests/runtime-process.test.ts && npm run typecheck && npm run build && npm test -- --run`

Expected: focused and full server suites PASS with only existing environment-gated skips.

- [ ] **Step 7: Commit**

```bash
git add server/src/runtime/limits.ts server/src/runtime/output-ring.ts server/src/runtime/process.ts server/tests/runtime-output-ring.test.ts server/tests/runtime-process.test.ts
git commit -m "feat: add managed runtime process control"
```

---

### Task 2: Runtime session coordinator and process MCP tools

**Files:**
- Create: `server/src/runtime/session.ts`
- Create: `server/src/tools/runtime.ts`
- Create: `server/tests/runtime-session.test.ts`
- Create: `server/tests/runtime-process-tools.test.ts`
- Modify: `server/src/server.ts`
- Modify: `server/tests/server.test.ts`
- Modify: `server/tests/mcp-stdio.test.ts`

**Interfaces:**
- Consumes: Task 1 `ProcessRunner`.
- Produces: `RuntimeSessionCoordinator.launch(mode, options)`, `requireSession(sessionId, states?)`, `output(sessionId, since, limit)`, `stop(sessionId)`, `attachBridge`, `attachDap`, and `close`.
- Produces: `RuntimeToolService` structural interface used by `registerRuntimeTools` and later Tasks 5/7.

- [ ] **Step 1: Write failing coordinator state tests**

Cover `idle -> starting -> running -> stopping -> idle`, debug-ready attachment seam, opaque 128-bit session IDs, 256-bit secrets never returned, simultaneous launch coalescing/rejection, stale ID denial, natural process exit, failed launch cleanup, attempt-all stop order, first-error preservation, and shutdown while starting.

```ts
await coordinator.launch("normal", options);
await expect(coordinator.launch("normal", options)).rejects.toMatchObject({ code: "godot_error" });
expect(await coordinator.stop(session.id)).toMatchObject({ sessionId: session.id, graceful: true, forced: false });
await expect(coordinator.output(session.id, 0, 100)).rejects.toMatchObject({ code: "invalid_args" });
```

- [ ] **Step 2: Run coordinator tests and confirm RED**

Run: `cd server && npm test -- --run tests/runtime-session.test.ts`

Expected: FAIL because no coordinator exists.

- [ ] **Step 3: Implement coordinator foundation**

Use explicit states `idle|starting|running|debug_ready|stopping|failed`. Session snapshots are immutable. `stop` blocks new requests, closes DAP then bridge then process, clears secret/handles, and returns to idle even when a cleanup stage fails. Keep bridge and DAP as injected lifecycle seams until later tasks.

- [ ] **Step 4: Write failing public process-tool tests**

Register the three names with strict schemas and exact annotations. Validate optional `res://` scene, arguments maximum 32 entries/1,024 bytes each and 8,192 total bytes, output cursor safe integer, and page limit 1–500. Assert output normalization and stable structured errors through a real in-memory MCP client.

- [ ] **Step 5: Implement and register process tools**

`godot_run_project` is non-read-only/non-idempotent/open-world. `godot_stop_project` is non-read-only/destructive/idempotent/open-world. `godot_run_output` is read-only/non-idempotent/open-world. Always register all three against a disconnected default service when production runtime dependencies are not injected.

- [ ] **Step 6: Verify Task 2**

Run: `cd server && npm test -- --run tests/runtime-session.test.ts tests/runtime-process-tools.test.ts tests/server.test.ts tests/mcp-stdio.test.ts && npm run typecheck && npm run build && npm test -- --run`

Expected: process tools work independently of editor/LSP status; all suites PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/runtime/session.ts server/src/tools/runtime.ts server/src/server.ts server/tests/runtime-session.test.ts server/tests/runtime-process-tools.test.ts server/tests/server.test.ts server/tests/mcp-stdio.test.ts
git commit -m "feat: add runtime session process tools"
```

---

### Task 3: Authenticated bridge bootstrap and canonical session storage

**Files:**
- Create: `server/src/runtime/bootstrap.ts`
- Create: `server/tests/runtime-bootstrap.test.ts`
- Create: `addons/godot_control_mcp/commands/runtime.gd`
- Create: `addons/godot_control_mcp/runtime/bridge_manifest.gd`
- Create: `addons/godot_control_mcp/runtime/runtime_launcher.gd`
- Modify: `addons/godot_control_mcp/command_router.gd`
- Modify: `addons/godot_control_mcp/plugin.gd`
- Modify: `addons/godot_control_mcp/godot_compat.gd`
- Create: `tests/godot/phase_5_bootstrap_smoke.gd`
- Modify: `tests/godot/run-smoke.mjs`

**Interfaces:**
- Consumes: authenticated `CoreBridge.call` and coordinator-generated session ID/token.
- Produces: `RuntimeBootstrap.prepare({sessionId,token,protocolVersion,preferredPort,scene}): Promise<BridgeLaunchConfig>` and `cleanup(config): Promise<void>`.
- Produces plugin RPC `runtime.prepare` returning canonical `userRoot`, canonical `sessionRoot`, manifest version, and verified launcher/bridge resource paths without returning the token.

- [ ] **Step 1: Write failing server bootstrap tests**

Test exact authenticated RPC options, strict response parsing, canonical containment beneath plugin-approved `.mcp`, symlink/junction/session traversal denial, session ID/token bounds, no secret serialization/logging, manifest mismatch, partial prepare cleanup, and idempotent cleanup.

- [ ] **Step 2: Run bootstrap tests and confirm RED**

Run: `cd server && npm test -- --run tests/runtime-bootstrap.test.ts`

Expected: FAIL because `RuntimeBootstrap` does not exist.

- [ ] **Step 3: Implement the server bootstrap boundary**

Call `runtime.prepare` with the existing authenticated 15-second/32-KiB bridge request bounds. Realpath the returned root/session path, require the session directory beneath the approved root, create only a versioned ephemeral config inside it, and write no token to logs or public return values. The config contains the secret but is never returned, logged, or placed in project files. Produce child arguments using `--script res://addons/godot_control_mcp/runtime/runtime_launcher.gd -- --mcp-runtime-config <canonical-config-path>`; the launcher loads the validated requested scene and installs bridge nodes in the child only. Cleanup may remove only that exact canonical session directory.

- [ ] **Step 4: Write failing Godot bootstrap smoke**

The smoke enables the plugin, routes authenticated `runtime.prepare`, asserts `ProjectSettings.globalize_path("user://")` canonicalization, verifies one `.mcp/<session>` directory and versioned bridge manifest, verifies the launcher resource without editing autoload project settings, rejects traversal/token/duplicate-session inputs, and cleans the exact session.

Run: `$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; node tests/godot/run-smoke.mjs`

Expected: FAIL at the new Phase 5 marker.

- [ ] **Step 5: Implement plugin bootstrap**

Put `globalize_path`, launcher-resource verification, and session cleanup behind `godot_compat.gd`. Router command validates own dictionary fields, fixed protocol version, session/token byte bounds, loopback-only endpoint, and returns only canonical path metadata. The minimal `runtime_launcher.gd` extends `SceneTree`, reads/validates the versioned config, loads the contained scene, and exposes a Task 4 bridge-node installation seam. It must not edit `project.godot`, register persistent autoloads, or place the secret in child command-line arguments.

- [ ] **Step 6: Verify Task 3**

Run the focused server test, typecheck/build, and full named Godot smoke command. Expected: all PASS with the new unique Phase 5 bootstrap marker.

- [ ] **Step 7: Commit**

```bash
git add server/src/runtime/bootstrap.ts server/tests/runtime-bootstrap.test.ts addons/godot_control_mcp/commands/runtime.gd addons/godot_control_mcp/runtime/bridge_manifest.gd addons/godot_control_mcp/runtime/runtime_launcher.gd addons/godot_control_mcp/command_router.gd addons/godot_control_mcp/plugin.gd addons/godot_control_mcp/godot_compat.gd tests/godot/phase_5_bootstrap_smoke.gd tests/godot/run-smoke.mjs
git commit -m "feat: add runtime bridge bootstrap"
```

---

### Task 4: Locked bridge transports and GDScript runtime operations

**Files:**
- Create: `server/src/runtime/bridge-protocol.ts`
- Create: `server/src/runtime/bridge-client.ts`
- Create: `server/tests/mock-runtime-bridge.ts`
- Create: `server/tests/runtime-bridge-client.test.ts`
- Create: `addons/godot_control_mcp/runtime/runtime_bridge.gd`
- Modify: `addons/godot_control_mcp/runtime/runtime_launcher.gd`
- Create: `addons/godot_control_mcp/runtime/scene_bridge.gd`
- Create: `addons/godot_control_mcp/runtime/input_bridge.gd`
- Create: `addons/godot_control_mcp/runtime/screenshot_bridge.gd`
- Create: `tests/godot/phase_5_runtime_bridge_smoke.gd`
- Modify: `tests/godot/run-smoke.mjs`

**Interfaces:**
- Consumes: Task 3 `BridgeLaunchConfig`.
- Produces: `RuntimeBridgeClient.connect(config): Promise<"socket"|"file">`, `request<T>(sessionId,method,params,timeoutMs)`, and `close()`.
- Produces exact methods `runtime.scene_tree`, `runtime.get_node`, `runtime.input`, and `runtime.screenshot` in the injected GDScript bridge.

- [ ] **Step 1: Write failing protocol/negotiation tests**

Cover authenticated versioned socket handshake, bounded length frames, partial/coalesced frames, wrong token/session/version, fallback only before first request, immutable selection, no replay, monotonic IDs, max 32 pending, shared 5-second request deadline, stale/duplicate/wrong-session responses, close cancellation, and output normalization without accessors/prototypes.

- [ ] **Step 2: Run bridge tests and confirm RED**

Run: `cd server && npm test -- --run tests/runtime-bridge-client.test.ts`

Expected: FAIL because bridge protocol/client/mock do not exist.

- [ ] **Step 3: Implement socket and file transports**

Use 1-MiB frames, 2-MiB receive buffer, 128-KiB request/response JSON, 32 pending requests, and one monotonic safe-integer ID sequence. Socket handshake has a 3-second shared deadline. File fallback uses same-directory temporary file plus rename to `req-<id>.json`; poll with bounded backoff, read at most 128 KiB, validate, then delete `resp-<id>.json`. Once any request is published, transport can never change.

- [ ] **Step 4: Write failing GDScript bridge smoke**

Create a tiny runtime tree in the harness. Assert authenticated sequential requests; tree depth/node truncation; allowlisted property serialization; action/key/mouse validation; screenshot containment/PNG metadata; stale/wrong token rejection; response bounds; and exact artifact cleanup.

- [ ] **Step 5: Implement narrow GDScript operations**

`runtime_bridge.gd` parses one request at a time on the main thread and delegates. Scene output caps depth 32/nodes 1,000. Properties cap 64 names and JSON-safe scalar/vector/color/node-path forms. Input supports action press/release/press_release, key, and mouse button with hold 0–2,000 ms. Screenshot caps 16 MiB and writes only `.png` beneath the session shots directory.

- [ ] **Step 6: Verify Task 4**

Run focused bridge tests, typecheck/build, full server suite, and named Godot smokes. Expected: PASS with no transport switch/replay or secret output.

- [ ] **Step 7: Commit**

```bash
git add server/src/runtime/bridge-protocol.ts server/src/runtime/bridge-client.ts server/tests/mock-runtime-bridge.ts server/tests/runtime-bridge-client.test.ts addons/godot_control_mcp/runtime tests/godot/phase_5_runtime_bridge_smoke.gd tests/godot/run-smoke.mjs
git commit -m "feat: add locked runtime bridge"
```

---

### Task 5: Four runtime bridge MCP tools

**Files:**
- Modify: `server/src/tools/runtime.ts`
- Create: `server/tests/runtime-bridge-tools.test.ts`
- Modify: `server/src/runtime/session.ts`
- Modify: `server/src/server.ts`
- Modify: `server/tests/server.test.ts`
- Modify: `server/tests/mcp-stdio.test.ts`

**Interfaces:**
- Consumes: Task 4 `RuntimeBridgeClient` attached through the coordinator.
- Produces all seven non-DAP Phase 5 tools and exact normalized outputs.

- [ ] **Step 1: Write failing public runtime-tool tests**

Through an in-memory MCP client, assert schemas, annotations, stale-session rejection, bridge-unavailable behavior, session state, scene tree bounds/truncation, property omissions, input union exclusivity, screenshot realpath/regular-file/PNG signature/dimensions/size/hash containment, and text/structuredContent equality.

- [ ] **Step 2: Run tool tests and confirm RED**

Run: `cd server && npm test -- --run tests/runtime-bridge-tools.test.ts tests/server.test.ts`

Expected: FAIL because four bridge tools are absent.

- [ ] **Step 3: Implement schemas and own-data normalization**

Use session IDs at most 128 bytes, NodePaths 1,024 bytes, property/action names 256 bytes, tree depth 1–32, input hold 0–2,000 ms, and screenshot 16 MiB. Never trust inherited/accessor/proxy payload fields. Declare every truncation/omission and accept a screenshot only after same-handle bounded read, PNG signature/dimension verification, SHA-256, and canonical session containment.

- [ ] **Step 4: Register tools and coordinator bridge attachment**

Add the four exact names after process tools. Annotations follow the design: scene/get-node read-only; input and screenshot non-read-only; all open-world. Session coordinator closes and invalidates the bridge before process termination.

- [ ] **Step 5: Verify Task 5**

Run focused tools, session, server inventory, stdio, full suite, typecheck, and build. Expected: 45 total tools at this intermediate point and no Phase 1–4 regression.

- [ ] **Step 6: Commit**

```bash
git add server/src/tools/runtime.ts server/src/runtime/session.ts server/src/server.ts server/tests/runtime-bridge-tools.test.ts server/tests/server.test.ts server/tests/mcp-stdio.test.ts
git commit -m "feat: expose runtime bridge tools"
```

---

### Task 6: Bounded attach-only DAP client

**Files:**
- Create: `server/src/runtime/dap-transport.ts`
- Create: `server/src/runtime/dap-client.ts`
- Create: `server/tests/mock-dap.ts`
- Create: `server/tests/dap-transport.test.ts`
- Create: `server/tests/dap-client.test.ts`

**Interfaces:**
- Produces: `DapClient.attach(options): Promise<DapReadyState>`, `setBreakpoints`, `continue`, `step`, `stack`, `inspect`, `disconnect`, and event subscription.
- Consumes no spawn interface; it receives host/port/session/process metadata from the coordinator.

- [ ] **Step 1: Write failing DAP framing tests**

Test UTF-8 content length, fragmented/coalesced frames, bounded headers/body/buffer, sequence correlation, response errors, events, 128 pending cap, deadlines, close rejection, listener isolation, and no LSP state sharing.

- [ ] **Step 2: Implement independent DAP transport**

Use 1-MiB frame, 2-MiB buffer, 128 pending, 5-second request defaults, numeric monotonically increasing `seq`, and strict DAP request/response/event envelopes. Fail closed and clear all timers/listeners on protocol violation.

- [ ] **Step 3: Write failing client lifecycle tests**

Assert initialize -> attach -> initialized -> setBreakpoints -> configurationDone order; attach never spawns; advertised capability gates; stopped-generation IDs; threads/stack/scopes/variables pagination; continue/next/stepIn invalidation; process exit/disconnect; attach timeout; and process-plus-bridge degradation metadata.

- [ ] **Step 4: Implement `DapClient`**

Bind every frame/scope/variable reference to `{runtimeSessionId, stoppedGeneration}`. Cap threads 64, frames 256, scopes 64, variables 500/page, names/values/types 8,192 bytes. `inspect` exposes scopes/variables only and never sends `evaluate`. Missing capabilities throw `feature_disabled`.

- [ ] **Step 5: Verify Task 6**

Run: `cd server && npm test -- --run tests/dap-transport.test.ts tests/dap-client.test.ts && npm run typecheck && npm run build && npm test -- --run`

Expected: all DAP and regression tests PASS; mock proves zero spawn calls.

- [ ] **Step 6: Commit**

```bash
git add server/src/runtime/dap-transport.ts server/src/runtime/dap-client.ts server/tests/mock-dap.ts server/tests/dap-transport.test.ts server/tests/dap-client.test.ts
git commit -m "feat: add attach-only Godot DAP client"
```

---

### Task 7: Debug tools and real Godot end-to-end acceptance

**Files:**
- Create: `server/src/tools/debug.ts`
- Create: `server/tests/debug-tools.test.ts`
- Modify: `server/src/runtime/session.ts`
- Modify: `server/src/server.ts`
- Modify: `server/src/index.ts`
- Modify: `server/tests/server.test.ts`
- Modify: `server/tests/mcp-stdio.test.ts`
- Create: `tests/fixtures/godot_project/phase5/main.tscn`
- Create: `tests/fixtures/godot_project/phase5/runtime_fixture.gd`
- Create: `server/tests/live-phase5.test.ts`
- Modify: `server/tests/live-support.ts`
- Modify: `server/tests/live-support.test.ts`
- Modify: `server/package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: coordinator, ProcessRunner, bootstrap/bridge, and DapClient.
- Produces exactly six debug tools, production lifecycle wiring, exact 51-tool inventory, and public-MCP live proof.

- [ ] **Step 1: Write failing debug-tool and inventory tests**

Assert six exact names/schemas/annotations, debug launch uses coordinator process start then DAP attach, breakpoint path containment, stopped-thread/frame/reference validation, step enum, capability failures, bounded stack/variables/truncation, no evaluate, DAP degradation, and exact 51-name inventory.

- [ ] **Step 2: Implement debug tool mapping and production lifecycle**

`godot_debug_launch` owns one shared launch deadline and returns success only at `debug_ready`. Set-breakpoint replaces one contained file's lines. Continue/step invalidate stopped references before request completion is exposed. Stack/inspect own-data normalize all remote payloads. `runServer` constructs runtime dependencies and cleanup order becomes editor bridge, runtime coordinator, LSP client, LSP host, MCP server, with every step attempted and first error rethrown.

- [ ] **Step 3: Add deterministic sample project**

Fixture prints `PHASE5_READY`, contains `RuntimeTarget` with `jump_count`, changes it on `phase5_jump`, renders a fixed 320x180 viewport, and has a known breakpoint line where local `phase5_value = 42`. It must run without C# or external assets.

- [ ] **Step 4: Write live public-MCP acceptance**

Copy the fixture to a per-suite temp project excluding `.godot`, allocate editor/bridge/DAP ports, and use the exact configured Godot executable. Through MCP prove normal run/output/tree/property/input/screenshot/stop, then debug launch/breakpoint/stopped stack/variable `42`/step/continue/stop. Validate PNG signature/dimensions/hash/path containment and exact PID/artifact cleanup in independently attempted finally steps.

- [ ] **Step 5: Run live test and debug actual Godot behavior**

Run: `$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; $env:GODOT_PROJECT_PATH=(Resolve-Path 'tests\fixtures\godot_project').Path; cd server; npm run test:live:phase5`

Expected: 2 public-MCP flows PASS. Any configured-path launch/protocol/assertion/compilation/screenshot/cleanup failure is fatal. Record Godot DAP capability quirks; do not weaken assertions into truthiness.

- [ ] **Step 6: Add fail-closed CI and complete verification**

Add `test:live:phase5` and run it sequentially in the existing Godot job without `continue-on-error`. Run all server tests, typecheck/build, existing live Phase 1/3/4, Phase 5 live, and Godot smokes.

- [ ] **Step 7: Commit**

```bash
git add server/src/tools/debug.ts server/src/runtime/session.ts server/src/server.ts server/src/index.ts server/tests/debug-tools.test.ts server/tests/server.test.ts server/tests/mcp-stdio.test.ts tests/fixtures/godot_project/phase5 server/tests/live-phase5.test.ts server/tests/live-support.ts server/tests/live-support.test.ts server/package.json .github/workflows/ci.yml
git commit -m "feat: complete runtime debug feedback loop"
```

---

### Task 8: Architecture, runbook, decisions, and final integration

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture/02-container-channels.md`
- Modify: `docs/architecture/03-phase-dependencies.md`
- Modify: `docs/architecture/04-server-components.md`
- Modify: `docs/architecture/06-runtime-debug-sequence.md`
- Modify: `docs/architecture/08-connection-lifecycles.md`
- Modify: `docs/architecture/open-questions.md`
- Modify: `docs/architecture/traceability.md`
- Modify: `docs/architecture/rendered/02-container-channels.svg`
- Modify: `docs/architecture/rendered/03-phase-dependencies.svg`
- Modify: `docs/architecture/rendered/04-server-components.svg`
- Modify: `docs/architecture/rendered/06-runtime-debug-sequence.svg`
- Modify: `docs/architecture/rendered/08c-game-process-lifecycle.svg`
- Modify: `docs/architecture/rendered/08d-dap-lifecycle.svg`
- Modify: `docs/architecture/rendered/manifest.json`
- Create: `tests/architecture/phase5-review-regressions.test.mjs`
- Create: `.superpowers/sdd/progress.md`

**Interfaces:**
- Consumes all implemented Phase 5 behavior/evidence.
- Produces exact 13-tool documentation, accepted Q-010/Q-011/Q-012 decisions, implemented runtime/DAP/bridge architecture, regenerated artifacts, and merge-ready evidence.

- [ ] **Step 1: Write failing architecture/runbook assertions**

Assert all 13 names and field-level contracts, exact 51 inventory, annotations, single ProcessRunner owner, plugin-resolved `user://`, pre-request locked transport, no replay, DAP attach-only/no evaluate, session invalidation, exact-child teardown, renderer caveat, config/defaults, and Q-010/Q-011/Q-012 accepted status. Assert Phase 6–8 remain future work.

- [ ] **Step 2: Run architecture tests and confirm RED**

Run: `node --test tests/architecture/*.test.mjs`

Expected: FAIL because Phase 5 remains planned/unresolved in docs.

- [ ] **Step 3: Update README and decisions**

Document exact inputs/outputs/annotations/errors for 13 tools, normal/debug workflows, output cursors, bridge negotiation, DAP support, screenshot paths, safety modes, start/stop commands, and cleanup. Mark Q-010/Q-011/Q-012 accepted exactly as the design states; do not resolve other questions.

- [ ] **Step 4: Update and regenerate architecture**

Change only Phase 5 elements supported by implementation/live evidence from planned/inferred/unresolved to implemented/resolved. Preserve inferred state labels where the source still does not declare them. Run `node docs/architecture/render.mjs` then architecture tests.

- [ ] **Step 5: Run complete fresh matrix**

Run: `cd server && npm test -- --run && npm run typecheck && npm run build && npm run docs:check`

Run: `node --test tests/architecture/*.test.mjs`

Run: `$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; node tests/godot/run-smoke.mjs`

Run all `test:live`, `test:live:phase3`, `test:live:phase4`, and `test:live:phase5` scripts with `GODOT_PROJECT_PATH` set to the fixture project.

Expected: every required suite PASS; only explicitly optional external archive or absent-binary checks may skip; configured Godot failures remain fatal.

- [ ] **Step 6: Finalize SDD evidence and commit**

Record each reviewed task range, focused/full/live evidence, Godot DAP quirks, accepted decisions, and deliberate Phase 6/7 deferrals. Do not mark Phase 5 complete until task review, final whole-branch review, and controller verification pass.

```bash
git add README.md docs/architecture tests/architecture/phase5-review-regressions.test.mjs .superpowers/sdd/progress.md
git commit -m "docs: complete phase 5 integration"
```

- [ ] **Step 7: Request whole-branch review**

Use `superpowers:requesting-code-review` for merge base through HEAD. The reviewer must inspect session/process ownership, exact-child teardown, ring cursor semantics, bridge authentication/negotiation/no-replay, canonical storage containment, DAP attach/capability/reference invalidation, untrusted normalization, screenshot verification, exact 51-tool contracts, live isolation, CI, and architecture traceability.

Fix every Critical/Important finding test-first in one final fix wave, rerun affected and complete matrices, then repeat whole-branch review before offering integration.
