# ADR 0002: Phase 2 execution boundary

## Status

Accepted — 2026-07-11

## Decision

- `godot_script_run` is the sole public MCP tool name. `run_editor_script` names the conceptual capability only.
- The TypeScript server enforces the 15-second response deadline. A blocked Godot editor thread cannot be cancelled safely; timeout guidance tells the caller to restart the editor.
- Arbitrary execution is unavailable until the editor connection authenticates with a shared high-entropy token and becomes the single active control-plane client.
- Editor-script execution is blocked in `read_only` and `confirm_destructive`. In `full`, every execution requires the explicit per-request capability flag `allowDangerous:true`. Authorization is source-independent; no deny-list or source heuristic participates in it.
- Live class metadata and search come from the connected editor's `ClassDB` through `godot_compat.gd`. Official class/member text comes from a deterministic offline index generated from Godot `4.6.2-stable` commit `001aa128b1cd80dc4e47e823c360bccf45ed6bad`; the source archive and generator are SHA-256 verified and recorded in the artifact manifest. Documentation lookup first verifies that the connected engine is Godot 4.6.x and otherwise returns `feature_disabled` with upgrade/index guidance.

## Documentation compatibility amendment

Godot 4.6's supported GDScript and GDExtension APIs cannot read integrated class-reference text. `ScriptEditor.goto_help()` only navigates, the extension interface only loads XML, and the official Windows binary does not export private `EditorHelp`, `DocTools`, or `get_doc_data` symbols. A proposed narrow native bridge was therefore rejected at its feasibility gate: it would require a patched engine/private ABI.

The approved fallback bundles only the normalized class and member descriptions needed by `class_doc`, not an engine source tree or binary. Generation may use the network; runtime may not. The immutable full-commit archive is hash-verified, then a pinned portable tar reader enforces entry type, traversal, count, and declared expanded-byte quotas before extraction. A hardened XML parser rejects DTDs/external entities and explicitly traverses the Godot schema. Runtime verifies all compiled provenance fields, a composite hash over every centralized executable/config input, counts, and content hash. The pinned index supports exactly the Godot 4.6 minor line. Its provenance, attribution, regeneration, offline check, and byte-for-byte archive check procedure are documented in `docs/third-party/godot-class-reference-4.6.2.md`.

## Consequences

No alias duplicates the dangerous tool. The system never claims in-process cancellation. Direct unauthenticated WebSocket callers cannot invoke plugin commands. Class metadata stays live and version-sensitive while official documentation remains reproducible, bounded, and available without runtime file mutation or network access.
