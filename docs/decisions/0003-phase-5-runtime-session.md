# ADR 0003: Phase 5 runtime session ownership and IPC

- Status: Accepted
- Date: 2026-07-20
- Resolves: [Q-010](../architecture/open-questions.md), [Q-011](../architecture/open-questions.md), [Q-012](../architecture/open-questions.md)
- Implements: Phase 5 design at `docs/superpowers/specs/2026-07-12-phase-5-runtime-debug-design.md` (merged via PR #5)

## Context

Phase 5 must run, observe, debug, and interact with a controlled Godot game process. The architecture atlas preserved three source conflicts about launch ownership, `user://` path discovery, and socket versus file IPC. Phase 5 implementation landed on `main` with a concrete coordinator; this ADR records the accepted decisions so the open-question register and future phases cite a stable decision document.

## Decision

### Q-010 — Single runtime-session coordinator; ProcessRunner owns OS spawn

One in-process **RuntimeSession** coordinator owns the public runtime state machine. Every process, bridge, and debug tool delegates to it.

- **ProcessRunner alone** owns OS spawn, PID, stdout/stderr ring buffer, graceful-then-forced stop, and orphan cleanup.
- `godot_run_project` and `godot_debug_launch` both start a coordinator-owned process; debug mode adds DAP attach arguments only.
- **DapClient never independently spawns** a second game process. It performs protocol initialization and **attach** only.
- If DAP is unavailable or a capability is unsupported, the session **degrades to process + bridge** and returns structured `feature_disabled` for debug-only operations.

### Q-011 — Godot publishes the absolute IPC root

The host never derives `user://` from platform user-data heuristics.

1. The editor plugin resolves the project's canonical `user://` absolute root through Godot APIs.
2. Bootstrap over the authenticated editor channel publishes session credentials plus the absolute session directory under `.mcp/<sessionId>/`.
3. The TypeScript runtime driver realpath-registers **only** that session subdirectory and confines request/response/screenshot artifacts to it.

### Q-012 — Negotiated socket preferred; locked file-IPC fallback

Every launch receives a random session ID, secret token, protocol version, and preferred authenticated loopback endpoint.

- The injected bridge attempts a **bounded socket handshake**.
- If that handshake cannot complete, both peers **lock to sequenced file IPC** under the published session directory **before any runtime request is accepted**.
- Transport is **immutable** for the session: no mid-session switch and no replay of a request that may already have executed.
- File IPC writers must publish complete payloads (write temp then rename, or equivalent) so concurrent pollers never read partial JSON or incomplete PNG bytes.

## Consequences

- Exactly one OS game process per RuntimeSession; tests assert a single PID across run/debug entry points.
- Host path safety does not depend on OS-specific Godot user-data layouts.
- Peers cannot strand on different transports after bootstrap.
- Atlas runtime/debug sequence and connection lifecycle views treat launch ownership and IPC roots as implemented.
- Audit of runtime outcomes remains a Phase 7 middleware concern.

## Non-decisions

- Exact public MCP tool names and Zod schemas (fixed in the Phase 5 design and `server/src/tools/{runtime,debug}.ts`).
- Full Phase 7 mutation-lane classification of runtime tools.
