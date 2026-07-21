# Phase 6 Batch and Filesystem Implementation Plan

**Goal:** Ship FsGuard, HeadlessRunner, seven public tools, tests, and ADR 0004 documentation.

## Tasks

### Task 1: FsGuard + config export roots
- Create `server/src/fs/guard.ts`, `server/tests/fs-guard.test.ts`
- Extend config with `exportRoots: string[]` from `GODOT_MCP_EXPORT_ROOTS` (path delimiter-separated)
- Session export dir helper under OS temp

### Task 2: HeadlessRunner
- Create `server/src/batch/headless.ts`, tests with injected spawn

### Task 3: Export helper
- Create `server/src/batch/export.ts`, unit tests for argv and overwrite

### Task 4: Tools + server wiring
- `tools/fs.ts`, `tools/batch.ts`, `tools/uid.ts`, `tools/assets.ts`
- Inventory → 58 tools

### Task 5: Live + CI + docs
- `live-phase6.test.ts` or extend live-support
- Architecture open-questions Q-002/Q-009
- README tool table
- `test:live:phase6` script + CI step
