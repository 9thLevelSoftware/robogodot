# Phase 3 Curated Editor Mutation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the validated curated Godot editor tool tier, with exactly undoable in-memory mutations, honest lifecycle/persistence commands, and real public-MCP acceptance tests.

**Architecture:** TypeScript tool modules validate and bound public calls, route mutations through one FIFO `MutationLane`, and call narrow authenticated editor RPC commands. Godot `commands/edit.gd` delegates mutation mechanics to `edit_controller.gd`, which validates first and commits exactly one `EditorUndoRedoManager` action with a complete inverse. Lifecycle, read, and persistence commands remain explicit and do not claim UndoRedo semantics.

**Tech Stack:** TypeScript 7, Node.js 22, MCP SDK 1.29, Zod 4, Vitest 4, Godot 4.6.2 GDScript, JSON-RPC over authenticated loopback WebSocket, Godot `EditorUndoRedoManager`.

## Global Constraints

- Public Phase 3 names are exactly the 23 names in the approved design; do not add aliases or a generic Tier A mutation command.
- Every accepted in-memory editor mutation commits exactly one undo action and restores exact prior state with one undo.
- `godot_project_setting_set` must restore both previous value and previous absence or reject with `invalid_args` and a Tier B hint.
- `godot_node_call_method` is deny-by-default and read-only; each allowed method has explicit argument and output validation.
- Scene open/new are lifecycle operations; scene/resource saves are persistence operations and never claim Ctrl-Z reversibility.
- Every bridge request uses `timeoutMs: 15_000` and `maxRequestBytes: 32_768`; the existing timeout does not claim in-process cancellation.
- Caller strings use UTF-8 byte validation: project paths and NodePaths at most 1,024 bytes, node/resource names at most 255 bytes, method/property/signal names at most 256 bytes.
- List pages are at most 500 entries, scene-tree depth at most 32, and public serialized structured output at most 262,144 UTF-8 bytes with explicit truncation or pagination.
- All caller-influenced dictionary lookups are own-property-safe; no inherited JavaScript or GDScript dictionary keys may be treated as data.
- Version-sensitive Godot editor APIs stay in `addons/godot_control_mcp/godot_compat.gd`.
- Preserve all Phase 1 and Phase 2 authentication, frame, Variant, documentation, and execution-policy contracts.

---

## File structure

| File | Responsibility |
|---|---|
| `server/src/mutation/lane.ts` | FIFO serialization and invalidation events for curated mutations. |
| `server/src/tools/curated-shared.ts` | UTF-8 schemas, exact RPC options, response validation, output byte checks, shared annotations. |
| `server/src/tools/node.ts` | Node and scene-instancing public MCP registrations. |
| `server/src/tools/scene.ts` | Scene lifecycle, persistence, current-scene, and bounded-tree tools. |
| `server/src/tools/signal.ts` | Signal list/connect/disconnect tools. |
| `server/src/tools/resource.ts` | Session-scoped resource handle load/create/save tools. |
| `server/src/tools/project.ts` | Project-setting get/set/list tools. |
| `addons/godot_control_mcp/edit_controller.gd` | Validate-first, exactly-one-action mutation implementation. |
| `addons/godot_control_mcp/commands/edit.gd` | Narrow node, signal, resource, project, scene RPC envelopes. |
| `addons/godot_control_mcp/resource_handles.gd` | Opaque authenticated-session resource handles and restart cleanup. |
| `addons/godot_control_mcp/godot_compat.gd` | Godot 4.6.2 editor API wrappers. |
| `tests/fixtures/godot_project/phase3/` | Scratch scenes, sub-scenes, and resource fixtures. |
| `server/tests/phase3-*.test.ts` | Unit, registry, mapping, policy, and public MCP regressions. |
| `server/tests/live-phase3.test.ts` | Real editor public-MCP scene build, persistence, concurrent edits, undo/redo, restart. |
| `tests/godot/phase_3_*.gd` | Focused plugin/controller smoke tests. |

---

### Task 1: Mutation lane and UndoRedo controller foundation

**Files:**
- Create: `server/src/mutation/lane.ts`
- Create: `server/src/tools/curated-shared.ts`
- Create: `server/tests/mutation-lane.test.ts`
- Create: `server/tests/curated-shared.test.ts`
- Create: `addons/godot_control_mcp/edit_controller.gd`
- Modify: `addons/godot_control_mcp/godot_compat.gd`
- Create: `tests/godot/phase_3_edit_controller_smoke.gd`
- Modify: `tests/godot/run-smoke.mjs`

**Interfaces:**
- Produces: `MutationLane.run<T>(tags: readonly InvalidationTag[], work: () => Promise<T>): Promise<T>` and `MutationLane.onInvalidated(listener): () => void`.
- Produces: `callCurated<T>(bridge, method, params, responseSchema): Promise<T>` with the exact 15-second/32,768-byte options.
- Produces: `EditController.add_node`, `rename_node`, `set_property`, `undo`, and `redo` primitives used by later plugin commands.

- [ ] **Step 1: Write failing FIFO and validation tests**

```ts
test("serializes mutations and emits tags after success", async () => {
  const lane = new MutationLane();
  const order: string[] = [];
  const tags: string[][] = [];
  lane.onInvalidated((value) => tags.push([...value]));
  const first = lane.run(["scene", "node:/root/Main/A"], async () => {
    order.push("first:start");
    await Promise.resolve();
    order.push("first:end");
    return 1;
  });
  const second = lane.run(["scene"], async () => { order.push("second"); return 2; });
  await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
  expect(order).toEqual(["first:start", "first:end", "second"]);
  expect(tags).toEqual([["node:/root/Main/A", "scene"], ["scene"]]);
});

test("uses the authenticated frame and timeout bounds", async () => {
  const call = vi.fn().mockResolvedValue({ ok: true });
  await callCurated({ call }, "edit.probe", { value: 1 }, z.object({ ok: z.literal(true) }).strict());
  expect(call).toHaveBeenCalledWith("edit.probe", { value: 1 }, { timeoutMs: 15_000, maxRequestBytes: 32_768 });
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `cd server && npm test -- --run tests/mutation-lane.test.ts tests/curated-shared.test.ts`

Expected: FAIL because `MutationLane` and `callCurated` do not exist.

- [ ] **Step 3: Implement the minimal FIFO lane and shared caller**

```ts
export type InvalidationTag = "scene" | "signals" | "resources" | "project-settings" | `node:${string}`;

export class MutationLane {
  private tail: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(tags: readonly InvalidationTag[]) => void>();
  onInvalidated(listener: (tags: readonly InvalidationTag[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  run<T>(tags: readonly InvalidationTag[], work: () => Promise<T>): Promise<T> {
    const execute = async (): Promise<T> => {
      const value = await work();
      const normalized = [...new Set(tags)].sort();
      for (const listener of this.listeners) listener(normalized);
      return value;
    };
    const result = this.tail.then(execute, execute);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
```

`callCurated` must call `bridge.call(method, params, { timeoutMs: 15_000, maxRequestBytes: 32_768 })`, parse with the supplied strict Zod response schema, measure `JSON.stringify(result)` with `Buffer.byteLength`, and throw `GodotMcpError("godot_error", ...)` for malformed or over-262,144-byte responses.

- [ ] **Step 4: Write a failing real-Godot controller smoke**

The smoke creates `Main`, calls `add_node`, asserts one undo removes it, redo restores it, calls `rename_node` and `set_property`, and verifies one undo per call. It must assert the undo history version increases by exactly one for each accepted mutation and does not change for an invalid target.

Run: `$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; node tests/godot/run-smoke.mjs`

Expected: FAIL because `edit_controller.gd` is absent.

- [ ] **Step 5: Implement the controller foundation**

```gdscript
@tool
extends RefCounted

var _undo: EditorUndoRedoManager

func _init(undo: EditorUndoRedoManager) -> void:
	_undo = undo

func add_node(parent: Node, node: Node, action_name: String) -> Dictionary:
	if not is_instance_valid(parent) or not is_instance_valid(node) or node.get_parent() != null:
		return _failure("Parent and detached node are required.")
	_undo.create_action(action_name)
	_undo.add_do_method(parent, "add_child", node, true)
	_undo.add_do_reference(node)
	_undo.add_undo_method(parent, "remove_child", node)
	_undo.commit_action()
	return {"ok": true}

func undo() -> void:
	_undo.undo()

func redo() -> void:
	_undo.redo()

func _failure(hint: String) -> Dictionary:
	return {"ok": false, "hint": hint}
```

Complete the same validate-before-action pattern for rename and property set. Put `EditorInterface.get_editor_undo_redo()` and any version-sensitive history queries behind `godot_compat.gd`.

- [ ] **Step 6: Run foundation verification**

Run: `cd server && npm test -- --run tests/mutation-lane.test.ts tests/curated-shared.test.ts && npm run typecheck && npm run build`

Run: `$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; node tests/godot/run-smoke.mjs`

Expected: all focused tests and all named Godot smokes PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/mutation server/src/tools/curated-shared.ts server/tests/mutation-lane.test.ts server/tests/curated-shared.test.ts addons/godot_control_mcp/edit_controller.gd addons/godot_control_mcp/godot_compat.gd tests/godot/phase_3_edit_controller_smoke.gd tests/godot/run-smoke.mjs
git commit -m "feat: add curated mutation foundation"
```

---

### Task 2: Undoable node tools

**Files:**
- Create: `server/src/tools/node.ts`
- Create: `server/tests/phase3-node-tools.test.ts`
- Create: `addons/godot_control_mcp/commands/edit.gd`
- Modify: `addons/godot_control_mcp/edit_controller.gd`
- Modify: `addons/godot_control_mcp/plugin.gd`
- Modify: `server/src/server.ts`
- Create: `tests/godot/phase_3_node_smoke.gd`
- Create: `tests/fixtures/godot_project/phase3/node_fixture.tscn`

**Interfaces:**
- Consumes: `MutationLane`, `callCurated`, Phase 2 Variant parser, live object/ClassDB metadata, `EditController`.
- Produces: `registerNodeTools(server, bridge, lane)` registering add/delete/reparent/rename/duplicate/get/set-property/call-method. Task 4 extends this same function with scene instancing.
- Produces RPC methods `edit.node_add`, `edit.node_delete`, `edit.node_reparent`, `edit.node_rename`, `edit.node_duplicate`, `edit.node_get`, `edit.node_set_property`, `edit.node_call_readonly`.

- [ ] **Step 1: Write failing public MCP contract tests**

Assert exact names, strict schemas, UTF-8 bounds, annotations, RPC mappings, malformed response normalization, FIFO calls, and `invalid_args` for unsafe method names. Use an in-memory MCP client and a mocked bridge. The read-only allowlist starts with `get_path`, `get_child_count`, and `is_inside_tree`, with zero arguments for all three.

```ts
await expect(callTool(client, "godot_node_call_method", {
  path: "/root/Main", method: "queue_free", args: [],
})).resolves.toMatchObject({ isError: true, structuredContent: { code: "invalid_args" } });
```

- [ ] **Step 2: Run node contract tests and confirm RED**

Run: `cd server && npm test -- --run tests/phase3-node-tools.test.ts`

Expected: FAIL because the node tool module is missing.

- [ ] **Step 3: Register strict node tools**

Use a byte-refined string schema:

```ts
const utf8 = (label: string, max: number) => z.string().min(1).refine(
  (value) => Buffer.byteLength(value, "utf8") <= max,
  `${label} exceeds ${max} UTF-8 bytes`,
);
const nodePath = utf8("NodePath", 1_024);
const nodeName = utf8("node name", 255);
```

Mutations run inside `lane.run` with scene and affected-node tags. `godot_node_get` and the allowlisted method tool call directly through `callCurated`. Property input accepts the existing Phase 2 JSON Variant representation or literal string, validates against the live node property descriptor in the plugin, and returns `{ ok, path, property, before, after }`.

- [ ] **Step 4: Write failing Godot command and undo tests**

Cover add with initial properties, delete subtree restoration, reparent parent/index/owner/transform restoration, rename path change, duplicate flags, property Variant restoration, stale path with compact tree, prototype-like property names, and invalid operation leaving undo history unchanged.

Run: `$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; node tests/godot/run-smoke.mjs`

Expected: FAIL because edit RPC commands are not registered.

- [ ] **Step 5: Implement node commands and exact inverse operations**

Register the eight `edit.node_*` RPC methods in `plugin.gd`. `commands/edit.gd` must resolve the current edited-scene root, canonicalize `/root/<scene>` paths, inspect actual `get_property_list()`, and build the full inverse before calling `EditController`. Delete must retain the removed subtree; reparent must snapshot parent, index, owner, and global transform for `Node2D`/`Node3D`; duplicate must retain only the new subtree; all added persistent nodes receive the edited scene root as owner recursively when legal.

- [ ] **Step 6: Verify node slice**

Run: `cd server && npm test -- --run tests/phase3-node-tools.test.ts tests/type-parser.test.ts && npm run typecheck && npm run build`

Run: `$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; node tests/godot/run-smoke.mjs`

Expected: node tests and all prior tests PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/tools/node.ts server/src/server.ts server/tests/phase3-node-tools.test.ts addons/godot_control_mcp/commands/edit.gd addons/godot_control_mcp/edit_controller.gd addons/godot_control_mcp/plugin.gd tests/godot/phase_3_node_smoke.gd tests/fixtures/godot_project/phase3/node_fixture.tscn
git commit -m "feat: add undoable node tools"
```

---

### Task 3: Scene lifecycle, bounded tree, and persistence

**Files:**
- Create: `server/src/tools/scene.ts`
- Create: `server/tests/phase3-scene-tools.test.ts`
- Modify: `addons/godot_control_mcp/commands/edit.gd`
- Modify: `addons/godot_control_mcp/godot_compat.gd`
- Modify: `addons/godot_control_mcp/plugin.gd`
- Modify: `server/src/server.ts`
- Create: `tests/godot/phase_3_scene_smoke.gd`

**Interfaces:**
- Produces: `registerSceneTools(server, bridge)` and RPC methods `edit.scene_open`, `edit.scene_new`, `edit.scene_save`, `edit.scene_tree`, `edit.scene_current`.
- Scene-tree input is `{ root?: string, maxDepth?: 1..32, cursor?: string, limit?: 1..500 }`; output is deterministic and at most 262,144 serialized bytes.

- [ ] **Step 1: Write failing scene MCP tests**

Assert all five names, annotations distinguishing reads/lifecycle/persistence, project-relative `res://` paths, explicit `{ overwrite: true }` when saving to an existing different path, stable tree ordering, pagination, and rejection before bridge dispatch for absolute/`..` paths.

- [ ] **Step 2: Confirm RED**

Run: `cd server && npm test -- --run tests/phase3-scene-tools.test.ts`

Expected: FAIL because scene tools are absent.

- [ ] **Step 3: Implement server scene registrations**

`godot_scene_tree` and `godot_scene_current` use read-only annotations. Open/new use `readOnlyHint:false`, `destructiveHint:false`, `idempotentHint:false`, `openWorldHint:false`. Save uses `readOnlyHint:false`, `destructiveHint:true`, `idempotentHint:true`, `openWorldHint:false` and describes persistence as non-undoable.

- [ ] **Step 4: Write failing live scene tests**

Open the fixture, read current/tree, create a new scene, reject discard of unsaved changes unless `{ discardUnsaved: true }`, save to a new `res://phase3/generated_scene.tscn`, reject unconfirmed overwrite, and verify a reloaded scene. Assert lifecycle/save commands do not add UndoRedo history entries.

- [ ] **Step 5: Implement compat-backed editor lifecycle and persistence**

Put edited-scene root lookup, open, new, save, unsaved-state query, and canonical project-relative path validation behind `godot_compat.gd`. Tree traversal must be iterative or depth-bounded, sort children by sibling index, include `{ name, class, path, children }`, stop at the requested depth/limit/byte cap, and return `truncated` plus the next cursor.

- [ ] **Step 6: Verify and commit**

Run: `cd server && npm test -- --run tests/phase3-scene-tools.test.ts && npm run typecheck && npm run build`

Run: `$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; node tests/godot/run-smoke.mjs`

```bash
git add server/src/tools/scene.ts server/src/server.ts server/tests/phase3-scene-tools.test.ts addons/godot_control_mcp/commands/edit.gd addons/godot_control_mcp/godot_compat.gd addons/godot_control_mcp/plugin.gd tests/godot/phase_3_scene_smoke.gd
git commit -m "feat: add curated scene tools"
```

---

### Task 4: Scene instancing and signals

**Files:**
- Modify: `server/src/tools/node.ts`
- Create: `server/src/tools/signal.ts`
- Create: `server/tests/phase3-signal-instance-tools.test.ts`
- Modify: `addons/godot_control_mcp/commands/edit.gd`
- Modify: `addons/godot_control_mcp/edit_controller.gd`
- Modify: `addons/godot_control_mcp/plugin.gd`
- Modify: `server/src/server.ts`
- Create: `tests/godot/phase_3_signal_instance_smoke.gd`
- Create: `tests/fixtures/godot_project/phase3/instanced_child.tscn`

**Interfaces:**
- Produces the completed `godot_scene_instance` node registration.
- Produces `registerSignalTools` and RPC methods `edit.signal_list`, `edit.signal_connect`, `edit.signal_disconnect`.

- [ ] **Step 1: Write failing public tool tests**

Cover exact schemas, callable `{ target, method }`, signal flags, duplicate/missing connection errors, deterministic list pagination, instanced-scene type/path response, and mutation-lane use for connect/disconnect/instance.

- [ ] **Step 2: Confirm RED**

Run: `cd server && npm test -- --run tests/phase3-signal-instance-tools.test.ts`

Expected: FAIL because signal tools and instance mapping are absent.

- [ ] **Step 3: Add strict server mappings**

Signal list is read-only. Connect/disconnect and instance are closed-world mutations with exact affected tags. Reject signal names, callable methods, or resource paths over their byte caps before dispatch.

- [ ] **Step 4: Write failing Godot undo tests**

Verify an instanced PackedScene receives correct owner/editable state, undo removes it, redo restores it; connect captures callable and flags, undo disconnects; disconnect undo restores the exact flags; duplicate connect and missing disconnect leave history unchanged.

- [ ] **Step 5: Implement instance and signal inverses**

Load `PackedScene` only from canonical `res://` paths and reject non-scenes. Resolve signal and callable live, use `Object.get_signal_list()`/`get_signal_connection_list()`, snapshot exact flags, and register `connect`/`disconnect` pairs with the controller.

- [ ] **Step 6: Verify and commit**

Run: `cd server && npm test -- --run tests/phase3-signal-instance-tools.test.ts && npm run typecheck && npm run build`

Run: `$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; node tests/godot/run-smoke.mjs`

```bash
git add server/src/tools/node.ts server/src/tools/signal.ts server/src/server.ts server/tests/phase3-signal-instance-tools.test.ts addons/godot_control_mcp/commands/edit.gd addons/godot_control_mcp/edit_controller.gd addons/godot_control_mcp/plugin.gd tests/godot/phase_3_signal_instance_smoke.gd tests/fixtures/godot_project/phase3/instanced_child.tscn
git commit -m "feat: add scene instancing and signal tools"
```

---

### Task 5: Resource handles and exactly restorable project settings

**Files:**
- Create: `server/src/tools/resource.ts`
- Create: `server/src/tools/project.ts`
- Create: `server/tests/phase3-resource-project-tools.test.ts`
- Create: `addons/godot_control_mcp/resource_handles.gd`
- Modify: `addons/godot_control_mcp/commands/edit.gd`
- Modify: `addons/godot_control_mcp/edit_controller.gd`
- Modify: `addons/godot_control_mcp/godot_compat.gd`
- Modify: `addons/godot_control_mcp/plugin.gd`
- Modify: `server/src/server.ts`
- Create: `tests/godot/phase_3_resource_project_smoke.gd`

**Interfaces:**
- Produces `registerResourceTools`, `registerProjectTools` and their six public tools.
- Produces session handle strings matching `^res_[A-Za-z0-9_-]{22}$`; handles are cleared on plugin exit/re-entry.
- Produces RPC methods `edit.resource_load/create/save` and `edit.project_setting_get/set/list`.

- [ ] **Step 1: Write failing resource/project MCP tests**

Cover opaque handle schemas, allowed resource base classes, canonical save paths, overwrite confirmation, stable project-setting pagination, own-property keys, wrong-version/malformed payloads, and exact annotations. `godot_project_setting_set` must be a mutation-lane call; resource save is persistence and must state that it is not Ctrl-Z reversible.

- [ ] **Step 2: Confirm RED**

Run: `cd server && npm test -- --run tests/phase3-resource-project-tools.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement server registrations**

Resource create accepts an explicit ClassDB class and initial property map validated by the plugin. Save accepts `{ handle, path, overwrite?: boolean }`. Project list accepts `{ prefix?: string, cursor?: string, limit?: 1..500 }`. Project set accepts `{ key, value }` and never exposes a non-undoable bypass.

- [ ] **Step 4: Write failing Godot handle and setting tests**

Load/create/save a resource, reject a forged handle, clear handles on a simulated session reset, reject path escape and unconfirmed overwrite. Set an existing setting and undo its exact value; create an absent setting and undo its exact absence; redo both; force an unsupported restoration fixture and assert rejection before history changes.

- [ ] **Step 5: Implement handles and project-setting restoration**

`resource_handles.gd` owns a dictionary keyed by cryptographically random 128-bit URL-safe identifiers and stores only `Resource` instances. It exposes create/get/clear and never serializes object references. Project-setting do/undo helpers call `ProjectSettings.set_setting`; undo of prior absence passes `null` to remove the key, then both directions call the compat persistence wrapper. Verify the key's post-operation existence/value before returning success; otherwise reject or return `godot_error` without claiming exact undo.

- [ ] **Step 6: Verify and commit**

Run: `cd server && npm test -- --run tests/phase3-resource-project-tools.test.ts && npm run typecheck && npm run build`

Run: `$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; node tests/godot/run-smoke.mjs`

```bash
git add server/src/tools/resource.ts server/src/tools/project.ts server/src/server.ts server/tests/phase3-resource-project-tools.test.ts addons/godot_control_mcp/resource_handles.gd addons/godot_control_mcp/commands/edit.gd addons/godot_control_mcp/edit_controller.gd addons/godot_control_mcp/godot_compat.gd addons/godot_control_mcp/plugin.gd tests/godot/phase_3_resource_project_smoke.gd
git commit -m "feat: add resource and project setting tools"
```

---

### Task 6: Public-MCP end-to-end acceptance, architecture, CI, and documentation

**Files:**
- Create: `server/tests/live-phase3.test.ts`
- Modify: `server/tests/server.test.ts`
- Modify: `server/tests/mcp-stdio.test.ts`
- Modify: `server/package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `docs/architecture/open-questions.md`
- Modify: `docs/architecture/03-phase-dependencies.md`
- Modify: `docs/architecture/04-server-components.md`
- Modify: `docs/architecture/05-editor-mutation-sequence.md`
- Modify: `docs/architecture/07-policy-pipeline.md`
- Modify: `docs/architecture/traceability.md`
- Modify: `docs/architecture/rendered/*.svg`
- Modify: `docs/architecture/rendered/manifest.json`
- Create: `tests/architecture/phase3-review-regressions.test.mjs`

**Interfaces:**
- Produces the final exact inventory of the existing 8 tools plus 23 Phase 3 tools.
- Produces `npm run test:live:phase3` for real public-MCP acceptance.

- [ ] **Step 1: Write failing inventory and live acceptance tests**

The live test launches a copied scratch project, creates an in-memory MCP client connected to `createServer`, and uses only public curated tools to:

1. create/open a scene;
2. add and configure nodes with typed properties;
3. instance a fixture scene;
4. connect a signal;
5. create/save/load a resource;
6. set and read an exactly restorable project setting;
7. issue two concurrent mutations and prove FIFO results;
8. save explicitly and reload for persistence verification;
9. undo every in-memory mutation and verify the initial tree and project-setting absence/value;
10. restart Godot and prove old resource handles fail while normal bridge reconnection succeeds.

Inventory tests assert exactly 31 public names and reject every undocumented alias.

- [ ] **Step 2: Run acceptance tests and confirm RED**

Run: `cd server && npm test -- --run tests/server.test.ts tests/mcp-stdio.test.ts tests/live-phase3.test.ts`

Expected: FAIL until the final inventory, live harness, and package script are complete.

- [ ] **Step 3: Complete assembly and documentation**

Register each tool module once in `createServer` with a single shared `MutationLane`. Document setup, all 23 tools, annotations, lifecycle/persistence versus undo semantics, path and byte limits, safe method allowlist, resource-handle lifetime, project-setting exact-restoration rule, concurrent FIFO behavior, and examples.

Resolve Q-005 as accepted. Update atlas source and traceability to match the implementation; run the repository renderer rather than editing SVGs manually.

- [ ] **Step 4: Update CI**

Add `npm run test:live:phase3` after the existing live acceptance on both pinned Godot 4.6.2 jobs. Keep architecture, full server, typecheck/build, docs integrity, plugin smoke, and existing live acceptance unchanged.

- [ ] **Step 5: Run the full verification matrix**

Run: `node docs/architecture/render.mjs --check`

Run: `node --test tests/architecture/*.test.mjs tests/godot/process-runner.test.mjs`

Run: `cd server && npm test -- --run && npm run typecheck && npm run build && npm run docs:check`

Run: `$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; node tests/godot/run-smoke.mjs`

Run: `$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; cd server; npm run test:live; npm run test:live:phase3`

Expected: zero failures; only documented external-archive or absent-`GODOT_PATH` skips may remain.

- [ ] **Step 6: Inspect the complete branch diff**

Run: `git diff --check 6e13e96..HEAD`

Run: `git status --short`

Expected: no whitespace errors and no unintended/untracked files.

- [ ] **Step 7: Commit**

```bash
git add server/tests/live-phase3.test.ts server/tests/server.test.ts server/tests/mcp-stdio.test.ts server/package.json .github/workflows/ci.yml README.md docs/architecture tests/architecture/phase3-review-regressions.test.mjs
git commit -m "feat: complete phase 3 curated editor tier"
```

## Phase 3 acceptance checklist

- [ ] Exactly 23 documented Phase 3 tools join the existing 8 tools, with no aliases.
- [ ] Every accepted in-memory mutation creates exactly one action and exact undo/redo is proven in real Godot.
- [ ] Lifecycle and persistence commands make no false undo claim and reject unsafe paths/overwrites.
- [ ] Property writes use live metadata plus Phase 2 Variant rules.
- [ ] Generic method access is limited to the explicit read-only allowlist.
- [ ] Project-setting changes restore both prior value and prior absence or reject.
- [ ] Resource handles are opaque, session-scoped, restart-invalidated, and resource-only.
- [ ] Concurrent public mutations serialize FIFO without stale inverse snapshots.
- [ ] Full public-MCP scene-build, save/reload, full-undo, and restart flows pass against Godot 4.6.2.
- [ ] Phase 1/2 tests, architecture, typecheck/build, docs integrity, smoke, and CI structure pass.
