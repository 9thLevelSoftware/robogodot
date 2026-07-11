# 04 — Server and Plugin Components

## Purpose

This component view assigns MCP registration, shared policy, semantic support, execution adapters, plugin dispatch, and Godot-version coupling to concrete code boundaries. It keeps the GDScript plugin thin: stable coordination remains in the TypeScript server, while editor-authoritative and version-sensitive behavior remains in Godot.

## Source baseline

- Archive: `C:\Users\dasbl\Downloads\files.zip`
- SHA-256: `0B78D0AC0B0676AEFD31A394ADBB95980B6AC2A6273246840325633CB1F96229`
- System boundaries: `00-master-architecture-and-standards.md` — “3. System components,” “4. Tech stack (decisions),” and “5. The version-coupling principle (critical constraint).”
- Component layouts: `phase-01-foundation-and-transport.md` through `phase-07-hardening-safety-concurrency-observability.md` — “4. Architecture.”
- MCP resources and prompts: `phase-08-packaging-resources-prompts-eval-and-production.md` — “4. Architecture.”

## Component view

```mermaid
flowchart TB
  accTitle: Godot Control MCP server, plugin, and Godot component boundaries
  accDescr: A top-to-bottom component view with four groups. The MCP surface registers schemas, tools, resources, and prompts. The TypeScript server applies one middleware band and delegates through semantic services or grouped adapters. The GDScript plugin dispatches editor commands. Godot provides live ClassDB metadata while the server supplies pinned offline documentation after a live version gate.

  subgraph MCP_SURFACE["MCP surface"]
    direction TB
    %% atlas-node: CMP-MCP-BOOTSTRAP
    CMP_MCP_BOOTSTRAP["CMP-MCP-BOOTSTRAP<br/>stdio MCP bootstrap<br/>server/index.ts"]
    %% atlas-node: CMP-REGISTRY
    CMP_REGISTRY["CMP-REGISTRY<br/>tool · resource · prompt registry<br/>server/registry.ts"]
    %% atlas-node: CMP-SCHEMA-CONTRACTS
    CMP_SCHEMA_CONTRACTS["CMP-SCHEMA-CONTRACTS<br/>Zod input + structured output"]
    %% atlas-node: CMP-TOOL-FAMILIES
    CMP_TOOL_FAMILIES["CMP-TOOL-FAMILIES<br/>grouped Tier A · Tier B<br/>code · runtime · batch tools"]
    %% atlas-node: CMP-RESOURCE-PROMPT-SURFACES
    CMP_RESOURCE_PROMPT_SURFACES["CMP-RESOURCE-PROMPT-SURFACES<br/>read-only resources<br/>workflow prompts"]
  end

  subgraph TYPESCRIPT_SERVER["TypeScript server"]
    direction TB
    subgraph MIDDLEWARE_BAND["Cross-cutting middleware · one ordered registry band"]
      direction LR
      %% atlas-node: CMP-SAFETY
      CMP_SAFETY["CMP-SAFETY<br/>mode · annotation<br/>path + exec policy"]
      %% atlas-node: CMP-REQUEST-QUEUE
      CMP_REQUEST_QUEUE["CMP-REQUEST-QUEUE<br/>single mutation lane"]
      %% atlas-node: CMP-READ-CACHE
      CMP_READ_CACHE["CMP-READ-CACHE<br/>read cache + invalidation"]
      %% atlas-node: CMP-AUDIT
      CMP_AUDIT["CMP-AUDIT<br/>bounded audit records"]
      %% atlas-node: CMP-HEALTH
      CMP_HEALTH["CMP-HEALTH<br/>channel readiness"]
    end
    %% atlas-node: CMP-SEMANTIC-SERVICES
    CMP_SEMANTIC_SERVICES["CMP-SEMANTIC-SERVICES<br/>TypeParser + introspection support"]
    %% atlas-node: CMP-TRANSPORT-ADAPTERS
    CMP_TRANSPORT_ADAPTERS["CMP-TRANSPORT-ADAPTERS<br/>grouped execution-channel adapters"]
  end

  subgraph GDSCRIPT_PLUGIN["GDScript editor plugin"]
    direction TB
    %% atlas-node: CMP-WS-SERVER
    CMP_WS_SERVER["CMP-WS-SERVER<br/>localhost WebSocket<br/>JSON-RPC 2.0 server"]
    %% atlas-node: CMP-COMMAND-ROUTER
    CMP_COMMAND_ROUTER["CMP-COMMAND-ROUTER<br/>name-to-callable dispatch"]
    %% atlas-node: CMP-CORE-COMMANDS
    CMP_CORE_COMMANDS["CMP-CORE-COMMANDS<br/>version + ping"]
    %% atlas-node: CMP-INTROSPECTION-COMMANDS
    CMP_INTROSPECTION_COMMANDS["CMP-INTROSPECTION-COMMANDS<br/>live API + docs version gate"]
    %% atlas-node: CMP-EXEC-COMMANDS
    CMP_EXEC_COMMANDS["CMP-EXEC-COMMANDS<br/>Tier B editor-script execution"]
    %% atlas-node: CMP-EDIT-COMMANDS
    CMP_EDIT_COMMANDS["CMP-EDIT-COMMANDS<br/>Tier A curated mutations"]
    %% atlas-node: CMP-EDIT-CONTROLLER
    CMP_EDIT_CONTROLLER["CMP-EDIT-CONTROLLER<br/>validated mutation actions"]
    %% atlas-node: CMP-GODOT-COMPAT
    CMP_GODOT_COMPAT["CMP-GODOT-COMPAT<br/>version-sensitive shim<br/>godot_compat.gd"]
  end

  subgraph GODOT_SERVICES_RUNTIME["Godot editor/runtime + pinned knowledge services"]
    direction LR
    %% atlas-node: SYS-EDITOR-APIS
    SYS_EDITOR_APIS["SYS-EDITOR-APIS<br/>EditorInterface services"]
    %% atlas-node: SYS-CLASSDB-DOCS
    SYS_CLASSDB_DOCS["SYS-CLASSDB-DOCS<br/>live ClassDB + server-side<br/>immutable 4.6.2 docs artifact"]
    %% atlas-node: SYS-UNDO-REDO
    SYS_UNDO_REDO["SYS-UNDO-REDO<br/>EditorUndoRedoManager"]
    %% atlas-node: CMP-RUNTIME-AUTOLOADS
    CMP_RUNTIME_AUTOLOADS["CMP-RUNTIME-AUTOLOADS<br/>runtime inspection · input<br/>screenshot bridges"]
  end

  %% atlas-flow: FLOW-CMP-001
  CMP_MCP_BOOTSTRAP -->|"register surfaces"| CMP_REGISTRY
  %% atlas-flow: FLOW-CMP-002
  CMP_REGISTRY -->|"validate structured I/O"| CMP_SCHEMA_CONTRACTS
  %% atlas-flow: FLOW-CMP-003
  CMP_REGISTRY -->|"apply policy gate"| CMP_SAFETY
  %% atlas-flow: FLOW-CMP-004
  CMP_SAFETY -->|"serialize mutations"| CMP_REQUEST_QUEUE
  %% atlas-flow: FLOW-CMP-005
  CMP_SAFETY -->|"cache read-only calls"| CMP_READ_CACHE
  %% atlas-flow: FLOW-CMP-006
  CMP_REGISTRY -->|"record calls"| CMP_AUDIT
  %% atlas-flow: FLOW-CMP-007
  CMP_AUDIT -->|"report status"| CMP_HEALTH
  %% atlas-flow: FLOW-CMP-008
  CMP_REGISTRY -->|"dispatch tools"| CMP_TOOL_FAMILIES
  %% atlas-flow: FLOW-CMP-009
  CMP_REGISTRY -->|"serve resources + prompts"| CMP_RESOURCE_PROMPT_SURFACES
  %% atlas-flow: FLOW-CMP-010
  CMP_TOOL_FAMILIES -->|"parse + introspect"| CMP_SEMANTIC_SERVICES
  %% atlas-flow: FLOW-CMP-011
  CMP_TOOL_FAMILIES -->|"select execution channel"| CMP_TRANSPORT_ADAPTERS
  %% atlas-flow: FLOW-CMP-012
  CMP_TRANSPORT_ADAPTERS -->|"WebSocket + JSON-RPC 2.0"| CMP_WS_SERVER
  %% atlas-flow: FLOW-CMP-013
  CMP_WS_SERVER -->|"dispatch command"| CMP_COMMAND_ROUTER
  %% atlas-flow: FLOW-CMP-014
  CMP_COMMAND_ROUTER -->|"route core"| CMP_CORE_COMMANDS
  %% atlas-flow: FLOW-CMP-015
  CMP_COMMAND_ROUTER -->|"route introspection"| CMP_INTROSPECTION_COMMANDS
  %% atlas-flow: FLOW-CMP-016
  CMP_COMMAND_ROUTER -->|"route Tier B execution"| CMP_EXEC_COMMANDS
  %% atlas-flow: FLOW-CMP-017
  CMP_COMMAND_ROUTER -->|"route Tier A edits"| CMP_EDIT_COMMANDS
  %% atlas-flow: FLOW-CMP-018
  CMP_EDIT_COMMANDS -->|"delegate mutations"| CMP_EDIT_CONTROLLER
  %% atlas-flow: FLOW-CMP-019
  CMP_EDIT_CONTROLLER -->|"create + commit actions"| SYS_UNDO_REDO
  %% atlas-flow: FLOW-CMP-020
  CMP_INTROSPECTION_COMMANDS -->|"query ClassDB + core.get_version-gated offline docs"| SYS_CLASSDB_DOCS
  %% atlas-flow: FLOW-CMP-021
  CMP_COMMAND_ROUTER -->|"isolate version-sensitive calls"| CMP_GODOT_COMPAT
  %% atlas-flow: FLOW-CMP-022
  CMP_GODOT_COMPAT -->|"invoke editor services"| SYS_EDITOR_APIS
  %% atlas-flow: FLOW-CMP-023
  CMP_TRANSPORT_ADAPTERS -->|"sequenced runtime IPC"| CMP_RUNTIME_AUTOLOADS
```

## Grouped tool-family outline

| Family | Responsibility | Planned server boundary |
|---|---|---|
| Tier A curated editing | Validated scene, node, signal, resource, and project mutations. | `tools/scene.ts`, `tools/node.ts`, `tools/signal.ts`, `tools/resource.ts`, and `tools/project.ts` |
| Tier B universal primitive | Guarded editor-script execution plus live API and project introspection. | `tools/script.ts`, `tools/introspection.ts`, `util/type-parser.ts`, and `exec/guard.ts` |
| Code intelligence | LSP diagnostics, completion, symbols, navigation, documentation, and document synchronization. | `tools/lsp.ts` backed by `lsp/client.ts` and optional `lsp/host.ts` |
| Runtime and debug | Child-process lifecycle, output, DAP sessions, and running-game bridge operations. | `runtime/process.ts`, `runtime/dap-client.ts`, and the sequenced runtime IPC driver |
| Batch, filesystem, UID/export, and assets | Headless scripts, import/export, guarded project files, UID work, and optional generation. | `batch/headless.ts`, `batch/export.ts`, `fs/guard.ts`, `fs/tools.ts`, `uid/tools.ts`, and optional `assets/provider.ts` |

## Grouped adapter outline

| Adapter | Mechanism | Planned boundary and ownership |
|---|---|---|
| WebSocket bridge | Local WebSocket plus JSON-RPC 2.0, default port 9200. | `bridge/ws-client.ts` talks to plugin `ws_server.gd`; the plugin remains the editor executor. |
| LSP | Godot LSP JSON-RPC over TCP 6005 with document lifecycle. | `lsp/client.ts`; optional `lsp/host.ts` launches or attaches the editor language server. |
| ProcessRunner | Controlled Godot child process with bounded output and teardown. | `runtime/process.ts` owns launch, capture, stop, and cleanup. |
| DAP | Godot Debug Adapter Protocol over TCP 6006. | `runtime/dap-client.ts` owns request correlation and debug-session state. |
| runtime IPC | Sequenced `user://` request and response files with IDs, timeouts, bounds, and cleanup. | The TypeScript driver addresses `MCPRuntimeBridge`, `MCPInputBridge`, and `MCPScreenshotBridge` autoloads. |
| HeadlessRunner | Temporary script plus `godot --headless --script`, with capture and cleanup. | `batch/headless.ts` owns the process mechanism. |
| FsGuard | Canonical path resolution jailed to configured project roots. | `fs/guard.ts` gates `fs/tools.ts`, UID work, export destinations, and asset placement. |
| UID/export | Project UID maintenance and bounded Godot export invocations. | `uid/tools.ts` and `batch/export.ts` remain behind the guarded batch/filesystem channel. |
| optional AssetProvider | Feature-gated provider interface; transport and credentials stay provider-specific. | `assets/provider.ts` defaults to no-op; `assets/meshy.ts` is an optional implementation. |

## Boundary interpretation

- `server/registry.ts` is the only assembly point for schemas, surfaces, and Phase 7 middleware. Individual tool families do not bypass that band.
- `addons/godot_control_mcp/command_router.gd` dispatches only the four command groups shown. `commands/edit.gd` delegates all mutation mechanics to `edit_controller.gd` and `EditorUndoRedoManager`.
- `addons/godot_control_mcp/godot_compat.gd` is the sole version-sensitive compatibility boundary before `EditorInterface` services. The TypeScript server remains stable across supported Godot minors.
- The runtime autoload route is drawn directly from the grouped adapter node because the source defines a separate running-game mechanism; it does not imply an extra command-router connector.
