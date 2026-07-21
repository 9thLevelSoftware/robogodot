# Phase 5 Runtime and Debug Design

**Date:** 2026-07-20  
**Status:** Approved for implementation planning (decisions fixed by [ADR 0003](../../decisions/0003-phase-5-runtime-session.md))

## 1. Objective

Run, observe, debug, and interact with one controlled local Godot **game** process from MCP. Phase 5 is complete when:

- A project can be launched and stopped through public tools with bounded stdout/stderr.
- Incremental output reading works with a stable cursor.
- A runtime bridge can inspect scene state, inject simple input, and capture a screenshot through correlated IPC.
- DAP debug operations work when available, or fail honestly without breaking process/bridge control.
- Teardown leaves no orphan PID, no dangling DAP session, and no session IPC residue.
- Phases 1–4 regressions remain green.

## 2. Scope

### In scope

- `RuntimeSession` coordinator (single session ownership).
- `ProcessRunner` for OS spawn, ring buffer, stop escalation.
- Sequenced **file** runtime bridge under Godot-published `ipcRootAbs`.
- GDScript runtime autoloads: inspect, input, screenshot.
- `DapClient` attach-after-spawn (no independent OS spawn).
- Public MCP tools listed in §7.
- Mock unit tests + live Godot acceptance + architecture/README/CI updates.

### Out of scope

- Local-socket IPC transport (deferred; ADR 0003).
- Phase 7 audit middleware, global mode gate, and cache (log via existing stderr logger only).
- Phase 6 filesystem/export/UID tools.
- Multi-game concurrent sessions (exactly one RuntimeSession at a time in v1).
- Remote/networked game control.

## 3. Dependencies

- **Hard:** Phase 1 config (`GODOT_PATH`, `GODOT_PROJECT_PATH`, `GODOT_DAP_PORT`), logger, structured errors.
- **Hard:** Phase 2 execution contract for bridge injection / bootstrap evaluation (`godot_script_run` / internal exec only as designed).
- **Coordination:** Completed Phases 3–4 as regression baseline; no API dependency on mutation lane or LSP.

## 4. Architecture

### 4.1 Components

| Component | Path (planned) | Responsibility |
|---|---|---|
| `RuntimeSession` | `server/src/runtime/session.ts` | Single coordinator: start/stop, owns ProcessRunner + optional bridge + optional DAP |
| `ProcessRunner` | `server/src/runtime/process.ts` | Spawn, PID, ring buffer, graceful/forced stop |
| `RuntimeBridge` / driver | `server/src/runtime/bridge.ts` | Monotonic IDs, write/read/delete under `ipcRootAbs`, timeouts |
| `DapClient` | `server/src/runtime/dap-client.ts` | DAP framing, initialize, attach, supported requests, teardown |
| Autoloads | `addons/godot_control_mcp/runtime/*.gd` (or injected temp) | Poll IPC, execute inspect/input/screenshot, write responses, publish bootstrap |
| Tools | `server/src/tools/runtime.ts` (split if needed) | Public MCP schemas and handlers |

### 4.2 Session lifecycle

1. `godot_run_project` → RuntimeSession.start({ project, scene?, debug? })
2. ProcessRunner spawns Godot game process (not `--editor` unless required for a documented attach path).
3. Bootstrap: Godot creates `user://.mcp/<sessionId>/`, returns `{ sessionId, ipcRootAbs }` via the non-file bootstrap channel (injection result or stdout sentinel).
4. Host realpath-checks `ipcRootAbs` and stores it on the session.
5. If debug requested and DAP port available: DapClient connects/attaches; on failure mark debug `feature_disabled` without killing the game.
6. Bridge tools operate only while session running and bootstrap complete.
7. `godot_stop_project` / session close: stop process (graceful then force), end DAP, delete session IPC directory contents, clear session state.

### 4.3 File IPC discipline (v1)

Under `ipcRootAbs`:

| Artifact | Writer | Reader | Notes |
|---|---|---|---|
| `req.json` | Host | Autoload | Single outstanding request; host waits for matching response before next write (serialized bridge lane) |
| `resp-<id>.json` | Autoload | Host | Host deletes after successful parse |
| `shot-<id>.png` (or path inside resp) | Autoload | Host | Must stay under `ipcRootAbs` |

Request body (normative shape):

```json
{ "id": 1, "method": "inspect_tree" | "get_node" | "input" | "screenshot", "params": { } }
```

Response body:

```json
{ "id": 1, "ok": true, "result": { } }
// or
{ "id": 1, "ok": false, "error": { "code": "godot_error", "message": "...", "hint": "..." } }
```

Bounds: request/response JSON ≤ 262_144 UTF-8 bytes; screenshot file ≤ configurable cap (default 8 MiB); per-request timeout default 5_000 ms (max 30_000).

## 5. ProcessRunner contract

- Spawn without shell: `godotPath`, args `["--path", projectPath, ...scene]`, stdio pipes, `windowsHide: true`.
- Ring buffer: max N lines and/or max bytes (design defaults: 2000 lines, 1 MiB total); drop oldest with `truncated: true` flag on read.
- `readOutput({ since })` returns `{ lines, next, running, exitCode? }`.
- Stop: SIGTERM / graceful close, wait bound, then force (Windows process tree kill pattern already used by LspHost).
- Only one running process; second start fails with `invalid_args` or `godot_error` until stop.

## 6. DAP contract

- Connect to `127.0.0.1:GODOT_DAP_PORT` (default 6006) after process start when debug mode requested.
- Initialize + attach only; **no second spawn**.
- Supported v1 requests (capability-gated): set breakpoints, stackTrace, scopes, variables, continue, next, stepIn, stepOut, pause.
- Unsupported → `feature_disabled` with hint.
- Disconnect/terminate DAP on session stop without requiring process death first; then stop process.

## 7. Public tool surface (proposed exact names)

| Tool | Annotations | Purpose |
|---|---|---|
| `godot_run_project` | mutating | Start RuntimeSession / game process |
| `godot_stop_project` | mutating | Stop session |
| `godot_project_output` | read-only | Incremental ring-buffer read |
| `godot_runtime_status` | read-only | PID, running, debug attached, bridge ready |
| `godot_runtime_inspect` | read-only | Bridge inspect (tree/node subset) |
| `godot_runtime_input` | mutating | Bridge synthetic input |
| `godot_runtime_screenshot` | read-only* | Bridge capture (`*` may be openWorld if path returned) |
| `godot_debug_breakpoints` | mutating | Set/clear breakpoints |
| `godot_debug_pause` / `godot_debug_continue` / `godot_debug_step` | mutating | Execution control |
| `godot_debug_stack` | read-only | Stack/scopes/variables snapshot |

Exact input/output Zod schemas are fixed in the implementation plan; names above are the Phase 5 public inventory unless review renames before coding. No aliases.

\*Screenshot returns metadata under the session root; it does not write into the Godot project `res://` tree.

## 8. Errors

Reuse existing codes:

- `invalid_args` — bad scene path, cursor, params
- `not_connected` / `editor_required` — only if a tool incorrectly requires the editor plugin; runtime tools should prefer `godot_error` with “game not running” hints when the session is absent
- `timeout` — bridge or DAP deadline
- `feature_disabled` — DAP or method unavailable
- `godot_error` — process crash, bridge error payload, spawn failure
- `blocked_by_policy` — reserved; Phase 7 may apply later

## 9. Testing strategy

### Unit / mock

- ProcessRunner spawn args, ring buffer bounds, stop escalation (injected child).
- Bridge ID correlation, timeout, path jail (reject escape under ipc root).
- DapClient framing and attach-without-spawn.
- RuntimeSession single-PID invariant across run vs debug entry.

### Live Godot 4.6

- Run fixture project, read output containing a known print.
- Bridge inspect returns known node; screenshot returns PNG under session root.
- Stop leaves process exited.
- Debug path: if Godot DAP cooperates, breakpoint + continue; else assert honest `feature_disabled` without killing process tools.
- Teardown: no orphan PID; ipc root removed or emptied.

### Regression

- Full server unit suite, architecture tests, Phase 1–4 live suites, smoke.

## 10. Documentation / architecture updates

- Mark `FLOW-RUN-006` resolved (attach after ProcessRunner spawn).
- Update lifecycle 08c/08d from inferred → implemented.
- README tool inventory and runtime runbook.
- Open questions Q-010/011/012 already resolved via ADR 0003.
- CI: `test:live:phase5` fail-closed when `GODOT_PATH` present.

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Double-spawn | Coordinator + tests assert one PID |
| Wrong user-data path | Godot publishes abs path only |
| Bridge race | Serialize bridge requests; monotonic IDs |
| DAP flakiness | Degrade to process+bridge; capability honesty |
| Orphan processes | Shared terminate helpers; live teardown asserts |
| Injection requires editor | Prefer game-side autoload pack or `--script` bootstrap documented in plan |

## 12. Deliverables

- ADR 0003 (done)
- This design + implementation plan
- `server/src/runtime/*`, tools, autoloads
- Unit + live tests
- Architecture/README/CI updates
- Progress ledger Phase 5 complete entry
