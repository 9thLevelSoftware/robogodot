# Phase 4 Code Intelligence (LSP) Implementation Plan

> **Status: Implemented (Phase 4 closeout).** Production code, unit/mock tests, live acceptance, architecture views, and CI gates land the design. Historical task steps below retain `- [ ]` checkboxes as the original work order; do not re-execute them as open work. Residual closeout evidence is recorded in `.superpowers/sdd/progress.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Godot 4.6's project-grounded GDScript diagnostics and code intelligence through seven bounded, read-only MCP tools backed by a reusable LSP client and an opt-in owned headless host.

**Architecture:** A bounded TCP `LspTransport` feeds an initialized, reconnecting `LspSession`; focused document and diagnostics stores synchronize exact project files and consume pushed notifications. Thin MCP adapters negotiate capabilities and normalize results, while an optional `LspHost` attaches first and launches only an explicitly enabled, server-owned headless editor.

**Tech Stack:** TypeScript 7, Node.js 22 `node:net`/`node:child_process`, MCP SDK 1.29, Zod 4, Vitest 4, LSP JSON-RPC 2.0 over TCP, Godot 4.6.2 GDScript Language Server.

## Global Constraints

- Public Phase 4 names are exactly the seven `godot_lsp_*` names in the approved design; do not expose rename, formatting, code actions, references, definitions, or aliases.
- Every Phase 4 tool is read-only, non-destructive, idempotent, and closed-world; no tool writes a source file or applies an LSP edit.
- Accept only existing regular `.gd` files addressed by `res://` beneath the real configured project root; reject traversal and symlink/junction escapes.
- Disk bytes are authoritative UTF-8 and are synchronized without indentation, line-ending, or content rewriting.
- Public positions are zero-based and `character` is a UTF-16 code-unit offset.
- Use pushed `textDocument/publishDiagnostics`; do not invent an unsupported pull-diagnostics request.
- Invoke `workspace/symbol` only when advertised. Godot 4.6 must return `feature_disabled`, not an approximated filesystem index.
- Automatic hosting is disabled by default and may terminate only the exact child process it launched.
- All protocol frames, buffers, pending requests, documents, results, trees, text, and deadlines have named finite bounds and fail closed.
- LSP availability is independent of the authenticated editor-plugin WebSocket and the Phase 3 mutation lane.
- Preserve all Phase 1 through Phase 3 authentication, Variant, documentation, mutation, live-editor, and smoke contracts.

---

## File structure

| File | Responsibility |
|---|---|
| `server/src/lsp/protocol.ts` | Narrow JSON-RPC/LSP wire types, guards, constants, and capability helpers. |
| `server/src/lsp/transport.ts` | One-socket framing, correlation, notification routing, limits, deadlines, and close semantics. |
| `server/src/lsp/session.ts` | Initialize/capability lifecycle, connection generation, reconnect, document replay hook, and shutdown. |
| `server/src/lsp/documents.ts` | Secure `res://` resolution, exact UTF-8 reads, UTF-16 position checks, full-text sync, and replay state. |
| `server/src/lsp/diagnostics.ts` | Bounded latest-publication store and generation-aware fresh diagnostics waits. |
| `server/src/lsp/client.ts` | Reusable facade composing session, documents, diagnostics, and capability checks for tools. |
| `server/src/lsp/host.ts` | Attach-first probing, opt-in headless launch, bounded output, ownership, and child-only teardown. |
| `server/src/tools/lsp.ts` | Seven public schemas, registrations, capability gates, result normalization, and output bounds. |
| `server/tests/mock-lsp.ts` | Deterministic TCP mock with framed requests, results, errors, notifications, and fragmentation controls. |
| `server/tests/lsp-*.test.ts` | Transport, lifecycle, document, diagnostics, host, mapping, registry, and error tests. |
| `server/tests/live-phase4.test.ts` | Visible-editor and owned-headless public MCP acceptance. |
| `tests/fixtures/godot_project/phase4/` | Valid, completion/signature, symbol, and deliberate-diagnostic GDScript fixtures. |
| `docs/architecture/*`, `README.md`, `.github/workflows/ci.yml` | Implemented Phase 4 topology, resolved Q-002 edge, usage, capability boundary, and CI gates. |

---

### Task 1: Bounded LSP framing and request correlation

**Files:**
- Create: `server/src/lsp/protocol.ts`
- Create: `server/src/lsp/transport.ts`
- Create: `server/tests/mock-lsp.ts`
- Create: `server/tests/lsp-transport.test.ts`

**Interfaces:**
- Produces: `LspTransport.attach(socket: Duplex, generation: number): void`.
- Produces: `LspTransport.request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>`.
- Produces: `LspTransport.notify(method: string, params: unknown): Promise<void>`.
- Produces: `LspTransport.onNotification(listener: (event: LspNotification) => void): () => void`.
- Produces: `LspTransport.onClosed(listener: (error: Error) => void): () => void`, `close(reason?: Error): Promise<void>`, and read-only `generation`/`isAttached`.
- Produces: `MockLspServer` used by Tasks 2–4; it records decoded messages and can send framed, split, coalesced, malformed, and oversized responses.

- [ ] **Step 1: Write failing frame and correlation tests**

Create tests that assert UTF-8 byte length, split/coalesced decoding, out-of-order correlation, notification routing, LSP error mapping, deadline cleanup, and pending-request rejection:

```ts
it("uses UTF-8 byte length and correlates out-of-order responses", async () => {
  const { client, server } = duplexPair();
  const transport = new LspTransport({ maxFrameBytes: 1_048_576, maxBufferBytes: 2_097_152, maxPending: 128 });
  transport.attach(client, 7);
  const first = transport.request("alpha", { text: "é" }, 1_000);
  const second = transport.request("beta", {}, 1_000);
  const requests = await readFrames(server, 2);
  expect(requests[0].header).toContain(`Content-Length: ${Buffer.byteLength(requests[0].body)}`);
  server.write(frame({ jsonrpc: "2.0", id: requests[1].json.id, result: "second" }));
  server.write(frame({ jsonrpc: "2.0", id: requests[0].json.id, result: "first" }));
  await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
});

it.each(["missing length", "duplicate length", "negative length", "invalid JSON", "oversized body"])(
  "fails closed for %s",
  async (fixture) => expect(runMalformedFixture(fixture)).rejects.toMatchObject({ code: "godot_error" }),
);
```

- [ ] **Step 2: Run the transport test and confirm RED**

Run: `cd server && npm test -- --run tests/lsp-transport.test.ts`

Expected: FAIL because `protocol.ts`, `transport.ts`, and the mock helpers do not exist.

- [ ] **Step 3: Define the narrow protocol contract and fixed limits**

Implement exact JSON-RPC guards and constants in `protocol.ts`:

```ts
export const LSP_LIMITS = {
  maxFrameBytes: 1_048_576,
  maxBufferBytes: 2_097_152,
  maxPending: 128,
  defaultRequestMs: 5_000,
  minRequestMs: 100,
  maxRequestMs: 15_000,
} as const;

export interface LspNotification { generation: number; method: string; params?: unknown }
export interface LspResponseError { code: number; message: string; data?: unknown }
export function encodeFrame(message: unknown): Buffer;
export function parseJsonRpcEnvelope(value: unknown): JsonRpcEnvelope;
```

`encodeFrame` must compute `Content-Length` from the encoded UTF-8 `Buffer`, never JavaScript string length. `parseJsonRpcEnvelope` must accept only JSON-RPC `2.0`, numeric response IDs, method strings, and result-or-error response exclusivity.

- [ ] **Step 4: Implement the minimal bounded transport**

Implement one receive buffer and a two-state header/body parser. Headers end only at `\r\n\r\n`; `Content-Length` is required exactly once and contains ASCII decimal digits only. Reject a buffer beyond `maxBufferBytes` before concatenating further unbounded input. Use monotonically increasing numeric IDs and store `{resolve,reject,timer,generation}` per pending request.

```ts
request<T>(method: string, params: unknown, timeoutMs = LSP_LIMITS.defaultRequestMs): Promise<T> {
  if (!this.socket) return Promise.reject(notConnected());
  if (this.pending.size >= this.options.maxPending) return Promise.reject(new GodotMcpError("godot_error", "LSP request limit reached.", "Wait for an in-flight request to finish."));
  const id = this.nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new GodotMcpError("timeout", `LSP request ${method} timed out.`, "Retry after confirming the Godot language server is responsive."));
    }, clampDeadline(timeoutMs));
    this.pending.set(id, { resolve, reject, timer, generation: this.generation });
    this.write({ jsonrpc: "2.0", id, method, params });
  });
}
```

On protocol violation or socket close, detach listeners, reject all pending requests once, clear timers, clear the receive buffer, and emit one closed event. Ignore response IDs not present in the current generation.

- [ ] **Step 5: Complete the reusable TCP mock**

`MockLspServer` must bind loopback on port `0`, expose its allocated port, decode client frames with the same wire rules but an independent parser, and provide:

```ts
await mock.start();
mock.onRequest("initialize", ({ id }) => mock.result(id, initializeResult));
mock.notify("textDocument/publishDiagnostics", params);
mock.sendSplit(message, [1, 7, 19]);
mock.sendCoalesced([first, second]);
await mock.stop();
```

The mock must close every accepted socket during teardown so Vitest cannot hang.

- [ ] **Step 6: Run transport verification**

Run: `cd server && npm test -- --run tests/lsp-transport.test.ts && npm run typecheck && npm run build`

Expected: all transport tests PASS; TypeScript emits no errors; build succeeds.

- [ ] **Step 7: Commit**

```bash
git add server/src/lsp/protocol.ts server/src/lsp/transport.ts server/tests/mock-lsp.ts server/tests/lsp-transport.test.ts
git commit -m "feat: add bounded LSP transport"
```

---

### Task 2: Initialized session, capabilities, reconnect, and shutdown

**Files:**
- Create: `server/src/lsp/session.ts`
- Create: `server/tests/lsp-session.test.ts`
- Modify: `server/src/lsp/protocol.ts`

**Interfaces:**
- Consumes: Task 1 `LspTransport` and `MockLspServer`.
- Produces: `LspSession.ensureReady(): Promise<LspReadyState>` where `LspReadyState` contains `generation`, `serverInfo`, and raw `capabilities`.
- Produces: `LspSession.request<T>(method, params, timeoutMs?)`, `notify(method, params)`, `supports(capability: LspCapability): boolean`, `onNotification(listener)`, `setReplayHook(hook: (generation: number) => Promise<void>)`, and `close(): Promise<void>`.
- Produces: `LspCapability = "completion" | "hover" | "signatureHelp" | "documentSymbols" | "workspaceSymbols" | "nativeSymbol"`.

- [ ] **Step 1: Write failing lifecycle tests**

Cover initialize ordering, coalesced first use, capability capture, request-before-ready prevention, disconnect rejection, bounded reconnect, replay-before-ready, stale generation isolation, and shutdown/exit:

```ts
it("initializes once and captures honest capabilities", async () => {
  mock.onRequest("initialize", ({ id }) => mock.result(id, {
    capabilities: { completionProvider: {}, hoverProvider: true, documentSymbolProvider: true },
    serverInfo: { name: "Godot", version: "4.6.2.stable" },
  }));
  const session = createSession(mock.port);
  const [a, b] = await Promise.all([session.ensureReady(), session.ensureReady()]);
  expect(a.generation).toBe(b.generation);
  expect(mock.methods()).toEqual(["initialize", "initialized"]);
  expect(session.supports("completion")).toBe(true);
  expect(session.supports("workspaceSymbols")).toBe(false);
});

it("replays documents before the reconnected session becomes ready", async () => {
  const replay = vi.fn().mockResolvedValue(undefined);
  session.setReplayHook(replay);
  await session.ensureReady();
  mock.dropClients();
  await vi.waitFor(() => expect(replay).toHaveBeenCalledWith(2));
  expect(session.state).toBe("ready");
});
```

- [ ] **Step 2: Run the lifecycle test and confirm RED**

Run: `cd server && npm test -- --run tests/lsp-session.test.ts`

Expected: FAIL because `LspSession` does not exist.

- [ ] **Step 3: Implement state and initialization**

Define the exact states and injected boundaries:

```ts
export type LspSessionState = "disconnected" | "connecting" | "initializing" | "ready" | "reconnecting" | "shutting_down" | "exited";
export interface LspSessionOptions {
  host: "127.0.0.1";
  port: number;
  projectRootUri: string;
  connectTimeoutMs?: number;
  socketFactory?: (host: string, port: number) => Promise<Duplex>;
  beforeConnect?: () => Promise<void>;
  schedule?: (delayMs: number, work: () => void) => () => void;
}
```

`initialize` sends `processId`, `rootUri`, `workspaceFolders`, client info, UTF-16 position encoding, and only the client capabilities Phase 4 consumes. Send `initialized` only after the result passes structural validation. Keep the raw server capabilities generation-scoped.

- [ ] **Step 4: Implement capability helpers and Godot native compatibility**

Map standard capabilities strictly from `initialize.capabilities`. `workspaceSymbols` is true only for `workspaceSymbolProvider`. `nativeSymbol` is true only when `serverInfo.name` identifies Godot and the version begins with `4.6.` or initialize extension data explicitly advertises it.

```ts
supports(capability: LspCapability): boolean {
  const caps = this.ready?.capabilities;
  if (!caps) return false;
  if (capability === "workspaceSymbols") return Boolean(caps.workspaceSymbolProvider);
  if (capability === "nativeSymbol") return this.isPinnedGodot46() || this.hasGodotNativeExtension();
  return advertisedStandardCapability(caps, capability);
}
```

- [ ] **Step 5: Implement reconnect and graceful shutdown**

Unexpected close increments the connection generation, rejects generation-owned work through the transport, and schedules delays `1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000` milliseconds capped at 60 seconds. Tests inject a zero-delay scheduler. After reinitialize, await the replay hook before setting `ready`.

`close()` must cancel reconnect, coalesce repeated calls, request `shutdown` with a bounded deadline when ready, send `exit` even if shutdown fails, close transport, and end in `exited`. Explicit close must never schedule reconnect.

- [ ] **Step 6: Run lifecycle verification**

Run: `cd server && npm test -- --run tests/lsp-transport.test.ts tests/lsp-session.test.ts && npm run typecheck`

Expected: all focused tests PASS and no timer/socket handles remain open.

- [ ] **Step 7: Commit**

```bash
git add server/src/lsp/protocol.ts server/src/lsp/session.ts server/tests/lsp-session.test.ts
git commit -m "feat: add resilient LSP session lifecycle"
```

---

### Task 3: Secure document synchronization and pushed diagnostics

**Files:**
- Create: `server/src/lsp/documents.ts`
- Create: `server/src/lsp/diagnostics.ts`
- Create: `server/src/lsp/client.ts`
- Create: `server/tests/lsp-documents.test.ts`
- Create: `server/tests/lsp-diagnostics.test.ts`
- Create: `server/tests/fixtures/lsp/valid.gd`
- Create: `server/tests/fixtures/lsp/unicode.gd`

**Interfaces:**
- Consumes: Task 2 `LspSession`.
- Produces: `LspDocuments.sync(uri: string): Promise<SyncedDocument>` with `{uri,fileUri,path,text,version,generation}`.
- Produces: `LspDocuments.assertPosition(document, position): void` and `replay(generation): Promise<void>`.
- Produces: `LspDiagnostics.accept(event: LspNotification): void` and `waitFor(uri, generation, afterSequence, waitMs): Promise<DiagnosticSnapshot>`.
- Produces: reusable `LspClient` facade with `sync`, `assertPosition`, `diagnostics`, `request`, `supports`, `ensureReady`, and `close` methods used by Task 4.

- [ ] **Step 1: Write failing secure-path and synchronization tests**

Use a temporary real project root and assert `didOpen`, unchanged suppression, full-text `didChange`, reconnect replay, invalid UTF-8, URI bounds, missing/non-file targets, traversal, encoded traversal, alternate schemes, absolute inputs, and symlink/junction escape denial:

```ts
it("synchronizes exact bytes and only changes when disk bytes change", async () => {
  const docs = createDocuments(projectRoot, session);
  const opened = await docs.sync("res://phase4/player.gd");
  expect(opened.version).toBe(1);
  expect(notifications.at(-1)).toMatchObject({ method: "textDocument/didOpen", params: { textDocument: { text: "extends Node\r\n" } } });
  await docs.sync("res://phase4/player.gd");
  expect(notifications).toHaveLength(1);
  await fs.writeFile(file, "extends Node\r\nvar café = 1\r\n", "utf8");
  const changed = await docs.sync("res://phase4/player.gd");
  expect(changed.version).toBe(2);
  expect(notifications.at(-1)?.params).toMatchObject({ contentChanges: [{ text: "extends Node\r\nvar café = 1\r\n" }] });
});
```

- [ ] **Step 2: Run document tests and confirm RED**

Run: `cd server && npm test -- --run tests/lsp-documents.test.ts`

Expected: FAIL because the document module does not exist.

- [ ] **Step 3: Implement URI resolution, exact decoding, and position validation**

Use named limits: URI 1,024 UTF-8 bytes, 128 path segments, document 2 MiB, and at most 128 synchronized documents. Resolve `projectRoot` and target with `fs.realpath`, then compare with `path.relative(realRoot, realTarget)`; reject empty-outside, absolute-relative, and `..` prefixes. Decode with `new TextDecoder("utf-8", { fatal: true })`.

`assertPosition` splits without changing line endings, verifies `line < lines.length`, and counts UTF-16 code units directly from the JavaScript string. Reject a character offset that lands between `\r` and `\n` or exceeds the line content excluding its terminator.

- [ ] **Step 4: Implement full-text sync and replay**

Store a content hash and latest exact text per public URI. `didOpen` uses `languageId: "gdscript"`, version 1, and a canonical `file://` URI. `didChange` sends one full-text content change and increments version only after successful notification. Replay sends `didOpen` for every stored document with its current version/text in sorted URI order.

- [ ] **Step 5: Write failing diagnostics freshness tests**

```ts
it("returns the first publication after the synchronized sequence as fresh", async () => {
  const waiting = store.waitFor("res://phase4/broken.gd", 3, store.sequence, 1_000);
  store.accept(notification(3, "file:///project/phase4/broken.gd", [{ message: "Identifier not declared", severity: 1 }]));
  await expect(waiting).resolves.toMatchObject({ fresh: true, diagnostics: [{ message: "Identifier not declared" }] });
});

it("returns a bounded cached publication as stale when a fresh wait expires", async () => {
  store.accept(notification(3, uri, []));
  await expect(store.waitFor(uri, 3, store.sequence, 10)).resolves.toMatchObject({ fresh: false, diagnostics: [] });
});
```

- [ ] **Step 6: Implement diagnostics and compose `LspClient`**

Retain at most 128 URIs and 500 diagnostics per URI, bound messages to 8,192 UTF-8 bytes and related information to 32 entries, and record an increasing publication sequence. A wait resolves fresh only for the same connection generation and a sequence greater than `afterSequence`. If the deadline expires with no cached publication, throw `GodotMcpError("timeout", ...)`.

`LspClient` subscribes diagnostics to session notifications, installs `documents.replay` as the replay hook, exposes the focused facade, and unsubscribes before closing the session.

- [ ] **Step 7: Run document/diagnostics verification**

Run: `cd server && npm test -- --run tests/lsp-documents.test.ts tests/lsp-diagnostics.test.ts tests/lsp-session.test.ts && npm run typecheck && npm run build`

Expected: all focused tests PASS; traversal/link fixtures are denied; exact CRLF and Unicode text is preserved.

- [ ] **Step 8: Commit**

```bash
git add server/src/lsp/documents.ts server/src/lsp/diagnostics.ts server/src/lsp/client.ts server/tests/lsp-documents.test.ts server/tests/lsp-diagnostics.test.ts server/tests/fixtures/lsp
git commit -m "feat: synchronize LSP documents and diagnostics"
```

---

### Task 4: Seven bounded public MCP tools

**Files:**
- Create: `server/src/tools/lsp.ts`
- Create: `server/tests/lsp-tools.test.ts`
- Modify: `server/src/server.ts`
- Modify: `server/tests/server.test.ts`
- Modify: `server/tests/mcp-stdio.test.ts`

**Interfaces:**
- Consumes: Task 3 `LspClient` through a structural `LspToolClient` interface.
- Produces: `registerLspTools(server: McpServer, client: LspToolClient): void`.
- Modifies: `ServerDependencies` to accept optional `lsp?: LspToolClient`; without it, seven tools remain registered against a disconnected implementation and return `not_connected`.

- [ ] **Step 1: Write failing inventory, annotation, independence, and mapping tests**

Update the exact inventory from 31 to 38 tools, appending the seven approved names in design order. Assert every LSP tool has `{readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false}` and descriptions explicitly exclude rename/format/code actions.

```ts
it("keeps LSP usable while the editor bridge is disconnected", async () => {
  const lsp = fakeLsp({ completion: [{ label: "queue_free", kind: 2 }] });
  const result = await callPublicTool(createServer({ lsp }), "godot_lsp_completion", {
    uri: "res://phase4/player.gd", position: { line: 3, character: 8 }, limit: 20,
  });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ items: [{ label: "queue_free" }] });
});
```

- [ ] **Step 2: Run tool tests and confirm RED**

Run: `cd server && npm test -- --run tests/lsp-tools.test.ts tests/server.test.ts tests/mcp-stdio.test.ts`

Expected: FAIL because the seven tools are absent and inventory is still 31.

- [ ] **Step 3: Define strict shared schemas and capability gates**

Use zero-based integer positions capped at 1,000,000, query/native/member strings capped at 1,024 UTF-8 bytes, `limit` 1–500, and `waitMs` 100–15,000. Define one annotation object and one capability guard:

```ts
const LSP_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

function requireCapability(client: LspToolClient, capability: LspCapability): void {
  if (!client.supports(capability)) throw new GodotMcpError(
    "feature_disabled",
    `The connected Godot language server does not advertise ${capability}.`,
    capability === "workspaceSymbols"
      ? "Godot 4.6 does not register workspace/symbol; use document symbols for a specific res:// script."
      : "Use a Godot version that advertises this LSP capability.",
  );
}
```

- [ ] **Step 4: Implement diagnostics and position-query tools**

For diagnostics, record `afterSequence`, call `sync`, and wait on the canonical URI/current generation. For completion, hover, and signature help: sync, validate position, require the capability, call the exact standard method, and normalize nullable/union responses.

Completion outputs cap 500 items and bound each label/detail/documentation/edit string; return `truncated: true` when items are omitted. Hover `null` maps to `{found:false}`. Signature arrays cap 64 and parameter arrays cap 64.

- [ ] **Step 5: Implement document, workspace, and native symbol tools**

Document symbols sync first and recursively normalize at most 1,000 total nodes and depth 32 with a declared `truncated` flag. Workspace symbols require `workspaceSymbols` before calling `workspace/symbol` and never read the filesystem. Native symbol sends the exact Godot 4.6 payload:

```ts
const result = await client.request<unknown>("textDocument/nativeSymbol", {
  native_class: input.nativeClass,
  symbol_name: input.member ?? "",
});
```

Native `null` maps to `{found:false}`; a result maps to a bounded symbol/documentation tree.

- [ ] **Step 6: Register the seven tools and disconnected fallback**

`createServer` always calls `registerLspTools`. Its default `LspToolClient` throws:

```ts
new GodotMcpError(
  "not_connected",
  "The Godot language server is not configured.",
  "Start Godot with --editor --headless --lsp-port 6005 --path <project>, or configure the RoboGodot LSP client.",
)
```

Do not couple fallback status to `CoreBridge.getStatus()`.

- [ ] **Step 7: Run public-tool verification**

Run: `cd server && npm test -- --run tests/lsp-tools.test.ts tests/server.test.ts tests/mcp-stdio.test.ts && npm run typecheck && npm run build`

Expected: exact 38-tool inventory PASS; all seven schemas/annotations/mappings PASS; existing 31 tools remain unchanged.

- [ ] **Step 8: Commit**

```bash
git add server/src/tools/lsp.ts server/src/server.ts server/tests/lsp-tools.test.ts server/tests/server.test.ts server/tests/mcp-stdio.test.ts
git commit -m "feat: expose Godot LSP tools"
```

---

### Task 5: Attach-first opt-in headless host and server lifecycle

**Files:**
- Create: `server/src/lsp/host.ts`
- Create: `server/tests/lsp-host.test.ts`
- Modify: `server/src/config.ts`
- Modify: `server/src/index.ts`
- Modify: `server/tests/config.test.ts`
- Modify: `server/tests/server.test.ts`
- Modify: `server/package.json`

**Interfaces:**
- Consumes: Task 3 `LspClient` and existing config/logger/process helpers.
- Produces: `LspHost.ensureAvailable(): Promise<"attached" | "owned">`, `ownership`, `diagnostics()`, and idempotent `close(): Promise<void>`.
- Produces: `ResolvedConfig.lspAutoStart: boolean` from `GODOT_MCP_LSP_AUTO_START`.
- Modifies: `runServer` to create one `LspHost`/`LspClient`, inject the client into `createServer`, and close LSP before the MCP server finishes shutdown.

- [ ] **Step 1: Write failing config and ownership tests**

```ts
it.each([[undefined, false], ["false", false], ["0", false], ["true", true], ["1", true]])(
  "resolves LSP auto-start %s as %s", (raw, expected) => {
    expect(resolveFixture({ GODOT_MCP_LSP_AUTO_START: raw }).lspAutoStart).toBe(expected);
  },
);

it("attaches without spawning when the port already answers", async () => {
  probe.mockResolvedValue(true);
  await expect(host.ensureAvailable()).resolves.toBe("attached");
  expect(spawn).not.toHaveBeenCalled();
  await host.close();
  expect(kill).not.toHaveBeenCalled();
});

it("terminates only the child it launched", async () => {
  probe.mockResolvedValueOnce(false).mockResolvedValue(true);
  await expect(host.ensureAvailable()).resolves.toBe("owned");
  await host.close();
  expect(terminate).toHaveBeenCalledWith(ownedChild);
});
```

- [ ] **Step 2: Run config/host tests and confirm RED**

Run: `cd server && npm test -- --run tests/config.test.ts tests/lsp-host.test.ts tests/server.test.ts`

Expected: FAIL because `lspAutoStart` and `LspHost` do not exist.

- [ ] **Step 3: Add strict auto-start config**

Only `true` and `1` enable auto-start; unset, `false`, and `0` disable it. Reject any other value during resolved config with the exact message `GODOT_MCP_LSP_AUTO_START must be true, false, 1, or 0`.

- [ ] **Step 4: Implement attach-first ownership and bounded launch**

Inject `probe`, `spawn`, `terminate`, and timers. Probe `127.0.0.1:<lspPort>` with a 500 ms deadline. If auto-start is false, return `attached` only when reachable; otherwise throw `not_connected` with this safely display-quoted command:

```text
"<GODOT_PATH>" --editor --headless --lsp-port <GODOT_LSP_PORT> --path "<GODOT_PROJECT_PATH>"
```

When enabled, validate configured paths and spawn without a shell:

```ts
spawn(godotPath, ["--editor", "--headless", "--lsp-port", String(port), "--path", projectPath], {
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
```

Capture the last 16,384 bytes of each stream. Wait up to 15 seconds for the port, fail immediately on child error/exit, and after a port race re-probe before deciding whether the child owns service. Store the exact child identity only after spawn; `close` may terminate only that identity.

- [ ] **Step 5: Wire real server lifecycle with injection seams**

Extend `RunServerDependencies` with optional `lspHost` and `lspClient` lifecycle interfaces. Production constructs `LspHost` from resolved config and passes `host.ensureAvailable` as `LspSession.beforeConnect`. Shutdown order is: stop WebSocket bridge, close LSP client/session, close owned host, close MCP server. Each close is idempotent and attempted even if an earlier close fails; rethrow the first failure after cleanup.

- [ ] **Step 6: Add the live Phase 4 script entry**

Add `"test:live:phase4": "vitest run tests/live-phase4.test.ts"` to `server/package.json`. The test file arrives in Task 6; do not make the default unit suite depend on a local Godot binary.

- [ ] **Step 7: Run host/lifecycle verification**

Run: `cd server && npm test -- --run tests/config.test.ts tests/lsp-host.test.ts tests/server.test.ts && npm run typecheck && npm run build`

Expected: attach never spawns or kills; owned launch uses exact arguments; shutdown is idempotent; all focused tests PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/lsp/host.ts server/src/config.ts server/src/index.ts server/tests/lsp-host.test.ts server/tests/config.test.ts server/tests/server.test.ts server/package.json
git commit -m "feat: add opt-in headless LSP host"
```

---

### Task 6: Live Godot 4.6 editor and owned-host acceptance

**Files:**
- Create: `tests/fixtures/godot_project/phase4/diagnostic_error.gd`
- Create: `tests/fixtures/godot_project/phase4/intelligence_fixture.gd`
- Create: `server/tests/live-phase4.test.ts`
- Modify: `server/tests/live-support.ts`
- Modify: `server/tests/live-support.test.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: production `LspHost`, `LspClient`, `createServer`, existing `launchWithPortRetry`, and the exact Godot console executable supplied through `GODOT_PATH`.
- Produces: one fail-closed live suite validating visible attach/unavailable behavior and one isolated owned-headless lifecycle.

- [ ] **Step 1: Add deterministic GDScript fixtures**

`diagnostic_error.gd` contains one stable undeclared identifier on a known line:

```gdscript
extends Node

func phase4_broken() -> void:
	print(phase4_missing_identifier)
```

`intelligence_fixture.gd` contains a typed `Sprite2D`, a typed helper signature, and uniquely named document symbols:

```gdscript
extends Node
class_name Phase4IntelligenceFixture

var phase4_sprite: Sprite2D

func phase4_sum(left: int, right: int) -> int:
	return left + right

func phase4_probe() -> void:
	phase4_sprite.queue_free()
	phase4_sum(1, 2)
```

- [ ] **Step 2: Write the live tests and confirm RED or explicit skip**

The suite skips only when `GODOT_PATH` is absent. When present, any launch, protocol, tool, compilation, timeout, or assertion failure is fatal. It must call through a real MCP client, not private handlers.

Assertions:

```ts
expect(diagnostics.diagnostics.some((d) => d.message.includes("phase4_missing_identifier"))).toBe(true);
expect(completion.items.some((item) => item.label === "queue_free")).toBe(true);
expect(documentSymbols.symbols.some((item) => item.name === "phase4_sum")).toBe(true);
expect(nativeSymbol.found).toBe(true);
expect(JSON.stringify(nativeSymbol)).toContain("Sprite2D");
expect(workspaceSymbolError).toMatchObject({ code: "feature_disabled" });
```

Run: `$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; $env:GODOT_PROJECT_PATH=(Resolve-Path 'tests\fixtures\godot_project'); cd server; npm run test:live:phase4`

Expected before final integration: FAIL at the first live mismatch, or PASS if the production implementation already satisfies the fixture. It must never report a false green after Godot compilation errors.

- [ ] **Step 3: Harden live launch and diagnostics polling from observed Godot behavior**

Use an allocated port rather than assuming 6005 is free. Start visible-editor acceptance by attaching to a launched editor process configured with that port; use `--editor --headless` in CI and permit an already open visible editor for local manual confirmation. Poll only through bounded production readiness/diagnostics APIs. Capture process output with the existing bounded helper and include it once in failures.

If Godot publishes an empty diagnostics event before parsing, wait for a later publication within the same 15-second budget. Do not add fixed sleeps or weaken the expected identifier assertion.

- [ ] **Step 4: Test completion, hover, signatures, symbols, native docs, and capability honesty**

Determine positions by locating unique ASCII fixture substrings in exact source text, then convert the prefix to UTF-16 code units. Assert completion contains `queue_free`; hover is found at `Sprite2D`; signature help includes `phase4_sum`; document symbols contain the unique class/function; `native_symbol("Sprite2D")` is found; workspace symbols fail with `feature_disabled`.

- [ ] **Step 5: Test unavailable and owned-host teardown paths**

Allocate an unused port and verify auto-start false returns `not_connected` with `--lsp-port` and `--path` in the hint. Then enable auto-start against a second allocated port, call native-symbol or document-symbol through public MCP, close the server, and verify the exact spawned PID exits within the teardown deadline. Never search for or kill Godot processes by name.

- [ ] **Step 6: Add fail-closed CI invocation**

In the existing Godot job, set `GODOT_PROJECT_PATH` to the fixture project and run `npm run test:live:phase4` after build and existing live suites. Preserve existing Godot version pinning/download behavior. The job must fail when the Phase 4 suite fails and must not use `continue-on-error`.

- [ ] **Step 7: Run live and regression verification**

Run: `$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; $env:GODOT_PROJECT_PATH=(Resolve-Path 'tests\fixtures\godot_project'); cd server; npm run test:live:phase4`

Run: `cd server && npm test -- --run && npm run typecheck && npm run build`

Expected: Phase 4 live acceptance PASS; all unit tests PASS with only explicitly documented external-archive skips; typecheck/build PASS.

- [ ] **Step 8: Commit**

```bash
git add tests/fixtures/godot_project/phase4 server/tests/live-phase4.test.ts server/tests/live-support.ts server/tests/live-support.test.ts .github/workflows/ci.yml
git commit -m "test: prove live Godot LSP integration"
```

---

### Task 7: Architecture, user documentation, and final integration

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture/02-container-channels.md`
- Modify: `docs/architecture/03-phase-dependencies.md`
- Modify: `docs/architecture/04-server-components.md`
- Modify: `docs/architecture/08-connection-lifecycles.md`
- Modify: `docs/architecture/open-questions.md`
- Modify: `docs/architecture/traceability.md`
- Modify: `docs/architecture/rendered/02-container-channels.svg`
- Modify: `docs/architecture/rendered/03-phase-dependencies.svg`
- Modify: `docs/architecture/rendered/04-server-components.svg`
- Modify: `docs/architecture/rendered/08b-lsp-lifecycle.svg`
- Modify: `docs/architecture/rendered/manifest.json`
- Create: `tests/architecture/phase4-review-regressions.test.mjs`
- Create: `.superpowers/sdd/progress.md`

**Interfaces:**
- Consumes: all Phase 4 production behavior and evidence from Tasks 1–6.
- Produces: an exact public runbook, resolved Phase 4 `Q-002` record, implemented lifecycle/component maps, regenerated checked-in diagrams, and final whole-branch evidence.

- [ ] **Step 1: Write failing documentation/architecture assertions**

Create assertions for all seven public names, `GODOT_MCP_LSP_AUTO_START`, the exact headless command shape, the Godot 4.6 workspace-symbol limitation, Phase 4's solid Phase 1 dependency, and resolution of only the Phase 4 part of `Q-002`:

```js
test("Phase 4 docs preserve capability honesty", () => {
  assert.match(readme, /godot_lsp_workspace_symbols/);
  assert.match(readme, /Godot 4\.6[^\n]*feature_disabled/i);
  assert.match(readme, /GODOT_MCP_LSP_AUTO_START/);
  assert.match(openQuestions, /Q-002[^]*Phase 4[^]*Resolved/i);
  assert.match(openQuestions, /Phase 6[^]*(unresolved|open)/i);
});
```

- [ ] **Step 2: Run architecture tests and confirm RED**

Run: `node --test tests/architecture/*.test.mjs`

Expected: FAIL because README and architecture atlas still describe Phase 4 as future/unresolved.

- [ ] **Step 3: Update the user runbook and tool reference**

Document:

- All seven inputs/outputs and read-only annotations.
- Zero-based UTF-16 positions and exact disk synchronization.
- `GODOT_LSP_PORT` default 6005 and `GODOT_MCP_LSP_AUTO_START` default false.
- Manual command: `godot --editor --headless --lsp-port 6005 --path <project>`.
- Visible-editor attach behavior and owned-child-only shutdown.
- Godot 4.6 `workspace/symbol` limitation and document-symbol alternative.
- Actionable `not_connected`, `feature_disabled`, and diagnostics-timeout guidance.

- [ ] **Step 4: Resolve Q-002 narrowly and update implemented architecture**

Mark Phase 4's dependency question resolved: Phase 1 is the API prerequisite and Phase 2 is a completed coordination/regression milestone. Leave Phase 6's dependency strength explicitly open. Update component and lifecycle entries from planned/inferred to implemented where evidence exists; do not silently relabel unrelated Phase 5–8 elements.

- [ ] **Step 5: Regenerate and validate architecture artifacts**

Run: `node docs/architecture/render.mjs`

Run: `node --test tests/architecture/*.test.mjs`

Expected: rendered SVGs and manifest match sources; all architecture tests PASS.

- [ ] **Step 6: Run the complete fail-closed verification matrix**

Run: `cd server && npm test -- --run && npm run typecheck && npm run build && npm run docs:check`

Run: `node --test tests/architecture/*.test.mjs`

Run: `$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; node tests/godot/run-smoke.mjs`

Run: `$env:GODOT_PATH='C:\Users\dasbl\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe'; $env:GODOT_PROJECT_PATH=(Resolve-Path 'tests\fixtures\godot_project'); cd server; npm run test:live && npm run test:live:phase3 && npm run test:live:phase4`

Expected: all required suites PASS; only explicitly optional external fixtures may skip; no Godot compilation/lifecycle error is accepted as green.

- [ ] **Step 7: Update the SDD ledger with exact evidence**

Record each task commit, its implementation-review result, its independent spec-review result, focused commands, live evidence, known Godot 4.6 workspace limitation, and any deliberately deferred Phase 6/7 work. Do not mark Phase 4 complete until the final whole-branch review and verification matrix both pass.

- [ ] **Step 8: Commit final integration**

```bash
git add README.md docs/architecture tests/architecture/phase4-review-regressions.test.mjs .superpowers/sdd/progress.md
git commit -m "docs: complete phase 4 integration"
```

- [ ] **Step 9: Request whole-branch review**

Use `superpowers:requesting-code-review` against the merge base through HEAD. The reviewer must inspect transport resource bounds, stale-generation isolation, path realpath containment, diagnostic freshness, capability honesty, process ownership, exact 38-tool inventory, live evidence, architecture traceability, and regressions.

If review finds issues, fix them test-first in focused commits, rerun affected suites, then rerun the complete verification matrix before offering branch completion.
