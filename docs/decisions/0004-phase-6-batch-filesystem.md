# ADR 0004: Phase 6 batch, filesystem, and export roots

- Status: Accepted
- Date: 2026-07-20
- Resolves: remaining [Q-002](../architecture/open-questions.md) (Phase 6), [Q-009](../architecture/open-questions.md)

## Context

Phase 6 adds headless batch execution, guarded project-file access, UID/export operations, and an optional asset provider. Two open questions blocked a safe contract:

1. **Q-002 (Phase 6 remainder)** — whether Phase 2 is a hard API prerequisite for batch/filesystem work.
2. **Q-009** — whether export outputs may leave the project root (CI temp dirs vs master “project-root only” rule).

## Decision

### Q-002 — Phase 6 is Phase-1-hard; Phase 2 is coordination only

Phase 6 **API prerequisites** are Phase 1 config (`GODOT_PATH`, `GODOT_PROJECT_PATH`), logger, and structured errors.

- Pure filesystem tools and `FsGuard` do **not** call the editor plugin or Phase 2 execution.
- Headless scripts run in an isolated `godot --headless` child process via `HeadlessRunner`, not through `godot_script_run`.
- Completed Phase 2 remains a **program coordination and regression baseline** (same posture as Phase 4), not an API dependency for Phase 6 tools.
- Classification of headless scripts under mode/confirmation/mutation-lane policy remains **Phase 7 (Q-006)**; Phase 6 exposes honest annotations and basic mode blocking only for destructive writes where already practical.

### Q-009 — Direct writes project-root-only; exports allow configured roots

| Operation class | Allowed roots |
|---|---|
| Direct filesystem read/write/list (including asset placement) | Project root only (realpath-jail) |
| Export output paths | (1) project root, (2) a server-owned session export directory under the OS temp dir, (3) additional roots from `GODOT_MCP_EXPORT_ROOTS` (OS-path list, realpath-checked) |

Rules:

- All paths are canonicalized with `realpath` (or equivalent) before use; symlink/junction escapes are rejected.
- Overwriting an existing export or file target requires explicit `overwrite: true` and is annotated destructive.
- Session export directories are created per MCP server process under a unique subdirectory and cleaned on best-effort shutdown.
- The host never invents project-relative meaning for absolute export roots outside the configured set.

## Consequences

- Phase 6 can ship without the editor WebSocket for fs/headless/export acceptance.
- Atlas `FLOW-PH-011` becomes a solid Phase-1-only edge with Phase 2 coordination noted in prose (no longer `? unresolved · Q-002`).
- Export CI can write outside the project when using the session temp root or configured export roots.
- Phase 7 path middleware reuses `FsGuard` without redefining root policy.

## Non-decisions

- Full uniform `SafetyPolicy` / audit / mutation lane for headless scripts (Phase 7).
- Concrete third-party asset provider wire protocol (optional interface only).
