# 02 — Container and Channel Architecture

## Purpose

This primary structural view maps each capability channel to its runtime container and protocol. Exactly five top-level channels live in the TypeScript control plane: Editor mutation, Introspection / API knowledge, Code intelligence, Runtime / debug, and Headless / batch + filesystem. Editor mutation and introspection converge on one editor-plugin WebSocket/JSON-RPC transport; the headless/batch/filesystem channel branches to both spawned Godot processes and guarded project storage.

## Source baseline

- Archive: `C:\Users\dasbl\Downloads\files.zip`
- SHA-256: `0B78D0AC0B0676AEFD31A394ADBB95980B6AC2A6273246840325633CB1F96229`
- Source headings: `00-master-architecture-and-standards.md` — “2. The five channels” and “3. System components”; `phase-01-foundation-and-transport.md`, `phase-02-introspection-and-universal-primitive.md`, `phase-04-code-intelligence-lsp.md`, `phase-05-runtime-and-debug.md`, and `phase-06-batch-filesystem-and-assets.md` — “4. Architecture.”

## Container and channel view

```mermaid
flowchart LR
  accTitle: Godot Control MCP containers and five capability channels
  accDescr: The MCP client reaches a TypeScript server that owns five named channels. Editor mutation and introspection share a localhost WebSocket JSON-RPC editor plugin, while code intelligence, runtime debugging, and headless batch filesystem work use their dedicated Godot mechanisms.

  subgraph MCP_CLIENT_BOUNDARY["MCP client"]
    direction TB
    %% atlas-node: CNT-MCP-CLIENT
    CNT_MCP_CLIENT["CNT-MCP-CLIENT<br/>MCP host / AI client"]
  end

  subgraph TYPESCRIPT_BOUNDARY["TypeScript control plane"]
    direction TB
    %% atlas-node: CNT-TYPESCRIPT-SERVER
    CNT_TYPESCRIPT_SERVER["CNT-TYPESCRIPT-SERVER<br/>godot-control-mcp server<br/>routing + policy + adapters"]

    subgraph FIVE_CHANNELS["Five capability channels"]
      direction TB
      %% atlas-node: CH-EDITOR-MUTATION
      CH_EDITOR_MUTATION["CH-EDITOR-MUTATION<br/>Editor mutation"]
      %% atlas-node: CH-INTROSPECTION
      CH_INTROSPECTION["CH-INTROSPECTION<br/>Introspection / API knowledge"]
      %% atlas-node: CH-CODE-INTELLIGENCE
      CH_CODE_INTELLIGENCE["CH-CODE-INTELLIGENCE<br/>Code intelligence"]
      %% atlas-node: CH-RUNTIME-DEBUG
      CH_RUNTIME_DEBUG["CH-RUNTIME-DEBUG<br/>Runtime / debug"]
      %% atlas-node: CH-HEADLESS-BATCH-FS
      CH_HEADLESS_BATCH_FS["CH-HEADLESS-BATCH-FS<br/>Headless / batch + filesystem"]
    end
  end

  subgraph GODOT_EDITOR_BOUNDARY["Godot editor"]
    direction TB
    %% atlas-node: CNT-EDITOR-PLUGIN
    CNT_EDITOR_PLUGIN["CNT-EDITOR-PLUGIN<br/>Godot editor plugin<br/>shared localhost endpoint"]
    %% atlas-node: SYS-CLASSDB-DOCS
    SYS_CLASSDB_DOCS["SYS-CLASSDB-DOCS<br/>ClassDB + integrated<br/>class-reference docs"]
    %% atlas-node: CNT-GODOT-LSP
    CNT_GODOT_LSP["CNT-GODOT-LSP<br/>Godot language server"]
    %% atlas-node: CNT-GODOT-DAP
    CNT_GODOT_DAP["CNT-GODOT-DAP<br/>Godot debug adapter"]
  end

  subgraph RUNNING_GAME_BOUNDARY["Running game"]
    direction TB
    %% atlas-node: CNT-RUNNING-GAME
    CNT_RUNNING_GAME["CNT-RUNNING-GAME<br/>Godot game process"]
    %% atlas-node: CNT-RUNTIME-AUTOLOADS
    CNT_RUNTIME_AUTOLOADS["CNT-RUNTIME-AUTOLOADS<br/>Constrained runtime<br/>bridge autoloads"]
  end

  subgraph HEADLESS_BOUNDARY["Headless execution"]
    direction TB
    %% atlas-node: CNT-HEADLESS-GODOT
    CNT_HEADLESS_GODOT["CNT-HEADLESS-GODOT<br/>Spawned headless<br/>Godot process"]
  end

  subgraph STORAGE_BOUNDARY["Project storage"]
    direction TB
    %% atlas-node: CNT-PROJECT-STORAGE
    CNT_PROJECT_STORAGE[("CNT-PROJECT-STORAGE<br/>Project-root files + UIDs")]
  end

  subgraph OPTIONAL_SERVICE_BOUNDARY["Optional external service"]
    direction TB
    %% atlas-node: CNT-ASSET-PROVIDER
    CNT_ASSET_PROVIDER["CNT-ASSET-PROVIDER<br/>Credentialed asset provider"]
  end

  %% atlas-flow: FLOW-CH-001
  CNT_MCP_CLIENT -->|"MCP over stdio"| CNT_TYPESCRIPT_SERVER
  %% atlas-flow: FLOW-CH-002
  CNT_TYPESCRIPT_SERVER -->|"route editor mutation"| CH_EDITOR_MUTATION
  %% atlas-flow: FLOW-CH-003
  CNT_TYPESCRIPT_SERVER -->|"WebSocket + JSON-RPC 2.0 on localhost:9200"| CNT_EDITOR_PLUGIN
  %% atlas-flow: FLOW-CH-004
  CNT_TYPESCRIPT_SERVER -->|"route live introspection"| CH_INTROSPECTION
  %% atlas-flow: FLOW-CH-005
  CNT_EDITOR_PLUGIN -->|"query ClassDB and integrated documentation"| SYS_CLASSDB_DOCS
  %% atlas-flow: FLOW-CH-006
  CH_CODE_INTELLIGENCE -->|"LSP JSON-RPC over TCP 6005"| CNT_GODOT_LSP
  %% atlas-flow: FLOW-CH-007
  CH_RUNTIME_DEBUG -->|"spawn and control the game process"| CNT_RUNNING_GAME
  %% atlas-flow: FLOW-CH-008
  CH_RUNTIME_DEBUG -->|"DAP over TCP 6006"| CNT_GODOT_DAP
  %% atlas-flow: FLOW-CH-009
  CH_RUNTIME_DEBUG -->|"correlated user:// file IPC"| CNT_RUNTIME_AUTOLOADS
  %% atlas-flow: FLOW-CH-010
  CH_HEADLESS_BATCH_FS -->|"spawn godot --headless --script"| CNT_HEADLESS_GODOT
  %% atlas-flow: FLOW-CH-011
  CH_HEADLESS_BATCH_FS -->|"guarded project-root file and UID access"| CNT_PROJECT_STORAGE
  %% atlas-flow: FLOW-CH-012
  CH_HEADLESS_BATCH_FS -->|"provider API · protocol unspecified"| CNT_ASSET_PROVIDER
```

## Container and channel outline

| ID | Responsibility | Boundary | Phase owner |
|---|---|---|---|
| `CNT-MCP-CLIENT` | Discovers and invokes public MCP tools, resources, and prompts. | Consumer process | Consumer integration |
| `CNT-TYPESCRIPT-SERVER` | Owns the MCP surface, routing, policy, safety, adapter lifecycle, and structured results. | Local control-plane process | Phases 1–8 |
| `CH-EDITOR-MUTATION` | Carries universal and curated editor-state mutation. | Server-owned channel | Phases 2–3 |
| `CH-INTROSPECTION` | Carries live scene, project, API, and documentation queries. | Server-owned channel | Phase 2 |
| `CH-CODE-INTELLIGENCE` | Carries script diagnostics, symbols, completion, navigation, and edits. | Server-owned channel | Phase 4 |
| `CH-RUNTIME-DEBUG` | Carries process control, output, DAP, and runtime-bridge operations. | Server-owned channel | Phase 5 |
| `CH-HEADLESS-BATCH-FS` | Carries headless execution, batch, filesystem, UID, export, and asset work. | Server-owned channel | Phase 6 |
| `CNT-EDITOR-PLUGIN` | Exposes the shared local editor mutation/introspection endpoint. | Godot editor process | Phase 1 |
| `SYS-CLASSDB-DOCS` | Supplies authoritative engine API metadata and class-reference text. | Godot editor knowledge surface | Phase 2 |
| `CNT-GODOT-LSP` | Implements Godot language-server protocol behavior. | Godot editor service | Phase 4 |
| `CNT-GODOT-DAP` | Implements Godot debug-adapter protocol behavior. | Godot editor service | Phase 5 |
| `CNT-RUNNING-GAME` | Executes the launched project and emits process output. | Child process | Phase 5 |
| `CNT-RUNTIME-AUTOLOADS` | Performs constrained runtime inspection, input, and capture requests. | Running-game process | Phase 5 |
| `CNT-HEADLESS-GODOT` | Executes isolated headless scripts and batch jobs. | Spawned child process | Phase 6 |
| `CNT-PROJECT-STORAGE` | Stores canonical project-root files and UID-backed resources. | Guarded local filesystem | Phases 6–7 |
| `CNT-ASSET-PROVIDER` | Optionally supplies generated assets when configured. | Credentialed external service | Phase 6 |

## Relationship outline

| ID | Relationship | Source heading | Evidence | Phase owner | Consequence |
|---|---|---|---|---|---|
| `FLOW-CH-001` | MCP client → TypeScript server: MCP over stdio. | `phase-01-foundation-and-transport.md` — “4. Architecture” | Explicit | Phase 1 | Public MCP traffic has one local process entry point. |
| `FLOW-CH-002` | Server → Editor mutation: route editor mutation. | `00-master-architecture-and-standards.md` — “2. The five channels” | Explicit | Phases 2–3 | Editor writes use the editor-aware mutation lane. |
| `FLOW-CH-003` | TypeScript server → plugin: shared editor-channel WebSocket + JSON-RPC 2.0 on `localhost:9200`. | `phase-01-foundation-and-transport.md` — “4. Architecture” | Explicit | Phase 1 | Both editor channels reuse one local plugin transport and lifecycle. |
| `FLOW-CH-004` | Server → Introspection / API knowledge: route live introspection. | `00-master-architecture-and-standards.md` — “2. The five channels” | Explicit | Phase 2 | Live reads enter the same editor-aware control boundary as mutation. |
| `FLOW-CH-005` | Plugin → ClassDB/docs: query ClassDB and integrated documentation. | `phase-02-introspection-and-universal-primitive.md` — “4. Architecture” | Explicit | Phase 2 | API answers remain coupled to the active Godot version. |
| `FLOW-CH-006` | Code intelligence → Godot LSP: LSP JSON-RPC over TCP `6005`. | `phase-04-code-intelligence-lsp.md` — “4. Architecture” | Explicit | Phase 4 | The server adapts Godot LSP rather than reimplementing language intelligence. |
| `FLOW-CH-007` | Runtime / debug → game: spawn and control the game process. | `phase-05-runtime-and-debug.md` — “4. Architecture” | Explicit | Phase 5 | Process ownership provides PID, output, stop, and cleanup control. |
| `FLOW-CH-008` | Runtime / debug → Godot DAP: DAP over TCP `6006`. | `phase-05-runtime-and-debug.md` — “4. Architecture” | Explicit | Phase 5 | Debug features depend on Godot's adapter and may degrade independently. |
| `FLOW-CH-009` | Runtime / debug → runtime autoloads: correlated `user://` file IPC. | `phase-05-runtime-and-debug.md` — “4. Architecture” | Explicit | Phase 5 | Runtime requests and responses require correlation, bounds, and cleanup. |
| `FLOW-CH-010` | Headless / batch + filesystem → headless Godot: spawn `godot --headless --script`. | `phase-06-batch-filesystem-and-assets.md` — “4. Architecture” | Explicit | Phase 6 | Batch execution remains isolated in a bounded child process. |
| `FLOW-CH-011` | Headless / batch + filesystem → project storage: guarded project-root file and UID access. | `phase-06-batch-filesystem-and-assets.md` — “4. Architecture” | Explicit | Phases 6–7 | Canonical path checks constrain direct file operations. |
| `FLOW-CH-012` | Headless / batch + filesystem → asset provider: provider API · protocol unspecified. | `phase-06-batch-filesystem-and-assets.md` — “4. Architecture” | Explicit optional boundary; transport unspecified | Phase 6 | Provider use stays feature- and credential-gated without inventing a wire contract. |

## Protocol notes

- Editor mutation and introspection share WebSocket/JSON-RPC; they are distinct capability channels, not distinct transports.
- Headless, batch, and filesystem work is one top-level channel with separate process-spawn and guarded-file mechanisms.
- The provider protocol is unspecified. The provider edge is explicit and optional, and is unrelated to `Q-012`, which concerns the runtime bridge's local-socket/file-IPC fallback.
