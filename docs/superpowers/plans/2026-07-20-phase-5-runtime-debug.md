# Phase 5 Runtime and Debug Implementation Plan — Decision Index

**Date:** 2026-07-20  
**Status:** Superseded as a stand-alone plan by the implemented Phase 5 package on `main`.

## Canonical sources

| Concern | Document |
|---|---|
| Implementation plan (tasks, files, acceptance) | [`2026-07-12-phase-5-runtime-debug.md`](./2026-07-12-phase-5-runtime-debug.md) |
| Design | [`../specs/2026-07-12-phase-5-runtime-debug-design.md`](../specs/2026-07-12-phase-5-runtime-debug-design.md) |
| ADR for Q-010 / Q-011 / Q-012 | [`../../decisions/0003-phase-5-runtime-session.md`](../../decisions/0003-phase-5-runtime-session.md) |

Public tool Zod schemas live in `server/src/tools/runtime.ts` and `server/src/tools/debug.ts`. File IPC publishes complete artifacts (temp write + rename) as required by ADR 0003.

This note exists only so historical PR #6 links remain valid. Do not implement from this file.
