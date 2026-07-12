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

## Review fixes: extension, bounded waits, normalization, and path-race narrowing

### Review RED evidence

1. `npm test -- --run tests/lsp-documents.test.ts tests/lsp-diagnostics.test.ts` exited 1 with six intended failures: existing `.txt` synchronized, named waiter limits/close were absent, and retained related diagnostics were not normalized.
2. After adding the client shutdown test while temporarily retaining the old client close behavior, `npm test -- --run tests/lsp-diagnostics.test.ts` exited 1 by timing out: the pending diagnostics wait remained live after `LspClient.close()`.
3. `npm test -- --run tests/lsp-documents.test.ts` exited 1 because the injected canonical-target change after handle open was not observed and synchronization incorrectly resolved.
4. The final normalization boundary RED, `npm test -- --run tests/lsp-diagnostics.test.ts`, exited 1 with two intended failures: tag `999` was retained and an oversized publication URI incremented the retained publication sequence.
5. The close-state RED, `npm test -- --run tests/lsp-diagnostics.test.ts`, exited 1 because close left publication sequence state populated. Rejection expectations were then attached before invoking close so cleanup rejection testing produces no unhandled promises.

### Review GREEN evidence

- Added exact lowercase `.gd` extension enforcement after canonical target validation.
- Added named 100..15,000 ms wait bounds, a 128-waiter cap, fail-closed excess handling, and idempotent `LspDiagnostics.close(reason?)` cleanup. `LspClient.close()` now unsubscribes, closes diagnostics, then closes the session.
- Replaced diagnostic object spreading with narrow normalization. Every retained string is capped: primary and related messages at 8,192 UTF-8 bytes; code/source/publication URI/related location URI at 1,024 bytes. Ranges, severity, tags, and numeric/string code are validated and copied; unknown/nested fields are dropped. Diagnostic and related-entry count caps remain 500 and 32.
- Reads now open the authorized canonical path, fstat the same handle as a regular file, immediately revalidate canonical path identity and root containment, and read bounded bytes from that same handle with guaranteed handle close.

Final review verification:

- Focused `documents + diagnostics + session`: 3 files passed, 32 tests passed.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0.
- Final review-cycle full suite run after all changes: 26 files passed, 2 skipped; 233 tests passed, 2 skipped.

### Remaining filesystem limitation

Portable Node APIs cannot make mutable pathname authorization and `open()` fully atomic across platforms. The post-open canonical revalidation and same-handle read narrow the race but do not claim to eliminate every hostile-filesystem substitution. Broader hostile-filesystem hardening remains explicitly deferred to Phase 6/7.

## Final review fix: caller diagnostic URI bound

### RED

Added tests using multibyte UTF-8 caller URIs: exactly 1,024 bytes must enter the waiter lifecycle, while 1,025 bytes must return structured `invalid_args` without consuming one of 128 waiter slots.

Command: `cd server && npm test -- --run tests/lsp-diagnostics.test.ts`

Result: exit 1; 1 failed, 10 passed. The oversized URI was retained and returned `not_connected` only when the store closed instead of immediate `invalid_args`, demonstrating the missing pre-insertion validation.

### GREEN and final verification

`waitFor` now validates a nonempty string and the 1,024 UTF-8-byte limit before closed-state, cache lookup, or waiter insertion.

- Diagnostics GREEN: 1 file passed, 11 tests passed.
- Focused diagnostics/documents: 2 files passed, 17 tests passed.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0.
- Full suite (single final-fix run): 26 files passed, 2 skipped; 235 tests passed, 2 skipped.
