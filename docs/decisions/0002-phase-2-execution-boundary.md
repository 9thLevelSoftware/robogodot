# ADR 0002: Phase 2 execution boundary

## Status

Accepted — 2026-07-11

## Decision

- `godot_script_run` is the sole public MCP tool name. `run_editor_script` names the conceptual capability only.
- The TypeScript server enforces the 15-second response deadline. A blocked Godot editor thread cannot be cancelled safely; timeout guidance tells the caller to restart the editor.
- Arbitrary execution is unavailable until the editor connection authenticates with a shared high-entropy token and becomes the single active control-plane client.
- Editor-script execution is blocked in `read_only` and `confirm_destructive`. In `full`, every execution requires the explicit per-request capability flag `allowDangerous:true`. Authorization is source-independent; no deny-list or source heuristic participates in it.

## Consequences

No alias duplicates the dangerous tool. The system never claims in-process cancellation. Direct unauthenticated WebSocket callers cannot invoke plugin commands.
