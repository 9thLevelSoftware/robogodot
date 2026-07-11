# Phase 3 Curated Editor Mutation Design

## Status

Approved in design review on 2026-07-11. This specification resolves the Phase 3 ambiguity recorded as architecture question Q-005.

## Objective

Provide a curated Tier A MCP surface for common Godot editor work. Curated mutations are strictly validated, serialized, and represented by exactly one `EditorUndoRedoManager` action so a successful state change is one editor undo away from its prior state. Tier B `godot_script_run` remains the long-tail escape hatch.

An agent must be able to build and modify a scene using curated tools, inspect the result, persist it explicitly, and undo every in-memory mutation back to the initial scene state.

## Accepted boundaries

- A Tier A editor-state mutation is accepted only when its prior state can be restored exactly by one undo action.
- `godot_project_setting_set` is accepted only when undo can restore both the previous value and the previous absence of a key. Unsupported cases return an actionable error directing the caller to Tier B.
- `godot_node_call_method` exposes only a documented read-only allowlist. State-changing methods require a dedicated undoable tool or Tier B execution.
- Scene open/new are editor lifecycle operations. Scene and resource saves are explicit persistence operations. They do not claim Ctrl-Z semantics and are classified and documented separately from Tier A mutations.
- Persistence never silently overwrites an unexpected target. Inputs are project-relative and validated; overwrite intent must be explicit when applicable.
- Phase 3 does not add a generic mutation command, arbitrary method invocation, filesystem tier, runtime control, LSP, or Phase 7's general cache/audit middleware.

## Public tool surface

### Scene lifecycle and reads

- `godot_scene_open`
- `godot_scene_new`
- `godot_scene_save`
- `godot_scene_tree`
- `godot_scene_current`

### Nodes and instancing

- `godot_node_add`
- `godot_node_delete`
- `godot_node_reparent`
- `godot_node_rename`
- `godot_node_duplicate`
- `godot_node_get`
- `godot_node_set_property`
- `godot_node_call_method`
- `godot_scene_instance`

### Signals

- `godot_signal_connect`
- `godot_signal_disconnect`
- `godot_signal_list`

### Resources

- `godot_resource_load`
- `godot_resource_create`
- `godot_resource_save`

Resource creation is in memory until an explicit save.

### Project settings

- `godot_project_setting_get`
- `godot_project_setting_set`
- `godot_project_settings_list`

## Architecture

### TypeScript control plane

Tool implementations are grouped into `tools/scene.ts`, `tools/node.ts`, `tools/signal.ts`, `tools/resource.ts`, and `tools/project.ts`. Each uses strict Zod schemas, UTF-8 byte limits, accurate MCP annotations, and structured output schemas.

A shared mutation dispatcher provides one FIFO lane for curated mutations. It validates the complete request before bridge dispatch, preserves the existing request-frame bound, maps transport and Godot failures into the common error envelope, and emits affected-domain invalidation tags. Reads may proceed concurrently. Persistence and lifecycle commands use explicit validated paths and do not masquerade as undoable actions.

The invalidation interface is a Phase 3 seam, not a cache implementation. Phase 7 may consume its scene, node, resource, signal, and project-setting tags without changing individual tool handlers.

### Godot editor plugin

`commands/edit.gd` is the narrow JSON-RPC command surface. It resolves requests and delegates editor-state changes to `edit_controller.gd`. The controller owns action names, inverse-state snapshots, paired do/undo registration, and committing exactly one action.

All version-sensitive editor calls remain behind `godot_compat.gd`. Direct mutation outside `EditController` is prohibited for curated mutation commands. Read, lifecycle, and persistence helpers remain separate so their semantics are not confused with UndoRedo.

### Mutation sequence

1. Validate the MCP schema, byte limits, tool classification, and typed Variant literals.
2. Resolve the current edited scene, NodePaths, resources, properties, methods, signals, and callables against live Godot state.
3. Capture the complete inverse state before creating an undo action.
4. Reject any unsupported or ambiguous operation before `create_action`.
5. Create one named action, register paired do/undo operations, and commit once.
6. Return structured affected paths and compact before/after data, then emit invalidation tags.

No validation failure may leave a partial action or partially changed editor state.

## Restoration contracts

- **Add and instance:** undo removes the exact added subtree. Do establishes correct scene ownership recursively where required for persistence.
- **Delete:** retain the subtree and restore its parent, sibling index, ownership, and relevant editable state on undo.
- **Reparent:** restore the original parent, sibling index, owner, and transform behavior selected by the request.
- **Rename:** restore the exact prior name and return the canonical post-rename path.
- **Duplicate:** preserve the selected duplication flags and undo only the created duplicate.
- **Property set:** validate the property against the live object property list and ClassDB metadata, parse the Variant using Phase 2 rules, and restore the exact prior Variant value.
- **Signal connect/disconnect:** validate the signal, target callable, flags, and existing connection state; undo restores the exact prior connection state.
- **Project setting set:** snapshot existence and value, persist the do state, and persist the exact undo state. When absence cannot be restored, reject rather than weaken Tier A.

Node targets are resolved at dispatch time. A stale, missing, or ambiguous path returns `godot_error` with a compact current-tree hint when available. All map lookups influenced by caller keys use own-property-safe structures.

## Read, lifecycle, and persistence behavior

`godot_scene_tree` returns a bounded deterministic tree containing names, classes, canonical paths, and children. `godot_node_get`, signal/resource/project reads, and current-scene inspection use stable ordering and bounded pagination or depth where cardinality is unbounded.

`godot_scene_open` and `godot_scene_new` explicitly change editor context but do not create UndoRedo actions. `godot_scene_save` and `godot_resource_save` persist current state and report the canonical project-relative path. Their MCP annotations and descriptions state these lifecycle or persistence effects plainly.

Resource load/create returns a bounded resource handle understood only by this authenticated editor session. Handles are opaque, expire on disconnect or editor restart, and cannot reference arbitrary host objects.

## Safe method allowlist

`godot_node_call_method` is deny-by-default and supports only methods proven read-only for the pinned Godot minor. The allowlist is an explicit data structure with per-method argument and return schemas; it is not derived from caller input or a name pattern. The initial implementation may contain only methods required by acceptance fixtures. Adding a method requires a read-only justification and regression test.

## Errors and limits

All public tools use the established structured error contract:

- `invalid_args` for schema, type, path syntax, unsupported undo, allowlist, and overwrite-intent failures;
- `not_connected` for unavailable authenticated editor transport;
- `timeout` for the TypeScript-owned deadline without a false cancellation claim;
- `godot_error` for live editor resolution or commit failures.

Requests preserve the authenticated bridge frame limit. Tree, list, property, signal, resource, and project-setting results have deterministic count, depth, and serialized-byte ceilings. Truncation is explicit and includes continuation information where pagination applies.

## Testing strategy

Implementation proceeds as reviewed vertical slices:

1. UndoRedo controller, FIFO mutation dispatcher, shared validation, and fixture harness.
2. Node mutation/read tools and scene lifecycle/tree/current/save tools.
3. Scene instancing and signal tools.
4. Resource and project-setting tools plus persistence contracts.

Every tool has a happy path and at least one live error path. Every curated mutation test reads state before, applies one public MCP call, invokes editor undo, and proves exact restoration. Redo is also verified for controller primitives.

Acceptance includes:

- wrong property type, bad path, missing parent, stale path, ambiguous path, unsafe method, duplicate signal, and unsupported exact-undo cases;
- FIFO behavior for two concurrent mutations with no stale snapshot corruption;
- persistence round-trips in an isolated scratch project;
- editor restart invalidating resource handles;
- an agent-style sequence that creates a small scene using only public Tier A tools, verifies its tree and typed properties, saves explicitly, and fully undoes in-memory mutations back to the initial state;
- full Phase 1 and Phase 2 regression suites, TypeScript typecheck/build, architecture checks, and Godot 4.6 smoke tests.

## Documentation and architecture updates

Resolve Q-005 with the exact-restoration rule. Update the architecture atlas, traceability rows, rendered SVGs, README tool inventory, annotations, examples, and CI structural checks. Documentation must distinguish undoable mutations from lifecycle and persistence operations and must not claim that saving is reversible through Ctrl-Z.

## Success criteria

Phase 3 is complete when the public curated surface is registered with strict contracts, real Godot tests prove every accepted editor-state mutation is exactly undoable, concurrent mutations serialize, lifecycle and persistence effects are honest and bounded, the end-to-end curated scene flow passes, and no Phase 1 or Phase 2 contract regresses.
