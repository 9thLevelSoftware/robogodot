# Phase 5 Runtime and Debug Implementation Plan

> **For agentic workers:** Implement task-by-task with tests first. Do not start coding until [ADR 0003](../../decisions/0003-phase-5-runtime-session.md) and the [Phase 5 design](../specs/2026-07-20-phase-5-runtime-debug-design.md) are accepted (they are).

**Goal:** Deliver one controlled game RuntimeSession with process control, file-IPC bridge, and attach-only DAP behind public MCP tools.

**Architecture:** `RuntimeSession` coordinates `ProcessRunner` (sole OS spawn), `RuntimeBridge` (Godot-published abs IPC root + sequenced files), and `DapClient` (attach, no second spawn). GDScript autoloads execute in-game operations.

**Tech Stack:** TypeScript 7, Node 22, MCP SDK 1.29, Zod 4, Vitest 4, Godot 4.6.2, DAP over TCP, file IPC.

## Global constraints

- Exactly one OS game process per session; DapClient never spawns.
- Host never invents `user://` paths; only Godot-published `ipcRootAbs`.
- File IPC only in v1 (no socket).
- Preserve Phases 1–4 contracts and live suites.
- Bridge requests are serialized; monotonic IDs; bounded payloads and timeouts.
- Public names are exactly those in the design §7 (no aliases).

---

## File structure

| File | Responsibility |
|---|---|
| `server/src/runtime/process.ts` | ProcessRunner |
| `server/src/runtime/bridge.ts` | File IPC driver + path jail |
| `server/src/runtime/dap-client.ts` | DAP client |
| `server/src/runtime/session.ts` | RuntimeSession coordinator |
| `server/src/tools/runtime.ts` | Public MCP tools |
| `addons/godot_control_mcp/runtime/` | Autoload scripts (or injected pack) |
| `server/tests/runtime-*.test.ts` | Unit/mocks |
| `server/tests/live-phase5.test.ts` | Live acceptance |
| `tests/fixtures/godot_project/phase5/` | Sample game fixtures |
| Architecture + README + CI | Evidence updates |

---

### Task 1: ProcessRunner

**Files:** create `server/src/runtime/process.ts`, `server/tests/runtime-process.test.ts`

- [ ] Failing tests: spawn argv, ring buffer truncation, stop graceful→force, single process guard
- [ ] Implement ProcessRunner with injected spawn/terminate
- [ ] `npm test -- --run tests/runtime-process.test.ts`

### Task 2: Runtime bridge file IPC

**Files:** create `server/src/runtime/bridge.ts`, `server/tests/runtime-bridge.test.ts`

- [ ] Failing tests: monotonic IDs, req/resp correlation, timeout, reject path escape outside ipcRootAbs, delete after read
- [ ] Implement driver against a temp directory fixture
- [ ] `npm test -- --run tests/runtime-bridge.test.ts`

### Task 3: Godot autoloads + bootstrap

**Files:** create runtime GDScript under `addons/godot_control_mcp/runtime/`, fixture project wiring, smoke helper

- [ ] Autoloads poll `req.json`, dispatch inspect/input/screenshot, write `resp-<id>.json`
- [ ] Bootstrap publishes `{ sessionId, ipcRootAbs }` (injection result or stdout sentinel — pick one in implementation and document)
- [ ] Focused Godot smoke for bridge round-trip

### Task 4: RuntimeSession coordinator

**Files:** create `server/src/runtime/session.ts`, `server/tests/runtime-session.test.ts`

- [ ] Failing tests: start→bootstrap→bridge; stop cleans process+ipc; second start rejected; debug attach does not call spawn twice
- [ ] Wire ProcessRunner + Bridge; stub DAP seam
- [ ] `npm test -- --run tests/runtime-session.test.ts`

### Task 5: DapClient attach-only

**Files:** create `server/src/runtime/dap-client.ts`, `server/tests/runtime-dap.test.ts`, mock DAP server

- [ ] Framing, initialize, attach, breakpoint/stack/step happy paths
- [ ] Capability miss → structured failure
- [ ] Prove no spawn function is invoked from DapClient
- [ ] `npm test -- --run tests/runtime-dap.test.ts`

### Task 6: Public MCP tools + server wiring

**Files:** create `server/src/tools/runtime.ts`; modify `server/src/server.ts`, inventory tests

- [ ] Register design §7 tools with Zod schemas and annotations
- [ ] Inventory tests update exact public count (38 + Phase 5 tools)
- [ ] `npm test -- --run tests/server.test.ts tests/mcp-stdio.test.ts tests/runtime-*.test.ts`

### Task 7: Live acceptance + CI

**Files:** `server/tests/live-phase5.test.ts`, fixtures, `.github/workflows/ci.yml`, `package.json` script `test:live:phase5`

- [ ] Live: run, output, inspect, screenshot, stop, teardown PID
- [ ] Live: DAP path or honest `feature_disabled`
- [ ] CI invokes live phase5 after phase4 when Godot present

### Task 8: Architecture, README, ledger

**Files:** `docs/architecture/06-*`, `08-*`, traceability, open-questions already ADR-linked, README, `tests/architecture/*` expectations for resolved FLOW-RUN-006, `.superpowers/sdd/progress.md`

- [ ] Replace UNRESOLVED launch ownership with attach-after-spawn wording
- [ ] Regenerate SVGs if Mermaid changes (`node docs/architecture/render.mjs`)
- [ ] Full verification matrix including Phase 1–4 live
- [ ] Progress entry **Phase 5 complete**

---

## Verification gate

```powershell
node --test tests/architecture/*.test.mjs
cd server
npm test -- --run
npm run typecheck
npm run build
$env:GODOT_PATH='…'
node ../tests/godot/run-smoke.mjs
npm run test:live
npm run test:live:phase3
npm run test:live:phase4
npm run test:live:phase5
```

## Stop line before Phase 6

Phase 6 design (Q-002 remainder, Q-009) starts only after this gate is green and the progress ledger records Phase 5 complete.
