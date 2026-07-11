# Godot Control MCP Architecture Atlas

## Purpose and audience

This atlas gives implementers, reviewers, testers, and release owners a navigable account of the proposed `godot-control-mcp` architecture. Use it to find the owning phase, source section, evidence status, boundary, and consequence of each modeled element. Native Markdown and Mermaid are canonical; the SVG files are generated reading copies.

## Source baseline and archive hash

The baseline is `C:\Users\dasbl\Downloads\files.zip`, pinned at SHA-256 `0B78D0AC0B0676AEFD31A394ADBB95980B6AC2A6273246840325633CB1F96229`. Every numbered view repeats this hash. Rendering is pinned to `@mermaid-js/mermaid-cli@11.16.0`, and `rendered/manifest.json` records export provenance.

## Key architecture conclusion

The TypeScript MCP server is a local control plane, while Godot remains the authoritative executor. Five distinct capability channels use purpose-specific Godot boundaries; editor mutation and introspection deliberately converge on the same editor-plugin WebSocket transport rather than becoming separate connections.

## Reading order

Read the context and primary channel view first, then dependencies and components. Follow with the two end-to-end sequences, policy pipeline, and connection lifecycles. Finish with open questions and traceability when making or reviewing a decision.

## Diagram index

1. [System context](01-system-context.md)
2. [Container and capability channels](02-container-channels.md)
3. [Phase dependencies](03-phase-dependencies.md)
4. [Server components](04-server-components.md)
5. [Editor mutation sequence](05-editor-mutation-sequence.md)
6. [Runtime and debug sequence](06-runtime-debug-sequence.md)
7. [Policy pipeline](07-policy-pipeline.md)
8. [Connection lifecycles](08-connection-lifecycles.md)
9. [Known open questions](open-questions.md)
10. [Architecture traceability](traceability.md)

## Evidence and ID legend

- **Explicit**: stated directly by the source baseline.
- **Inferred**: a necessary projection or organization of explicit source operations; diagrams show `[INFERRED]` text.
- **Unresolved**: the sources leave a choice open; diagrams show `[UNRESOLVED]` and a stable `Q-*` reference when available.
- `ACT-*`, `SYS-*`, `CNT-*`, `CMP-*`, `CH-*`, `PHASE-*`, and `STATE-*` identify modeled elements; `FLOW-*` identifies one relationship, message, or transition. The [traceability table](traceability.md) maps each ID to evidence, source, owner, inputs, outputs, and consequence.

## Five capability channels

1. **Editor mutation** — editor-aware universal and curated writes through the plugin.
2. **Introspection / API knowledge** — live scene, project, ClassDB, and documentation reads through that shared plugin boundary.
3. **Code intelligence** — diagnostics, symbols, completion, navigation, and edits through Godot LSP.
4. **Runtime/debug** — game process control, output, DAP, and constrained runtime bridge operations.
5. **Headless batch/filesystem** — headless jobs, guarded files and UIDs, export, and optional asset-provider work.

## How to use the atlas during each phase

During research and Phase 0, use context, channels, dependencies, and questions to protect scope. In Phases 1–3, use the component, mutation, WebSocket, and policy views for transport and editor contracts. In Phases 4–6, use LSP, runtime/debug, process, DAP, and headless boundaries. In Phases 7–8, use the policy pipeline, traceability, lifecycle failure paths, and open questions to drive hardening, acceptance, and release evidence.

## Rendering and regeneration

Run from the repository root:

```powershell
node docs/architecture/render.mjs --check
node docs/architecture/render.mjs
```

The first command validates contracts without rewriting outputs. The second regenerates all SVGs and their manifest from canonical Mermaid.

## Accessibility and text alternatives

Every Mermaid block has `accTitle` and `accDescr`. Each numbered view also includes prose conclusions and a structured node, participant, relationship, or transition outline. Those adjacent text alternatives are authoritative for readers who cannot use the generated image or distinguish color; evidence status is always textual.

## Known open questions

Decisions not fixed by the source are catalogued under stable identifiers in [Known open questions](open-questions.md). A diagram that depends on one retains its `Q-*` marker and link instead of silently selecting an implementation.

## Verification commands

```powershell
node docs/architecture/render.mjs --check
node docs/architecture/render.mjs
node --test tests/architecture/*.test.mjs
```
