# Godot Control MCP Architecture Atlas Design

| Field | Value |
|---|---|
| Status | Approved design |
| Date | 2026-07-10 |
| Audience | Engineers and AI agents implementing Phases 1–8 |
| Input archive | `C:\Users\dasbl\Downloads\files.zip` |
| Input SHA-256 | `0B78D0AC0B0676AEFD31A394ADBB95980B6AC2A6273246840325633CB1F96229` |

## Purpose

Create a durable, source-backed architecture atlas for `godot-control-mcp`. The atlas must let an engineer or AI agent determine:

- which phase owns a component or behavior;
- which interfaces that phase consumes and produces;
- which execution channel carries a request;
- which safety, concurrency, cache, and observability rules apply; and
- which architectural details remain inconsistent or unspecified in the source plans.

The atlas is an implementation map, not a presentation deck. It favors explicit boundaries, named protocols, phase ownership, and traceable relationships over decorative detail.

## Goals

1. Explain the complete system from MCP client to Godot editor, runtime, headless processes, filesystem, and optional services.
2. Separate the five source-defined capability channels so their mechanisms, protocols, lifecycles, and failure modes remain understandable.
3. Show Phase 1–8 dependencies and the interfaces each phase produces for later work.
4. Document the Tier A curated mutation path and Tier B universal editor-script path without conflating their safety guarantees.
5. Preserve contradictions and necessary inferences instead of silently converting them into source truth.
6. Provide text equivalents and relationship tables so the package remains useful without visual parsing.
7. Keep the source diffable, renderable in common Markdown environments, and exportable to verified SVG.

## Non-goals

- Define new product behavior beyond the supplied plans.
- Produce formal UML XMI/UMLDI or a round-trippable semantic model.
- Generate exhaustive class diagrams for every planned TypeScript and GDScript file.
- Reproduce competitor architectures inside the implementation topology.
- Resolve source contradictions without an explicit product decision.
- Build an interactive diagram editor or architecture explorer.

## Source Baseline

The atlas is derived from the ten Markdown files in the input archive:

- `00-master-architecture-and-standards.md`
- `00-competitive-research.md`
- `phase-01-foundation-and-transport.md`
- `phase-02-introspection-and-universal-primitive.md`
- `phase-03-curated-editor-mutation-tier.md`
- `phase-04-code-intelligence-lsp.md`
- `phase-05-runtime-and-debug.md`
- `phase-06-batch-filesystem-and-assets.md`
- `phase-07-hardening-safety-concurrency-observability.md`
- `phase-08-packaging-resources-prompts-eval-and-production.md`

The archive hash identifies the exact source baseline. Diagram references use source filename and section heading where available. When line numbers are useful, they supplement rather than replace section anchors because Markdown edits can shift line positions.

## Chosen Approach

Use a Mermaid architecture atlas embedded in Markdown.

This is a UML-like documentation product rather than formal UML. C4-style structural views answer architecture questions, sequence diagrams answer runtime-order questions, state diagrams answer lifecycle questions, and activity/dependency diagrams answer policy and phase-flow questions.

Mermaid is preferred because engineers and AI agents can read and modify the canonical source directly. Structurizr DSL plus PlantUML was rejected as the default because it adds a more specialized rendering workflow. The structural-notation fallback is a UML-like component view, still expressed in Mermaid, if the C4-style container view cannot communicate the implementation boundary cleanly. Graphviz DOT is not part of this package; an unreadable Mermaid view must be split or faceted instead of introducing a second source language.

## Package Structure

The implementation creates this package:

```text
docs/architecture/
├── README.md
├── 01-system-context.md
├── 02-container-channels.md
├── 03-phase-dependencies.md
├── 04-server-components.md
├── 05-editor-mutation-sequence.md
├── 06-runtime-debug-sequence.md
├── 07-policy-pipeline.md
├── 08-connection-lifecycles.md
├── traceability.md
├── open-questions.md
├── mermaid-config.json
├── render.mjs
└── rendered/
    ├── 01-system-context.svg
    ├── 02-container-channels.svg
    ├── 03-phase-dependencies.svg
    ├── 04-server-components.svg
    ├── 05-editor-mutation-sequence.svg
    ├── 06-runtime-debug-sequence.svg
    ├── 07-policy-pipeline.svg
    ├── 08a-editor-websocket-lifecycle.svg
    ├── 08b-lsp-lifecycle.svg
    ├── 08c-game-process-lifecycle.svg
    ├── 08d-dap-lifecycle.svg
    └── manifest.json
```

`README.md` is the entry point and reading guide. The numbered files are canonical Mermaid-bearing documentation. The `rendered/` directory contains generated outputs and is not edited by hand.

## Modeling and Notation Contract

### Diagram families

- C4-style system and container views use Mermaid flowcharts with named boundaries.
- Component views use Mermaid flowcharts with explicit responsibility labels.
- Runtime interactions use Mermaid sequence diagrams.
- Connection and process lifecycles use Mermaid `stateDiagram-v2` diagrams.
- Phase and policy flows use layered dependency or activity-like flowcharts.

### Stable identifiers

Every modeled element receives a stable identifier with a family prefix:

- `ACT-*` for people and external actors;
- `SYS-*` for systems and trust boundaries;
- `CNT-*` for deployable/runtime containers;
- `CMP-*` for components;
- `CH-*` for execution channels;
- `PHASE-*` for delivery phases;
- `STATE-*` for lifecycle states;
- `FLOW-*` for relationships; and
- `Q-*` for unresolved questions.

The identifiers appear in traceability tables and, where readability permits, in diagram labels or nearby captions.

Where Mermaid grammar permits it, a node's Mermaid identifier is its stable atlas ID. Every relationship is preceded by a Mermaid comment in the form `%% atlas-flow: FLOW-*`; inferred and unresolved nodes use analogous `%% atlas-node:` comments when their visible syntax cannot carry the ID. These anchors let verification compare the diagrams with `traceability.md` without treating rendered coordinates as semantic data.

### Evidence status

- In flowcharts, a solid relationship is explicit, a dashed relationship labeled `«inferred»` is a necessary inference, and a dotted relationship labeled `? unresolved` is a contradiction or missing decision.
- In sequence diagrams, arrow style retains its normal call, asynchronous-message, or return semantics. Inferred and unresolved messages instead begin with `[INFERRED]` or `[UNRESOLVED]` and include a matching note.
- In state diagrams, transition line style retains lifecycle semantics. Inferred and unresolved transitions begin with `[INFERRED]` or `[UNRESOLVED]`.
- The adjacent relationship table's Evidence column and the textual label are authoritative in every diagram family. Color and line style may reinforce evidence status but never carry it alone.

Every relationship label contains a verb, protocol, data type, event, or outcome. Unlabeled arrows are not allowed in durable views.

### Layout

The structural model is a compound directed graph with dominant left-to-right flow. A layered layout groups the MCP client, TypeScript control plane, Godot editor, running game, headless processes, and project storage into visually subordinate boundaries. Phase dependencies use top-to-bottom flow. Behavioral diagrams preserve chronological top-to-bottom order.

Connectors must not cross through node labels or group titles. Dense cross-cutting controls are modeled as a shared request pipeline rather than repeated edges to every tool. If a view remains dense, it is split or simplified before any text is reduced below a readable size.

Mermaid's pinned renderer is the sole layout owner. If the system/container or phase-dependency view produces excessive crossings or unstable placement, the implementation first changes rank direction, node order, and grouping, then splits the view into focused Mermaid facets. It does not add hand-positioned coordinates or a second diagram language.

## View Specifications

### 01 — System Context

**Question:** Who uses the system, what does it control, and where are the trust boundaries?

Required elements:

- engineer or AI-enabled MCP client;
- `godot-control-mcp` system boundary;
- Godot editor and active project;
- running game;
- project-root filesystem;
- optional external asset provider, clearly outside the core boundary; and
- local, personal-use deployment scope.

The view omits internal server modules, individual tools, and phase dependencies.

### 02 — Container and Channel Architecture

**Question:** Which runtime container carries each capability, and over which protocol?

Required elements:

- MCP client to TypeScript server over MCP/stdio;
- editor mutation through the Godot editor plugin over WebSocket plus JSON-RPC 2.0 on default port `9200`;
- live introspection through that plugin transport into `ClassDB` and integrated class-reference documentation;
- Godot LSP over TCP on default port `6005`;
- runtime and debug through process control, Godot DAP on default TCP port `6006`, and a bridge using correlated `user://` file IPC, with a local socket marked as a preferred but unspecified alternative;
- headless, batch, filesystem, UID, export, and asset operations, showing process-spawn and guarded file-access mechanisms inside this channel;
- optional asset provider behind a feature and credential boundary.

This is the atlas's primary structural view. It shows the five source-defined capability channels while making clear that editor mutation and introspection share one WebSocket/JSON-RPC transport, and that the headless/batch/filesystem channel uses more than one mechanism. It does not expand all internal components.

### 03 — Phase Dependencies

**Question:** In what order can phases be implemented, and what contract does each phase contribute?

Required elements:

- research and master-plan documentary inputs;
- Phase 1 transport, registry, configuration, logging, errors, and compatibility foundation;
- Phase 2 introspection, typed Variant parsing, execution guard, and universal primitive spine;
- Phase 3 curated Tier A editing and UndoRedo integration;
- Phase 4 LSP client and document synchronization;
- Phase 5 process, DAP, and runtime bridge channels;
- Phase 6 headless, filesystem, UID, export, and optional asset capabilities;
- Phase 7 centralized safety, queue, cache, health, and audit middleware; and
- Phase 8 resources, prompts, packaging, evaluation, and release.

The source disagreement about whether Phases 4–6 require Phase 2 is retained as unresolved rather than normalized.

### 04 — Server and Plugin Components

**Question:** Which components own tool registration, policy, transport, execution, and Godot-version coupling?

Required server-side groups:

- MCP bootstrap and tool/resource/prompt registry;
- Zod input and structured-output contracts;
- safety, queue, cache, audit, and health middleware;
- TypeParser and introspection support;
- WebSocket/JSON-RPC, LSP, DAP, process, runtime IPC, headless, filesystem, UID, export, and asset adapters.

Required plugin-side groups:

- WebSocket server and command router;
- core, introspection, execution, and edit commands;
- `EditController` and `EditorUndoRedoManager` integration;
- runtime bridge autoloads; and
- `godot_compat.gd` as the version-sensitive compatibility boundary.

The view groups tool families rather than showing every tool as a node.

### 05 — Curated Editor Mutation Sequence

**Question:** How does a Tier A mutation become a validated, serialized, undoable Godot edit?

The happy path is:

1. MCP tool call enters the registry.
2. Zod and semantic validation check input, paths, properties, and typed values.
3. Safety middleware evaluates mode and annotations.
4. The mutation enters the single FIFO mutation lane.
5. The WebSocket client sends a correlated JSON-RPC request.
6. The plugin command router invokes the edit command.
7. `EditController` records do/undo operations and commits one undo action.
8. The server invalidates affected cache tags.
9. Audit logging records a redacted outcome.
10. The tool returns structured content.

The diagram includes alternatives for blocked policy, invalid arguments or stale paths, connection loss or timeout, Godot errors, and the documented project-setting undo exception.

### 06 — Runtime and Debug Sequence

**Question:** How does the system launch, observe, debug, interact with, and stop a game?

Required flow:

- spawn or attach to a Godot process;
- capture stdout/stderr into an incremental ring buffer;
- initialize DAP and launch or attach when supported;
- inject or use runtime bridge autoloads;
- allocate a monotonic request ID;
- write, poll, execute, and correlate a runtime IPC response;
- inspect scene/node state, inject input, or capture a screenshot;
- surface a timeout when the game is unavailable; and
- stop gracefully, force if required, terminate DAP, delete bridge files, and clean orphaned processes.

The source does not fully specify DAP/process launch ownership or socket fallback, so those relationships remain marked unresolved.

### 07 — Policy Pipeline

**Question:** Which controls run for every call, and how do read and mutation paths differ?

Required flow:

- mode and MCP annotation gate;
- path and execution guards;
- annotation-driven classification;
- concurrent read path through TTL/tag cache;
- serialized mutation path through FIFO queue, timeout, fairness, backpressure, and watchdog controls;
- handler invocation;
- mutation-driven cache invalidation;
- redacted audit record; and
- stable `{code, message, hint}` error mapping.

Blocked outcomes are shown as audited but marked inferred because the source pipeline and prose are inconsistent. The lack of rollback and the possibility of reads observing in-progress mutations are documented as implementation risks, not invented guarantees.

### 08 — Connection Lifecycles

**Question:** What states and recovery paths must transport and runtime implementations support?

The document contains four focused state diagrams:

1. Editor WebSocket: disconnected, connecting, connected, reconnecting with exponential backoff, and recovered.
2. LSP: disconnected, TCP connected, initializing, ready, document opened/synchronized, dropped/reconnecting, shutdown, and exited.
3. Game process: stopped, starting, running, stopping, exited or crashed, and forced-stop fallback.
4. DAP: disconnected, initialized, launched or attached, running, paused, and terminated.

Inferred lifecycle states are identified in the adjacent text and traceability table.

## Traceability Design

`traceability.md` contains one row for every diagram node and every diagram relationship with these fields:

| Field | Meaning |
|---|---|
| ID | Stable atlas identifier |
| Name | Human-readable element or relationship |
| View | Owning diagram document |
| Evidence | Explicit, inferred, or unresolved |
| Source | Filename and section heading |
| Phase owner | Phase responsible for implementation |
| Consumes | Required prior interface or state |
| Produces | Interface, behavior, or artifact made available |
| Consequence | Concrete implementation requirement |

The atlas does not claim generated relationships are source truth. The archive hash and file list appear in both the atlas README and traceability document. Traceability is bidirectional: every node and relationship in a diagram has exactly one current row, and every row points back to a current diagram element or relationship.

## Open Questions Design

`open-questions.md` records each issue with a stable `Q-*` ID, conflicting source statements, implementation impact, recommended decision when evidence supports one, and the phase that must resolve it.

The initial set covers:

- canonical name for the universal editor-script tool;
- whether Phase 2 is a hard prerequisite for Phases 4–6;
- heartbeat implementation and relationship to `core.ping`;
- editor connection authentication, TLS, and multi-client policy;
- undo behavior for project-setting mutation;
- safety classification of arbitrary headless GDScript;
- whether blocked calls always reach the audit log;
- read consistency while a mutation is in progress;
- export output-path policy;
- DAP versus ProcessRunner launch ownership;
- host resolution of Godot's `user://` runtime IPC path;
- socket negotiation and file-IPC fallback;
- canonical Node.js engine requirement;
- canonical `add-feature-to-scene` prompt name;
- supported Godot minor versions; and
- the Phase 8 reconnect acceptance window.

No issue is silently resolved by the diagrams.

## Error Handling in the Atlas

Behavioral views show error paths only when they change ownership, cleanup, retry, or safety behavior. Stable error codes include `not_connected`, `invalid_args`, `blocked_by_policy`, `timeout`, `godot_error`, and `feature_disabled` where specified.

Every described error includes an actionable message or hint. Transport failures show correlation and reconnect behavior. Runtime failures show cleanup duties. Policy rejection remains distinct from handler failure.

## Accessibility and AI Readability

Each numbered document includes:

- a one-paragraph purpose and key conclusion;
- a Mermaid diagram;
- a structured outline of nodes and relationships;
- explicit evidence labels;
- protocol and phase-owner details; and
- links to the relevant traceability and open-question entries.

Essential meaning never depends on hover, animation, position, or color. Text and strokes must remain readable in grayscale. SVG exports preserve text where the renderer allows it. Dense diagrams use an intrinsic canvas and retain readable labels instead of shrinking to fit a narrow viewport.

## Rendering and Export

Markdown-embedded Mermaid is canonical. Parsing and export use `@mermaid-js/mermaid-cli` version `11.16.0`, invoked through the package's `render.mjs` wrapper. The wrapper extracts Mermaid blocks from the numbered Markdown documents, assigns the specified output filenames, calls the pinned CLI with `mermaid-config.json`, and removes temporary source files after successful export.

`mermaid-config.json` defines the neutral theme, white background, `Arial, sans-serif` font stack, deterministic security and layout settings, and shared visual tokens. `render.mjs` fails when the number or order of diagram blocks no longer matches the declared export map.

SVG is the required export because it preserves crisp, searchable labels. Generated files are written to `docs/architecture/rendered/` with matching base names. `rendered/manifest.json` records, for every SVG, the source Markdown file, diagram-block ordinal, source archive hash, generation date, and renderer/version. Each diagram also supplies an accessible title and description. Export and regeneration commands are documented in the atlas README. PNG and PDF are not required.

## Verification Plan

1. Parse every Mermaid block with the chosen Mermaid renderer.
2. Generate the seven single-view SVG exports and four lifecycle SVG exports without errors.
3. Inspect each SVG for clipped labels, overlaps, unreadable text, uncontrolled crossings, and ambiguous reading order.
4. Check all internal Markdown links and rendered-asset paths.
5. Verify bidirectional completeness: every diagram node and relationship has one current row in `traceability.md`, and every traceability row points to a current diagram node or relationship.
6. Verify that every inferred or unresolved relationship has a textual evidence marker.
7. Verify the required channel protocols and default ports: stdio, WebSocket/JSON-RPC `9200`, LSP `6005`, DAP `6006`, runtime IPC, headless process spawn, and guarded filesystem access.
8. Verify that each phase has documented inputs, outputs, and ownership.
9. Scan for placeholders and unsupported claims.
10. Confirm every SVG has a manifest entry with its source, archive hash, generation date, and pinned renderer version.
11. Confirm the atlas can answer the five questions stated in the Purpose section using either diagrams or adjacent text.

## Acceptance Criteria

- An engineer or AI agent can identify the owning phase and execution channel for any major component.
- The five source-defined capability channels remain distinguishable in the primary container view.
- The Tier A mutation path, runtime/debug path, and global policy path are independently understandable.
- Source truth, inference, and unresolved issues are visually and textually distinguishable.
- All Mermaid source parses and all required SVG assets render.
- No required label is clipped or obscured in the exported diagrams.
- Every diagram has a text summary and relationship outline.
- The package contains no unresolved placeholders such as `TBD` or `TODO`; genuine source gaps appear as stable open questions.
- The documentation remains within the supplied architecture scope and does not invent new product capabilities.

## Implementation Boundary

The next step is to create a detailed implementation plan for this documentation package. Atlas implementation begins only after this specification is reviewed and approved. The plan must preserve the empty repository's existing state, add only documentation and its verification support, and avoid scaffolding the planned Godot MCP product itself.
