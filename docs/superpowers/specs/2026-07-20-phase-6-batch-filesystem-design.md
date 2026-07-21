# Phase 6 Batch, Filesystem, and Assets Design

**Date:** 2026-07-20  
**Status:** Approved for implementation (decisions fixed by [ADR 0004](../../decisions/0004-phase-6-batch-filesystem.md))

## 1. Objective

Provide headless batch execution, project-root-jailed filesystem tools, UID inventory, export with multi-root destinations, and a feature-gated asset provider seam—without requiring a live editor plugin for core acceptance.

## 2. Scope

### In scope

- `FsGuard` realpath jail for project paths and export roots.
- `HeadlessRunner` for `godot --headless --path <project> --script <script>`.
- Public tools (exactly **7** new names → inventory **58**):
  - `godot_fs_read`
  - `godot_fs_write`
  - `godot_fs_list`
  - `godot_headless_run`
  - `godot_export_project`
  - `godot_uid_list`
  - `godot_asset_generate` (feature-gated; default `feature_disabled`)
- Unit tests for escape denial, export roots, headless mock spawn.
- Live headless smoke when `GODOT_PATH` is set.
- Architecture/README/CI updates; resolve Q-002 Phase 6 + Q-009 via ADR 0004.

### Out of scope

- Phase 7 full middleware (audit/cache/queue); only light mode notes for writes.
- Remote asset provider network protocol (interface + disabled default).
- Editor mutation / LSP / runtime channels.

## 3. Architecture

| Component | Path | Responsibility |
|---|---|---|
| `FsGuard` | `server/src/fs/guard.ts` | Resolve/jail project and export paths |
| `HeadlessRunner` | `server/src/batch/headless.ts` | Bounded headless Godot script process |
| Export helper | `server/src/batch/export.ts` | `--export-release` / `--export-debug` invocation |
| Asset provider | `server/src/assets/provider.ts` | Optional interface; default disabled |
| Tools | `server/src/tools/fs.ts`, `batch.ts`, `uid.ts`, `assets.ts` | MCP surface |

### Path contract

- Project-relative inputs accept `res://…` or project-relative POSIX-style segments without `..`.
- Absolute project paths are rejected unless realpath-equal to a path under the project root after resolution from a `res://` or relative form.
- Export outputs: absolute or relative; resolved then checked against allowed export roots (ADR 0004).
- Max path UTF-8 bytes: 1024; max read/write body: 262_144 bytes; list page max 500 entries.

### Headless contract

- Requires `GODOT_PATH` and `GODOT_PROJECT_PATH`.
- Writes caller source to a unique temp `.gd` under the project `.godot/mcp-headless/` (or OS temp inside project jail if preferred) then runs:
  `godot --headless --path <project> --script <script>`
- Timeout default 30_000 ms (max 120_000); capture bounded stdout/stderr (256 KiB each).
- Cleanup temp script in `finally`.
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, `openWorldHint: true`.

### Export contract

- Inputs: `preset` (string), `output` path, optional `debug` boolean, optional `overwrite`.
- Invokes `godot --headless --path <project> --export-release <preset> <output>` (or `--export-debug`).
- Output path must pass export-root jail; existing file requires `overwrite: true`.

### UID list

- Walk project (bounded depth/count) for `*.uid` files; return relative `res://` paths and contents truncated.
- Read-only.

### Asset generate

- If provider not configured (`GODOT_MCP_ASSET_PROVIDER` unset/false): `feature_disabled`.
- If enabled with a registered provider interface: call provider, write bytes through FsGuard into project path.

## 4. Errors

- `invalid_args` — path syntax, bounds, missing overwrite
- `blocked_by_policy` — reserved; Phase 6 may use for read_only mode on writes if mode is plumbed
- `editor_required` — missing Godot/project for headless/export
- `timeout` — headless/export deadline
- `feature_disabled` — asset provider off
- `godot_error` — nonzero exit, spawn failure, guard escape

## 5. Testing

- FsGuard: traversal, symlink escape (where platform allows fixture), export root accept/deny
- Headless: mock spawn argv, timeout, cleanup
- Tools: inventory 58, schema, error mapping
- Live: headless script prints known token; fs write/read round-trip in fixture project

## 6. Deliverables

- ADR 0004, this design, implementation plan
- Code + tests + README + architecture Q-002/Q-009 resolution
- CI: unit always; live headless when Godot present
