# Phase 0–1 final fix report

Date: 2026-07-11
Branch: `codex/phase-0-1`
Starting commit: `7af69a48c17c3402b69ab1f4e2d23f583c85e2f7`

## Fixes

- MCP stdio lifecycle now treats stdin `end` or `close` as a normal, idempotent shutdown request and removes those listeners during cleanup. Unit coverage proves cleanup runs once; a spawned freshly built server test proves stdin EOF exits promptly with code 0.
- Every third-party GitHub Action in CI is pinned to a full commit SHA with its major-version comment retained.
- Godot 4.6.2 Linux and Windows archives are SHA-256 verified before extraction.
- Failed SDK tool registration no longer reserves the tool name; a retry can succeed.
- Godot port validation accepts alternate valid integer spellings such as `09200` without warning classification.
- Q-003 is unambiguously resolved/superseded by ADR 0001. Historical conflict text remains, while the accepted JSON-RPC `core.ping` heartbeat and 1s-to-60s reconnect ownership are explicit. README required no change because it makes no conflicting ownership/mechanism claim.

## CI provenance

Authoritative GitHub API/repository endpoints queried on 2026-07-11:

- Godot official release: `https://api.github.com/repos/godotengine/godot/releases/tags/4.6.2-stable`
- Godot release page: `https://github.com/godotengine/godot/releases/tag/4.6.2-stable`
- Linux asset: `https://github.com/godotengine/godot/releases/download/4.6.2-stable/Godot_v4.6.2-stable_linux.x86_64.zip`
  - Official release API digest: `sha256:30e6b6d141f0cd5bebd629ad1d0ef1324e60091bb20662d026b402ba58c59937`
- Windows asset: `https://github.com/godotengine/godot/releases/download/4.6.2-stable/Godot_v4.6.2-stable_win64.exe.zip`
  - Official release API digest: `sha256:14293422efb54b24a51f79d4cb55ab4001ef3d936e064a6c8af32e1f984024be`
- Checkout v4 tag ref: `https://api.github.com/repos/actions/checkout/git/ref/tags/v4`
  - Commit: `34e114876b0b11c390a56381ad16ebd13914f8d5`
- Setup Node v4 tag ref: `https://api.github.com/repos/actions/setup-node/git/ref/tags/v4`
  - Commit: `49933ea5288caeca8642d1e84afbd3f7d6820020`

The Linux step uses `sha256sum --check --strict`; the Windows step compares lowercase `Get-FileHash -Algorithm SHA256` output and throws before `Expand-Archive` on mismatch. Environment-variable syntax is platform-correct (`${NAME}` in Bash, `$env:NAME` in PowerShell).

## TDD evidence

Red command:

`cd server; npm test -- --run tests/registry.test.ts tests/server.test.ts tests/mcp-stdio.test.ts`

Result: exit 1; the retry test failed with `Tool "echo" is already registered`, and the lifecycle test failed because no shutdown listener was installed.

Godot red command:

`Godot_v4.6.2-stable_mono_win64_console.exe --headless --path tests/fixtures/godot_project --script ../../godot/phase_1_smoke.gd`

Result: exit 1; parse error because `is_valid_port_value()` did not yet exist.

Green focused commands:

- `cd server; npm test -- --run tests/registry.test.ts tests/server.test.ts tests/mcp-stdio.test.ts` — exit 0, 3 files and 13 tests passed.
- Godot smoke command above — exit 0 with `PASS port parsing`, router, ping, version, malformed request, internal error, framing, and shutdown.

## Final verification

- `node --test tests/architecture/*.test.mjs` — exit 0, 83 passed, 0 failed.
- `cd server; npm test -- --run` — exit 0, 64 passed, 1 opt-in live test skipped.
- `cd server; npm run typecheck` — exit 0.
- `cd server; npm run build` — exit 0.
- `$env:GODOT_PATH='<Godot 4.6.2 console path>'; cd server; npm run test:live` — exit 0, 1 passed; real restart/reconnect acceptance completed in 14.67s.
- Godot 4.6.2 headless smoke — exit 0, all eight PASS groups.
- `node docs/architecture/render.mjs --only 08-connection-lifecycles` — exit 0, atlas render passed.
- `git diff --check` — exit 0; only expected Windows autocrlf informational warnings.

## Review notes

- Normal stdin EOF is not logged or converted to a fatal process exit; spawned-process coverage asserts exit code 0 and no signal.
- Shutdown is idempotent even when both stdin `end` and `close` occur.
- CI performs checksum verification before extraction/execution on both operating systems.
- No authentication, mutation, or remote-access scope was added.
