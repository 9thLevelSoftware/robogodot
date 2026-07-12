# Phase 4 Task 3 Report

## Status

Complete. Implemented secure document synchronization, bounded pushed diagnostics, and the reusable `LspClient` facade. No later-task work was performed.

## Implementation

- Added `LspDocuments` with bounded `res://` parsing, decoded traversal rejection, fatal UTF-8 decoding, 2 MiB/document and 128-document caps, realpath containment, exact CRLF/text preservation, content-hash suppression, full-text versioned changes, sorted generation replay, canonical file URIs, and UTF-16 position validation.
- Added `LspDiagnostics` with generation/sequence-aware freshness, bounded stale fallback, timeout errors, 128-URI/500-diagnostic retention, 8,192-byte UTF-8 message truncation, and 32-entry related-information caps.
- Added `LspClient` composition and a generation-bound session notification method so reconnect replay can send while the session is initializing without deadlocking on `ensureReady()`.
- Added document and diagnostics tests plus requested LSP fixtures.

## Exact TDD evidence

### Initial RED

Command:

`cd server && npm test -- --run tests/lsp-documents.test.ts tests/lsp-diagnostics.test.ts`

Result: exit 1. Both suites failed during import with `Cannot find module '../src/lsp/documents.js'` and `Cannot find module '../src/lsp/diagnostics.js'`, confirming the new behavior was absent.

### Initial GREEN

Command:

`cd server && npm test -- --run tests/lsp-documents.test.ts tests/lsp-diagnostics.test.ts tests/lsp-session.test.ts`

Result: exit 0; 3 files passed, 25 tests passed.

### Boundary regression RED

During self-review, changed the bounded-message test to a three-byte UTF-8 code point (`€`) so truncation ended inside a code point.

Command:

`cd server && npm test -- --run tests/lsp-diagnostics.test.ts`

Result: exit 1; 1 failed, 3 passed. Expected at most 8,192 bytes but received 8,193, proving replacement-character decoding violated the byte cap.

### Boundary regression GREEN

Changed truncation to use fatal decoding and retreat to the last complete UTF-8 code point.

Command:

`cd server && npm test -- --run tests/lsp-diagnostics.test.ts`

Result: exit 0; 1 file passed, 4 tests passed.

### Final focused verification

Command:

`cd server && npm test -- --run tests/lsp-documents.test.ts tests/lsp-diagnostics.test.ts tests/lsp-session.test.ts`

Result: exit 0; 3 files passed, 25 tests passed.

## Final verification

- `npm run typecheck`: exit 0.
- `npm run build`: exit 0.
- Final `npm test -- --run`: exit 0; 26 files passed, 2 skipped; 226 tests passed, 2 skipped.
- An earlier full-suite run before the UTF-8 boundary regression also passed with the same totals; the final full run above verifies the corrected implementation.

## Self-review

- Verified realpath comparison uses the canonical root and target and rejects empty, absolute, or `..` relative results, covering Windows junction and symlink escapes.
- Verified versions and stored content update only after successful notifications.
- Verified reconnect replay uses the supplied generation and preserves sorted URI order and current versions/text.
- Verified cached diagnostics from a different generation cannot satisfy a fresh or stale wait.
- No unresolved correctness concerns found. Live Godot integration was not required or run; behavior is covered with filesystem and session/mock tests.
