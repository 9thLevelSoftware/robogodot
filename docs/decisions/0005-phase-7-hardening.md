# ADR 0005: Phase 7 policy pipeline and open-question resolutions

- Status: Accepted
- Date: 2026-07-20
- Resolves: [Q-004](../architecture/open-questions.md), [Q-006](../architecture/open-questions.md), [Q-007](../architecture/open-questions.md), [Q-008](../architecture/open-questions.md)

## Context

Phases 1–6 delivered channel tools with partial safety: mode only gated `godot_script_run`, mutation FIFO only wrapped some curated tools, and there was no uniform audit, read cache, or health aggregation. Phase 7 requires one registry middleware band for every tool.

## Decision

### Q-004 — Formalize existing local control-plane security

Normative policy (already largely implemented by the plugin WebSocket server):

- Bind the editor control plane to loopback only (`127.0.0.1`).
- Authenticate with a high-entropy shared token (32–256 UTF-8 bytes) before command dispatch.
- Allow exactly one authenticated control-plane client; reject additional clients.
- Plaintext `ws://` is permitted only on enforced loopback; remote/`wss://` is out of scope until a future ADR.

Phase 7 does not re-implement the plugin listener; it records this as the accepted security baseline and surfaces readiness via Health.

### Q-006 — Headless script classification

`godot_headless_run` is classified as **mutating and destructive** (`readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: true`):

- Blocked in `read_only`.
- In `confirm_destructive`, requires per-request `confirmed: true`.
- Enters the shared mutation lane.
- Process/output bounds remain owned by `HeadlessRunner` (Phase 6).

Editor `godot_script_run` keeps ADR 0002 rules: blocked outside `full`; in `full` requires `allowDangerous: true`; also enters the shared mutation lane.

### Q-007 — Every outcome is audited once

The registry creates an audit context at tool entry and finalizes **exactly one** redacted record in `finally` for:

- success
- invalid arguments / handler errors
- `blocked_by_policy`
- mutation-lane failures
- transport-mapped failures

Audit never writes to MCP stdout. Records are bounded and redacted (source/script bodies truncated).

### Q-008 — Mutation fence for read cache

- Mutations bump a global generation and invalidate affected (or all) cache tags at **start** and again in **finally**.
- Concurrent reads may proceed; cache **inserts** are discarded if the generation changed before insertion.
- Arbitrary-script / headless / openWorld mutations use a **global** fence (invalidate all tags).
- Curated mutations may use domain tags (`scene`, `project-settings`, `signals`, `resources`, `files`).

### Mode gate (uniform)

| Mode | Behavior |
|---|---|
| `read_only` | Only tools with `readOnlyHint: true` |
| `confirm_destructive` | Tools with `destructiveHint: true` require `confirmed: true` (except `godot_script_run`, which remains blocked per ADR 0002) |
| `full` | All tools; script still needs `allowDangerous` |

Optional `confirmed` is accepted on every tool schema via registry wrapping and stripped before the handler.

### Mutation lane

One `MutationLane` owns **all** non-read-only tool handlers at the registry. Per-tool lanes are removed to prevent nested-lane deadlock.

## Consequences

- Operators can trust `GODOT_MCP_MODE=read_only` for the full surface.
- Audit is complete for forensics including policy rejections.
- Cache cannot repopulate stale pre-mutation snapshots under Q-008.
- Phase 8 can expose Health as resources without rewiring tools.
