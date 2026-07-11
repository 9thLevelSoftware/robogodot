# Godot Control MCP Phase 0–1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the approved Phase 0 research decisions and deliver a buildable MCP/stdio server plus a thin Godot 4.6 editor plugin connected by WebSocket JSON-RPC 2.0, exposing three live probe tools.

**Architecture:** Phase 0 is the already-completed research, master architecture, and atlas; this plan records the one Phase 1 transport resolution needed to construct from it. The TypeScript process owns MCP stdio, validation, configuration, errors, logging, tool registration, WebSocket client correlation, heartbeat, and reconnect. The GDScript editor plugin owns a localhost-only TCP/WebSocket server, JSON-RPC dispatch, and the smallest version-coupled core commands.

**Tech Stack:** Node.js 22+, TypeScript 7.0.2, `@modelcontextprotocol/sdk` 1.29.0, Zod 4.4.3, `ws` 8.21.0, Vitest 4.1.10, Godot 4.6.x GDScript, GitHub Actions.

## Global Constraints

- Target Godot 4.6.x; local acceptance uses `C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe`.
- Keep the GDScript plugin thin and isolate version-sensitive editor calls behind `addons/godot_control_mcp/godot_compat.gd`.
- Use MCP stdio only; stdout is reserved exclusively for MCP protocol traffic and every application log goes to stderr.
- Bind the plugin listener to `127.0.0.1` on configurable port `9200` by default.
- Use JSON-RPC 2.0 requests `{jsonrpc:"2.0",id,method,params}` and responses containing exactly one of `result` or `error`.
- The TypeScript WebSocket client owns connection and reconnect. It sends `core.ping` heartbeats and uses exponential reconnect delays `1000, 2000, 4000, 8000, 16000, 32000, 60000` milliseconds, capped at 60000.
- Every tool error exposes stable `code`, human-readable `message`, and actionable `hint`; supported Phase 1 codes are `not_connected`, `editor_required`, `invalid_args`, `godot_error`, and `timeout`.
- Tool names use `godot_<area>_<verb>` and tool annotations declare all four hints honestly.
- Phase 1 includes only `godot_connection_status`, `godot_get_version`, and `godot_ping`; it includes no editor mutation, introspection, LSP, DAP, runtime bridge, or project-file operations.
- Pin production dependency versions exactly; do not use MCP SDK v2 prereleases.
- Follow TDD for every behavior and commit each task independently.

---

## File Map

| Path | Responsibility |
|---|---|
| `docs/decisions/0001-phase-1-transport-lifecycle.md` | Records the client-owned heartbeat/reconnect resolution |
| `server/package.json`, `server/package-lock.json`, `server/tsconfig.json` | Reproducible Node/TypeScript package |
| `server/src/config.ts` | Environment resolution, Godot binary discovery, project-root discovery |
| `server/src/logger.ts` | Structured stderr-only logging |
| `server/src/errors.ts` | Stable application error taxonomy and MCP error conversion |
| `server/src/registry.ts` | Typed registration convention over MCP SDK v1 |
| `server/src/bridge/json-rpc.ts` | JSON-RPC wire types and strict response parsing |
| `server/src/bridge/ws-client.ts` | Connection state, correlation, timeout, heartbeat, reconnect |
| `server/src/tools/core.ts` | Three Phase 1 probe definitions and handlers |
| `server/src/server.ts`, `server/src/index.ts` | Assembly and stdio lifecycle |
| `server/tests/**/*.test.ts` | Unit and protocol tests |
| `addons/godot_control_mcp/**` | Thin editor plugin, WebSocket server, router, core commands, compatibility shim |
| `tests/godot/phase_1_smoke.gd`, `tests/fixtures/godot_project/project.godot` | Headless plugin smoke fixture |
| `.github/workflows/ci.yml` | Architecture, server, and Godot smoke gates |
| `README.md` | Build, enable, configure, test, and MCP-client quickstart |

### Task 1: Phase 0 decision record and server foundation

**Files:**
- Create: `docs/decisions/0001-phase-1-transport-lifecycle.md`
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/src/config.ts`
- Create: `server/src/logger.ts`
- Create: `server/src/errors.ts`
- Create: `server/tests/config.test.ts`
- Create: `server/tests/logger.test.ts`
- Create: `server/tests/errors.test.ts`
- Create: `server/package-lock.json` via `npm install`

**Interfaces:**
- Produces: `resolveConfig(env, cwd, platform, pathValue): ResolvedConfig`, `createLogger(level, sink): Logger`, `GodotMcpError`, `toToolError(error)`.
- `ResolvedConfig` fields: `godotPath?: string`, `projectPath?: string`, `editorHost: "127.0.0.1"`, `editorPort: number`, `lspPort: number`, `dapPort: number`, `mode: "full"|"read_only"|"confirm_destructive"`, `debug: boolean`.

- [ ] **Step 1: Write failing foundation tests**

  Test exact defaults (`9200`, `6005`, `6006`, `full`, debug false), env overrides, nearest-parent `project.godot`, explicit `GODOT_PATH`, Windows executable discovery candidates, invalid integer/mode errors, stderr JSON logging, DEBUG filtering, all five stable Phase 1 error codes, and unknown-error normalization. Inject filesystem/executable probes so tests never depend on the host installation.

- [ ] **Step 2: Run tests and verify red**

  Run: `cd server; npm test -- --run tests/config.test.ts tests/logger.test.ts tests/errors.test.ts`

  Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Add the pinned package and compiler configuration**

  `package.json` must be private ESM, require Node `>=22`, expose `build`, `typecheck`, `test`, `lint` (TypeScript no-emit check), and `start`; pin runtime packages to `@modelcontextprotocol/sdk@1.29.0`, `ws@8.21.0`, `zod@4.4.3`, and dev packages to TypeScript/Vitest/types listed in the header. Compile `src` to `dist` with strict NodeNext settings and source maps.

- [ ] **Step 4: Implement minimal config, logger, and error modules**

  Resolve explicit env first, then injected platform-specific executable candidates; walk upward from `cwd` for `project.godot`. Reject non-integer ports outside `1..65535`. Logger records `{timestamp,level,message,...fields}` through its injected stderr sink and never calls stdout. `GodotMcpError` carries `{code,message,hint,data?}` and `toToolError` returns MCP `{content:[{type:"text",text:JSON.stringify(payload)}],structuredContent:payload,isError:true}`.

- [ ] **Step 5: Run tests and verify green**

  Run: `cd server; npm test -- --run tests/config.test.ts tests/logger.test.ts tests/errors.test.ts; npm run typecheck`

  Expected: all foundation tests pass and TypeScript reports zero errors.

- [ ] **Step 6: Record the Phase 0 transport decision**

  The ADR must state that the TypeScript WebSocket client sends JSON-RPC `core.ping`, declares liveness lost after a configurable heartbeat timeout, rejects pending calls with `not_connected`, and reconnects with the exact capped sequence in Global Constraints. Explain that this resolves the source statement “plugin reconnects” in favor of the topology where the plugin is the server.

- [ ] **Step 7: Commit**

  Run: `git add docs/decisions server && git commit -m "build: establish phase 1 server foundation"`

### Task 2: MCP registry and stdio assembly

**Files:**
- Create: `server/src/registry.ts`
- Create: `server/src/server.ts`
- Create: `server/src/index.ts`
- Create: `server/tests/registry.test.ts`
- Create: `server/tests/server.test.ts`

**Interfaces:**
- Consumes: Task 1 logger and error conversion.
- Produces: `ToolDefinition<Input, Output>`, `registerTool(server, definition)`, `createServer(dependencies): McpServer`, `runServer(): Promise<void>`.

- [ ] **Step 1: Write failing registry and server tests**

  Assert duplicate names are rejected, schemas and all four annotations reach MCP registration, successful handlers emit matching text plus `structuredContent`, `GodotMcpError` becomes an actionable tool error, unknown errors become `godot_error`, the server identifies as `godot-control-mcp` version `0.1.0`, and construction writes nothing to stdout.

- [ ] **Step 2: Verify red**

  Run: `cd server; npm test -- --run tests/registry.test.ts tests/server.test.ts`

  Expected: FAIL because registry and server assembly do not exist.

- [ ] **Step 3: Implement registry and assembly**

  Wrap MCP SDK v1 `McpServer.registerTool`. Require a Zod input object, Zod output object, description, annotations with `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, and an async handler. Keep a `Set<string>` per registry to reject duplicates. Return both JSON text content and the same output object as `structuredContent`. `index.ts` creates `StdioServerTransport`, connects, handles SIGINT/SIGTERM via `server.close()`, logs fatal failures to stderr, and sets a nonzero exit code.

- [ ] **Step 4: Verify green**

  Run: `cd server; npm test -- --run tests/registry.test.ts tests/server.test.ts; npm run build`

  Expected: tests and build pass; stdout capture remains empty.

- [ ] **Step 5: Commit**

  Run: `git add server && git commit -m "feat: add MCP registry and stdio assembly"`

### Task 3: Correlated WebSocket JSON-RPC client

**Files:**
- Create: `server/src/bridge/json-rpc.ts`
- Create: `server/src/bridge/ws-client.ts`
- Create: `server/tests/json-rpc.test.ts`
- Create: `server/tests/ws-client.test.ts`

**Interfaces:**
- Consumes: Task 1 logger and errors.
- Produces: `JsonRpcClient.call<T>(method, params?, opts?): Promise<T>`, `start()`, `stop()`, `getStatus()`, state events `disconnected|connecting|connected|reconnecting`.
- `call` options: `{timeoutMs?: number}`; default `10000`.

- [ ] **Step 1: Write failing JSON-RPC and transport tests**

  Use an injected WebSocket factory and fake timers. Cover strict `jsonrpc:"2.0"`, monotonically increasing numeric IDs, out-of-order correlation, result/error exclusivity, malformed frames ignored with warning, JSON-RPC error mapping, call timeout cleanup, all pending calls rejected on close, connection state order, exact backoff schedule, reset after successful open, no duplicate reconnect timer, `core.ping` heartbeat success, missed heartbeat disconnect, and `stop()` preventing reconnect.

- [ ] **Step 2: Verify red**

  Run: `cd server; npm test -- --run tests/json-rpc.test.ts tests/ws-client.test.ts`

  Expected: FAIL because bridge modules do not exist.

- [ ] **Step 3: Implement strict parsing and lifecycle**

  Treat only text frames containing a JSON object as responses. A response must match a pending ID and contain exactly one of `result` or `error`; log and ignore notifications/unknown IDs. On close, reject pending calls once, clear heartbeat timers, enter reconnecting unless explicitly stopped, and schedule one retry. Heartbeat calls use the same correlation path but cannot overlap. Emit status snapshots containing state, URL, connectedSince, reconnectAttempt, and lastError.

- [ ] **Step 4: Verify green**

  Run: `cd server; npm test -- --run tests/json-rpc.test.ts tests/ws-client.test.ts; npm run typecheck`

  Expected: transport tests pass with no leaked fake timers or unhandled rejections.

- [ ] **Step 5: Commit**

  Run: `git add server && git commit -m "feat: add resilient editor JSON-RPC client"`

### Task 4: Thin Godot editor plugin and router

**Files:**
- Create: `addons/godot_control_mcp/plugin.cfg`
- Create: `addons/godot_control_mcp/plugin.gd`
- Create: `addons/godot_control_mcp/ws_server.gd`
- Create: `addons/godot_control_mcp/command_router.gd`
- Create: `addons/godot_control_mcp/commands/core.gd`
- Create: `addons/godot_control_mcp/godot_compat.gd`
- Create: `tests/fixtures/godot_project/project.godot`
- Create: `tests/fixtures/godot_project/test_scene.tscn`
- Create: `tests/godot/phase_1_smoke.gd`

**Interfaces:**
- Consumes: JSON-RPC contract and default localhost port from Global Constraints.
- Produces: plugin commands `core.ping(params)` and `core.get_version(params)`; `CommandRouter.register_command(name, callable)` and `dispatch(request)`.

- [ ] **Step 1: Write the failing Godot smoke harness**

  The harness instantiates the router and server, asserts duplicate/unknown command errors, sends malformed JSON and valid `core.ping`/`core.get_version` requests over a real localhost WebSocket, verifies IDs are echoed, and quits with exit code 0 only after all assertions. `core.get_version` must return `{engine,plugin,projectPath,connected:true}` and plugin version `0.1.0`.

- [ ] **Step 2: Verify red with Godot 4.6.2**

  Run: `& 'C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe' --headless --path tests/fixtures/godot_project --script ../../godot/phase_1_smoke.gd`

  Expected: nonzero exit because plugin files/classes do not exist.

- [ ] **Step 3: Implement the router and core commands**

  Router validates request object, JSON-RPC version, numeric/string ID, nonempty method, and dictionary params; return `-32700` parse error, `-32600` invalid request, `-32601` method not found, `-32602` invalid params, or `-32603` internal error with actionable `data.hint`. Register each method once. `core.ping` returns `{pong:true}`; `core.get_version` uses `Engine.get_version_info()`, plugin constant `0.1.0`, and `ProjectSettings.globalize_path("res://")`.

- [ ] **Step 4: Implement the localhost WebSocket server**

  Follow the Godot 4.6 `TCPServer` + `WebSocketPeer.accept_stream()` pattern. Listen explicitly on `127.0.0.1`, poll accepted peers from `_process`, accept text packets only, parse JSON, dispatch, and send one JSON response. Close binary-frame callers with unsupported-data status. Stop listening and close peers when the plugin is disabled. `plugin.gd` creates the server node, reads `GODOT_MCP_PORT` when available or uses 9200, registers core commands, and removes the node on exit. Keep `godot_compat.gd` as an intentionally empty `RefCounted` compatibility boundary.

- [ ] **Step 5: Verify green**

  Run the Task 4 Godot command again.

  Expected: exit 0 with explicit PASS lines for router, ping, version, malformed request, and server shutdown.

- [ ] **Step 6: Commit**

  Run: `git add addons tests && git commit -m "feat: add Godot editor bridge plugin"`

### Task 5: Three MCP probe tools and end-to-end assembly

**Files:**
- Create: `server/src/tools/core.ts`
- Modify: `server/src/server.ts`
- Modify: `server/src/index.ts`
- Create: `server/tests/core-tools.test.ts`
- Create: `server/tests/mcp-stdio.test.ts`

**Interfaces:**
- Consumes: `JsonRpcClient`, registry, config, logger, errors, plugin core commands.
- Produces: `godot_connection_status`, `godot_get_version`, `godot_ping`.

- [ ] **Step 1: Write failing tool and MCP protocol tests**

  Mock the bridge for tool tests and spawn the built stdio server for protocol tests. Assert exact empty input schemas, read-only/non-destructive/idempotent/closed-world annotations, structured outputs, live command mapping, disconnected status succeeding without crossing the bridge, disconnected ping/version returning `not_connected` with “open Godot and enable the plugin” hint, tool listing containing exactly three names, and zero non-MCP stdout bytes.

- [ ] **Step 2: Verify red**

  Run: `cd server; npm test -- --run tests/core-tools.test.ts tests/mcp-stdio.test.ts`

  Expected: FAIL because tools are not registered.

- [ ] **Step 3: Implement tools and dependency lifecycle**

  `godot_connection_status` returns the client status snapshot locally. `godot_get_version` calls `core.get_version`; `godot_ping` measures elapsed milliseconds around `core.ping` and returns `{connected:true,pong:true,latencyMs}`. Start the bridge before connecting stdio without blocking on editor availability; stop it during process shutdown. Errors use Task 1 conversion.

- [ ] **Step 4: Verify green**

  Run: `cd server; npm test -- --run tests/core-tools.test.ts tests/mcp-stdio.test.ts; npm run build`

  Expected: tests/build pass and the MCP list-tools response contains exactly three probes.

- [ ] **Step 5: Commit**

  Run: `git add server && git commit -m "feat: expose phase 1 MCP probe tools"`

### Task 6: Live Godot round trip, reconnect, CI, and quickstart

**Files:**
- Create: `server/tests/live-godot.test.ts`
- Create: `.github/workflows/ci.yml`
- Create: `README.md`
- Modify: `server/package.json`

**Interfaces:**
- Consumes: complete Phase 1 server/plugin.
- Produces: repeatable live acceptance command and CI gates.

- [ ] **Step 1: Add opt-in live acceptance test**

  When `GODOT_PATH` is absent, mark the suite skipped with a clear reason. Otherwise create a temporary project containing the addon, launch Godot headless/editor mode, wait for connected status, assert live ping/version, terminate Godot, assert `not_connected`, relaunch, and assert reconnection. Always terminate child processes and remove the temporary project in `finally`.

- [ ] **Step 2: Run the complete local suite**

  Run: `$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; node --test tests/architecture/*.test.mjs; cd server; npm test -- --run; npm run typecheck; npm run build`

  Expected: 83 architecture tests plus all server/plugin/live tests pass; zero failures.

- [ ] **Step 3: Add CI**

  On Windows and Ubuntu, use Node 22, `npm ci`, architecture tests, server tests/typecheck/build, and a pinned Godot 4.6.x setup for plugin smoke. Never download “latest”; make the Godot version a workflow variable.

- [ ] **Step 4: Write quickstart**

  Document requirements, `npm ci && npm run build`, addon copy/enable steps, all Phase 1 env vars, Windows Godot path example, MCP client JSON configuration invoking `server/dist/index.js`, the three probes, troubleshooting for editor/plugin/port/stdout, and exact unit/smoke/live commands. State Phase 1 exclusions explicitly.

- [ ] **Step 5: Final verification and commit**

  Run the Task 6 complete suite, then: `git add .github README.md server tests addons docs/decisions && git commit -m "test: verify phase 1 foundation end to end"`

## Phase 1 Acceptance

- [ ] Architecture baseline remains green.
- [ ] Server installs reproducibly, typechecks, builds, and exposes exactly three tools over stdio.
- [ ] No application log contaminates stdout.
- [ ] Plugin binds only to localhost and answers strict JSON-RPC 2.0 ping/version requests.
- [ ] Calls correlate by ID, time out, and reject cleanly on disconnect.
- [ ] Client heartbeat detects loss and reconnect uses the exact capped delay sequence.
- [ ] Godot 4.6.2 live version/ping round-trip succeeds locally.
- [ ] Editor/process restart demonstrates automatic reconnection.
- [ ] README and CI provide repeatable setup and verification.
