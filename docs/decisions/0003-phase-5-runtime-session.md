# ADR 0003: Phase 5 runtime session ownership and IPC

- Status: Accepted
- Date: 2026-07-20
- Resolves: [Q-010](../architecture/open-questions.md), [Q-011](../architecture/open-questions.md), [Q-012](../architecture/open-questions.md)

## Context

Phase 5 must run, observe, debug, and interact with a controlled Godot game process. The architecture atlas preserves three source conflicts:

1. **Q-010** — ProcessRunner and DAP both appear to own launch, risking double-spawn and split lifecycle state.
2. **Q-011** — Host-side runtime bridge IPC is defined under Godot's logical `user://` path, which the TypeScript process cannot safely invent from OS conventions.
3. **Q-012** — Sources prefer a local socket with file-IPC fallback but never define negotiation, authentication, or mid-session switching rules.

Phase 5 also consumes the Phase 2 execution contract for runtime-bridge injection and must degrade when DAP is partial or unavailable without disabling process control or bridge operations.

## Decision

### Q-010 — Single runtime-session coordinator; ProcessRunner owns OS spawn

Introduce one in-process **RuntimeSession** coordinator that every public process, bridge, and debug tool delegates to.

- **ProcessRunner alone** owns OS spawn, PID, stdout/stderr ring buffer, graceful-then-forced stop, and orphan cleanup.
- Default launch command shape: `godot --path <project> [optional scene]` plus any debug/port flags the coordinator applies **before** spawn.
- **DapClient never independently spawns** a second game process. After ProcessRunner has a live process (or an explicitly attach-only mode is selected), DAP performs protocol initialize and **attach** (or the minimal launch handshake required by Godot DAP that does not create a second OS process under ProcessRunner's ownership).
- Public tools such as `godot_run_project` and any debug-launch entry point both call RuntimeSession; they do not each own spawn policy.
- If DAP is unavailable or a capability is unsupported, RuntimeSession **degrades to process + bridge** and returns structured `feature_disabled` for debug-only operations. Process output/stop and bridge tools remain usable.

### Q-011 — Godot publishes the absolute IPC root

The host never derives `user://` from platform user-data heuristics.

1. At runtime-session start, after the game process is running (or as part of bridge injection via the Phase 2 execution seam), **Godot resolves** the session IPC directory under `user://.mcp/<sessionId>/` (or equivalent) and returns:
   - `sessionId` — high-entropy, unique per session
   - `ipcRootAbs` — canonical absolute filesystem path of that directory
   - optional logical `ipcRootUser` for display (`user://…`)
2. Publication uses a **non-file bootstrap channel** already available to the control plane:
   - preferred: bridge autoload ready notification written once to a path ProcessRunner can observe only after Godot has created the directory and reported the abs path through stdout marker or editor-injected bootstrap result;
   - concrete Phase 5 design may use a single bootstrap response returned from the injection/`godot_script_run` setup call, or a one-line stdout sentinel parsed only for session setup.
3. The TypeScript runtime driver registers **only** `ipcRootAbs` (realpath-checked) as the allowed IPC root for that session. All request/response/screenshot file operations are confined to that directory.
4. Screenshot results may include logical `path` plus host `absPath` only when `absPath` is under the registered root.

### Q-012 — Negotiated socket preferred; locked file-IPC fallback

Phase 5 implements a **versioned, mutually authenticated loopback** bridge endpoint with a bounded pre-request handshake (session ID, secret token, protocol version, capabilities).

- If the socket handshake completes, both peers lock to that transport for the entire session.
- If the handshake cannot complete, both peers **lock to sequenced file IPC** under the Godot-published session directory **before any runtime request is accepted**.
- Transport **never switches** mid-session and a published request is **never replayed** on the other transport.
- File IPC uses monotonic request IDs, per-request timeouts, bounded payloads, write/read/delete of correlated response artifacts, and serialized outstanding requests.

## Consequences

- Exactly one OS game process per RuntimeSession; tests assert a single PID across run/debug entry points.
- Host path safety does not depend on OS-specific Godot user-data layouts.
- Bridge and screenshot cleanup are scoped to a known absolute session directory and session ID.
- Peers cannot strand on different transports after bootstrap; degradation is process+bridge when DAP fails independently.
- Atlas sequence `FLOW-RUN-006` is attach-after-ProcessRunner-spawn; `Q-010`/`Q-011`/`Q-012` are resolved.
- Audit of runtime outcomes remains a Phase 7 middleware concern; Phase 5 may log via the existing stderr logger only.

## Non-decisions

- Exact public MCP tool names and schemas (fixed in the Phase 5 design doc).
- Whether bridge autoloads are temporary-injected vs project-permanent (design chooses the safer temporary/session approach unless Godot requires otherwise).
- Full Phase 7 mutation-lane classification of runtime tools.
