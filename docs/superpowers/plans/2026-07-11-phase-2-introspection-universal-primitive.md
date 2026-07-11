# Phase 2 Introspection and Universal Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver authenticated Tier B editor-script execution, live Godot API introspection, and shared Variant parsing.

**Architecture:** Phase 1 remains the transport and MCP foundation. Phase 2 first authenticates one TypeScript client, then adds shared JSON-friendly Variant contracts, guarded server execution, thin plugin execution/introspection commands, and five MCP tools.

**Tech Stack:** Node.js 22+, TypeScript 7, Zod 4, Vitest, Godot 4.6.x GDScript, WebSocket JSON-RPC 2.0.

## Global Constraints

- Public execution tool name is exactly `godot_script_run`; no alias.
- TypeScript owns the 15000 ms response deadline; timeout does not claim cancellation and hints that editor restart may be required.
- Plugin command dispatch requires an authenticated shared token and permits exactly one active control-plane client.
- Default stdout cap is 262144 bytes and truncation is explicit.
- `godot_script_run` annotations are `readOnlyHint:false`, `destructiveHint:true`, `idempotentHint:false`, `openWorldHint:true`.
- Block editor-script execution in `read_only` and `confirm_destructive`. In `full`, always require `allowDangerous:true`; source heuristics are defense-in-depth diagnostics only and never authorization. Return `blocked_by_policy` for mode/capability rejection.
- Keep version-sensitive ClassDB/editor-help access behind `godot_compat.gd`.
- Target Godot 4.6.x and preserve stdout exclusively for MCP.
- Follow TDD and commit every task independently.

---

### Task 1: Authenticated single-client editor transport

**Files:** Modify Phase 1 config/WebSocket/plugin files and tests; create `docs/decisions/0002-phase-2-execution-boundary.md`.

**Interfaces:** Produce `GODOT_MCP_TOKEN`, authenticated JSON-RPC handshake, and one active peer.

- [ ] Write failing server and real-Godot tests for missing/wrong/correct token, command rejection before auth, and second-client rejection.
- [ ] Run focused tests and confirm failures are caused by absent authentication.
- [ ] Implement token resolution, constant-time server comparison where available, authenticated peer state, and single-client ownership.
- [ ] Run focused and full Phase 1 suites; commit `feat: authenticate editor transport`.

### Task 2: Shared Variant parser and serializer parity

**Files:** Create `server/src/util/type-parser.ts`, `addons/godot_control_mcp/util/type_parse.gd`, `tests/fixtures/variant-vectors.json`, and parity tests.

**Interfaces:** Produce `parseVariantLiteral(value)` and JSON-friendly `serializeVariant(value)` with tagged math/object/resource forms.

- [ ] Write shared vectors for JSON scalars, Vector2/3, Color forms, NodePath, Rect2, collections, invalid and ambiguous input.
- [ ] Verify both implementations fail before production code exists.
- [ ] Implement strict parsers/serializers with actionable invalid-argument errors and describe-don't-drop fallback.
- [ ] Run TypeScript and Godot parity tests; commit `feat: add Variant parser parity`.

### Task 3: Guarded editor-script execution contract

**Files:** Create `server/src/exec/guard.ts`, plugin `commands/exec.gd`, execution tests and fixtures.

**Interfaces:** Produce `exec.run` returning `{ok,returnValue,stdout,errors,elapsedMs,truncated}`.

- [ ] Write failing tests for the universal mode/allowDangerous gate, diagnostic-only heuristics, 15000 ms response timeout, aggregate 262144-byte bound, compile/runtime errors, typed return values, logger cleanup, and restart guidance.
- [ ] Implement minimal server guard and transient `__run(args)` plugin execution without claiming cancellation.
- [ ] Run mocked and live Godot execution tests; commit `feat: add guarded editor execution`.

### Task 4: Live ClassDB and documentation introspection

**Files:** Create plugin `commands/introspection.gd`, extend `godot_compat.gd`, and add live/canned tests.

**Interfaces:** Produce `introspection.list_classes`, `describe_class`, `search`, and `class_doc`.

- [ ] Write failing fixture and Godot 4.6 tests for Node metadata, inheritance, members, nonempty official docs, mesh search, unknown class/member errors.
- [ ] Implement normalized ClassDB results and compatibility-shim documentation lookup.
- [ ] Run canned and live tests; commit `feat: add Godot API introspection`.

### Task 5: MCP tools, regression harness, CI, and docs

**Files:** Create `server/src/tools/script.ts`, `server/src/tools/introspection.ts`; modify assembly, README, CI, and acceptance tests.

**Interfaces:** Register exactly `godot_script_run`, `godot_api_list_classes`, `godot_api_describe_class`, `godot_api_search`, `godot_api_class_doc`.

- [ ] Write failing MCP schema/annotation/mapping/error tests and Tier B authoring tasks for node creation, property set, and project-setting read.
- [ ] Register five tools with strict Zod validation and structured outputs; document auth, danger, timeout recovery, and examples.
- [ ] Run architecture, full server, parser parity, live Godot execution/introspection, typecheck/build, and CI structural checks.
- [ ] Commit `feat: complete phase 2 universal primitive`.

## Phase 2 Acceptance

- [ ] Unauthenticated and second clients cannot dispatch commands.
- [ ] Server/plugin Variant vectors match exactly.
- [ ] Execution guard, cap, typed return, errors, and timeout recovery are verified.
- [ ] Node introspection/docs and mesh search match live Godot 4.6.
- [ ] Exactly five Phase 2 tools join the three Phase 1 probes.
- [ ] Tier B authoring regression tasks succeed through the real plugin.
