# ADR 0006: Phase 8 production packaging and support matrix

- Status: Accepted
- Date: 2026-07-21
- Resolves: [Q-013](../architecture/open-questions.md), [Q-014](../architecture/open-questions.md), [Q-015](../architecture/open-questions.md), [Q-016](../architecture/open-questions.md)

## Context

Phase 8 makes the hardened system installable, discoverable (resources/prompts), evaluated, and supportable. Four open questions blocked a coherent release contract.

## Decision

### Q-013 — Node.js engine floor is `>=22`

`package.json` `engines.node` remains **`>=22`**, matching the implemented toolchain, CI matrix, and TypeScript 7 baseline. The older source ambiguity of “≥18/20” is superseded: Node 20 is not a supported product floor for this release.

### Q-014 — Prompt name is `add-feature-to-scene`

The sole public prompt identifier is **`add-feature-to-scene`**. No `add-feature` alias is registered.

### Q-015 — Supported Godot minor matrix is exactly 4.6

Initial support is **Godot 4.6.x only**. Additional minors require a full green suite, compatibility-shim review, and an explicit matrix update.

### Q-016 — Reconnect acceptance window is 65 seconds

End-to-end reconnection acceptance requires a successful authenticated connection within **65 seconds** after the plugin WebSocket listener becomes available: the 60-second maximum backoff interval plus a 5-second handshake margin. The exponential retry schedule (`1s…60s`) is tested separately from this acceptance deadline.

## Consequences

- Install docs and CI pin Node 22+.
- Prompt discovery is unambiguous for clients.
- Support claims match the tested Godot minor.
- Release reconnect tests use a deterministic 65s deadline.
