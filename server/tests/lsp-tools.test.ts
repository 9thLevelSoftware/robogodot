import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { LspToolClient } from "../src/tools/lsp.js";
import { GodotMcpError } from "../src/errors.js";

const document = { uri: "res://phase4/player.gd", fileUri: "file:///game/phase4/player.gd", path: "/game/phase4/player.gd", text: "func x():\n\tqueue_free()\n", version: 1, generation: 2 };
function fake(result: unknown, capabilities = ["completion", "hover", "signatureHelp", "documentSymbols", "workspaceSymbols", "nativeSymbol"]): LspToolClient {
  return {
    diagnostics: { sequence: 0, waitFor: vi.fn().mockResolvedValue({ uri: document.uri, generation: 2, sequence: 1, diagnostics: [], fresh: true }) },
    ensureReady: vi.fn().mockResolvedValue({ generation: 2 }),
    sync: vi.fn().mockResolvedValue(document), assertPosition: vi.fn(), supports: vi.fn((value) => capabilities.includes(value)),
    request: vi.fn().mockResolvedValue(result),
  };
}
async function harness(lsp?: LspToolClient) {
  const server = createServer({ lsp }); const client = new Client({ name: "lsp", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(st), client.connect(ct)]);
  return { server, client, close: async () => { await client.close(); await server.close(); } };
}
const errorPayload = (result: any) => JSON.parse(result.content[0].text);

describe("public LSP tools", () => {
  it("registers all seven with closed-world read-only annotations and explicit exclusions", async () => {
    const h = await harness(); try {
      const tools = (await h.client.listTools()).tools.filter(({ name }) => name.startsWith("godot_lsp_"));
      expect(tools).toHaveLength(7);
      for (const tool of tools) {
        expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
        expect(tool.description).toMatch(/rename.*format.*code actions/i);
      }
    } finally { await h.close(); }
  });

  it("maps completion independently of the editor bridge and uses the standard request", async () => {
    const lsp = fake([{ label: "queue_free", kind: 2, detail: "x" }]); const h = await harness(lsp); try {
      const value = await h.client.callTool({ name: "godot_lsp_completion", arguments: { uri: document.uri, position: { line: 1, character: 2 }, limit: 20 } });
      expect(value).toMatchObject({ structuredContent: { items: [{ label: "queue_free", kind: 2 }], truncated: false } });
      expect(lsp.request).toHaveBeenCalledWith("textDocument/completion", { textDocument: { uri: document.fileUri }, position: { line: 1, character: 2 } });
    } finally { await h.close(); }
  });

  it("normalizes Godot callable completion display labels to the symbol name", async () => {
    const h = await harness(fake([{ label: "queue_free()", insertText: "queue_free()" }, { label: "phase4_sum(…)", insertText: "phase4_sum(" }])); try {
      expect(await h.client.callTool({ name: "godot_lsp_completion", arguments: { uri: document.uri, position: { line: 1, character: 2 }, limit: 20 } })).toMatchObject({ structuredContent: { items: [{ label: "queue_free" }, { label: "phase4_sum" }] } });
    } finally { await h.close(); }
  });

  it("gates capabilities and sends the exact native-symbol payload", async () => {
    const disabled = fake([], []); const a = await harness(disabled); try {
      const value = await a.client.callTool({ name: "godot_lsp_workspace_symbols", arguments: { query: "Player" } });
      expect(value.isError).toBe(true); expect(errorPayload(value)).toMatchObject({ code: "feature_disabled" });
      expect(disabled.request).not.toHaveBeenCalled();
    } finally { await a.close(); }
    const native = fake({ name: "Sprite2D", documentation: "docs" }); const b = await harness(native); try {
      const value = await b.client.callTool({ name: "godot_lsp_native_symbol", arguments: { nativeClass: "Sprite2D" } });
      expect(value).toMatchObject({ structuredContent: { found: true, symbol: { name: "Sprite2D" } } });
      expect(native.request).toHaveBeenCalledWith("textDocument/nativeSymbol", { native_class: "Sprite2D", symbol_name: "" });
    } finally { await b.close(); }
  });

  it("establishes readiness before capability gating", async () => {
    const lsp = fake([], []); lsp.ensureReady = vi.fn().mockRejectedValue(new GodotMcpError("not_connected", "unavailable", "start Godot"));
    const h = await harness(lsp); try {
      const value = await h.client.callTool({ name: "godot_lsp_native_symbol", arguments: { nativeClass: "Sprite2D" } });
      expect(value.isError).toBe(true); expect(errorPayload(value)).toMatchObject({ code: "not_connected" });
      expect(lsp.supports).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it("normalizes null hover and disconnected fallback", async () => {
    const lsp = fake(null); const h = await harness(lsp); try {
      expect(await h.client.callTool({ name: "godot_lsp_hover", arguments: { uri: document.uri, position: { line: 0, character: 1 } } })).toMatchObject({ structuredContent: { found: false } });
    } finally { await h.close(); }
    const fallback = await harness(); try {
      const result = await fallback.client.callTool({ name: "godot_lsp_native_symbol", arguments: { nativeClass: "Node" } }); expect(result.isError).toBe(true); expect(errorPayload(result)).toMatchObject({ code: "not_connected" });
    } finally { await fallback.close(); }
  });

  it("omits malformed or unbounded nested remote ranges", async () => {
    const lsp = fake({ contents: "ok", range: { start: { line: 1_000_001, character: 0 }, end: { line: "2", character: 4 } } });
    const h = await harness(lsp); try {
      const value = await h.client.callTool({ name: "godot_lsp_hover", arguments: { uri: document.uri, position: { line: 0, character: 1 } } });
      expect(value.structuredContent).toEqual({ found: true, contents: "ok", truncated: true });
    } finally { await h.close(); }
  });

  it("strictly normalizes signature parameter labels and declares every omission", async () => {
    const signatures = Array.from({ length: 65 }, (_, index) => index === 0 ? {
      label: "f(value)", parameters: [
        { label: [0, 1], documentation: "x".repeat(9_000) }, { label: [0, "bad"] }, { label: { arbitrary: "payload" } },
        ...Array.from({ length: 63 }, () => ({ label: "value" })),
      ],
    } : { label: `f${index}()` });
    const h = await harness(fake({ signatures })); try {
      const value = await h.client.callTool({ name: "godot_lsp_signature_help", arguments: { uri: document.uri, position: { line: 0, character: 1 } } });
      expect(value.structuredContent).toMatchObject({ truncated: true, truncation: { signatures: true, parameters: true, malformed: true, strings: true } });
      const first = (value.structuredContent as any).signatures[0];
      expect(first.parameters[0].label).toEqual([0, 1]);
      expect(first.parameters).not.toContainEqual(expect.objectContaining({ label: { arbitrary: "payload" } }));
    } finally { await h.close(); }
  });

  it("declares malformed completion omissions and omits invalid text edits", async () => {
    const h = await harness(fake([{ label: "ok", textEdit: { newText: "insert", range: { start: { line: -1, character: 0 }, end: { line: 0, character: 1 } } } }, { kind: 2 }])); try {
      const value = await h.client.callTool({ name: "godot_lsp_completion", arguments: { uri: document.uri, position: { line: 0, character: 1 } } });
      expect(value.structuredContent).toEqual({ items: [{ label: "ok" }], truncated: true });
      expect(value.content[0]).toEqual({ type: "text", text: JSON.stringify(value.structuredContent) });
    } finally { await h.close(); }
  });

  it("fails closed for accessor-backed or descriptor-trapped completion items", async () => {
    let getterCalls = 0; const accessor = Object.defineProperty({}, "items", { get: () => { getterCalls++; throw new Error("items getter"); } });
    const trapped = new Proxy({}, { getOwnPropertyDescriptor: (_target, key) => { if (key === "items") throw new Error("items descriptor"); return undefined; } });
    for (const result of [accessor, trapped]) { const h = await harness(fake(result)); try {
      expect(await h.client.callTool({ name: "godot_lsp_completion", arguments: { uri: document.uri, position: { line: 0, character: 1 } } })).toMatchObject({ structuredContent: { items: [], truncated: true } });
    } finally { await h.close(); } }
    expect(getterCalls).toBe(0);
  });

  it("never executes inherited properties or accessors in arbitrary LSP results", async () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "label", { enumerable: true, get: () => { getterCalls++; throw new Error("getter ran"); } });
    const inherited = Object.create({ name: "Inherited" });
    for (const [name, result, args] of [
      ["godot_lsp_completion", [accessor], { uri: document.uri, position: { line: 0, character: 1 } }],
      ["godot_lsp_document_symbols", [inherited], { uri: document.uri }],
      ["godot_lsp_hover", Object.create({ contents: "inherited" }), { uri: document.uri, position: { line: 0, character: 1 } }],
    ] as const) {
      const h = await harness(fake(result)); try { expect((await h.client.callTool({ name, arguments: args })).isError).not.toBe(true); } finally { await h.close(); }
    }
    const native = await harness(fake(accessor)); try {
      const result = await native.client.callTool({ name: "godot_lsp_native_symbol", arguments: { nativeClass: "Node" } }); expect(result.isError).toBe(true); expect(errorPayload(result)).toMatchObject({ code: "godot_error" });
    } finally { await native.close(); }
    expect(getterCalls).toBe(0);
  });

  it("fails closed when property descriptors cannot be inspected", async () => {
    const hostile = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("descriptor trap"); } });
    const h = await harness(fake([hostile])); try {
      expect(await h.client.callTool({ name: "godot_lsp_completion", arguments: { uri: document.uri, position: { line: 0, character: 1 } } })).toMatchObject({ structuredContent: { items: [], truncated: true } });
    } finally { await h.close(); }
  });

  it("propagates diagnostic truncation metadata through the public tool", async () => {
    const lsp = fake(null); lsp.diagnostics.waitFor = vi.fn().mockResolvedValue({ uri: document.uri, generation: 2, sequence: 1, diagnostics: [], fresh: true, truncated: true, truncation: { diagnostics: true, tags: false, relatedInformation: false, strings: false, positions: false, malformed: false } });
    const h = await harness(lsp); try {
      expect(await h.client.callTool({ name: "godot_lsp_diagnostics", arguments: { uri: document.uri } })).toMatchObject({ structuredContent: { truncated: true, truncation: { diagnostics: true } } });
    } finally { await h.close(); }
  });

  it("waits past an empty diagnostics publication for a later parse result", async () => {
    const lsp = fake(null); lsp.diagnostics.waitFor = vi.fn()
      .mockResolvedValueOnce({ uri: document.uri, generation: 2, sequence: 1, diagnostics: [], fresh: true, truncated: false, truncation: {} })
      .mockResolvedValueOnce({ uri: document.uri, generation: 2, sequence: 2, diagnostics: [{ message: "phase4_missing_identifier" }], fresh: true, truncated: false, truncation: {} });
    const h = await harness(lsp); try {
      expect(await h.client.callTool({ name: "godot_lsp_diagnostics", arguments: { uri: document.uri, waitMs: 1_000 } })).toMatchObject({ structuredContent: { diagnostics: [{ message: "phase4_missing_identifier" }] } });
      expect(lsp.diagnostics.waitFor).toHaveBeenCalledTimes(2);
    } finally { await h.close(); }
  });

  it("returns the causally post-sync empty publication as fresh when no later parse result arrives", async () => {
    const empty = { uri: document.uri, generation: 2, sequence: 1, diagnostics: [], fresh: true, truncated: false, truncation: {} };
    const lsp = fake(null); lsp.diagnostics.waitFor = vi.fn()
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce({ ...empty, fresh: false });
    const h = await harness(lsp); try {
      expect(await h.client.callTool({ name: "godot_lsp_diagnostics", arguments: { uri: document.uri, waitMs: 100 } })).toMatchObject({ structuredContent: { diagnostics: [], fresh: true } });
    } finally { await h.close(); }
  });

  it("charges synchronization against the diagnostics wait budget", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(1_090);
    const lsp = fake(null); const h = await harness(lsp); try {
      const result = await h.client.callTool({ name: "godot_lsp_diagnostics", arguments: { uri: document.uri, waitMs: 100 } }); expect(result.isError).toBe(true); expect(errorPayload(result)).toMatchObject({ code: "timeout" });
      expect(lsp.diagnostics.waitFor).not.toHaveBeenCalled();
    } finally { now.mockRestore(); await h.close(); }
  });

  it("passes only the post-sync remainder to the first diagnostics wait", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValueOnce(2_000).mockReturnValueOnce(2_200).mockReturnValue(2_200);
    const lsp = fake([{ message: "parse" }]);
    lsp.diagnostics.waitFor = vi.fn().mockResolvedValue({ uri: document.uri, generation: 2, sequence: 1, diagnostics: [{ message: "parse" }], fresh: true, truncated: false, truncation: {} });
    const h = await harness(lsp); try {
      await h.client.callTool({ name: "godot_lsp_diagnostics", arguments: { uri: document.uri, waitMs: 1_000 } });
      expect(lsp.diagnostics.waitFor).toHaveBeenCalledWith(document.uri, 2, 0, 800);
    } finally { now.mockRestore(); await h.close(); }
  });

  it("never reads proxied array length through a get trap", async () => {
    let lengthGets = 0; const proxied = new Proxy([{ label: "safe" }], { get: (target, key, receiver) => { if (key === "length") { lengthGets++; throw new Error("length get"); } return Reflect.get(target, key, receiver); } });
    const h = await harness(fake(proxied)); try {
      expect(await h.client.callTool({ name: "godot_lsp_completion", arguments: { uri: document.uri, position: { line: 0, character: 1 } } })).toMatchObject({ structuredContent: { items: [{ label: "safe" }] } });
    } finally { await h.close(); }
    expect(lengthGets).toBe(0);
  });

  it("bounds documentation array work independently of byte truncation", async () => {
    const huge = new Array(1_000_000_000); huge[0] = "first"; huge[999_999_999] = "last";
    const h = await harness(fake({ contents: huge })); try {
      expect(await h.client.callTool({ name: "godot_lsp_hover", arguments: { uri: document.uri, position: { line: 0, character: 1 } } })).toMatchObject({ structuredContent: { found: true, contents: "first", truncated: true } });
    } finally { await h.close(); }
    let lengthGets = 0; const dense = Array.from({ length: 10_000 }, () => "x"); const proxied = new Proxy(dense, { get: (target, key, receiver) => { if (key === "length") { lengthGets++; throw new Error("length get"); } return Reflect.get(target, key, receiver); } });
    const p = await harness(fake({ contents: proxied })); try {
      expect(await p.client.callTool({ name: "godot_lsp_hover", arguments: { uri: document.uri, position: { line: 0, character: 1 } } })).toMatchObject({ structuredContent: { found: true, truncated: true } });
    } finally { await p.close(); }
    expect(lengthGets).toBe(0);
  });

  it("honestly declares bounded-string and malformed-range omissions for each standard result tool", async () => {
    const long = "€".repeat(4_000); const badRange = { start: { line: -1, character: 0 }, end: { line: 0, character: 1 } };
    const cases = [
      ["godot_lsp_completion", [{ label: long, textEdit: { newText: long, range: badRange } }], { uri: document.uri, position: { line: 0, character: 1 } }],
      ["godot_lsp_hover", { contents: long, range: badRange }, { uri: document.uri, position: { line: 0, character: 1 } }],
      ["godot_lsp_document_symbols", [{ name: long, range: badRange, location: { uri: long } }], { uri: document.uri }],
      ["godot_lsp_workspace_symbols", [{ name: long, location: { uri: long, range: badRange } }], { query: "x" }],
    ] as const;
    for (const [name, result, args] of cases) { const h = await harness(fake(result)); try { expect(await h.client.callTool({ name, arguments: args })).toMatchObject({ structuredContent: { truncated: true } }); } finally { await h.close(); } }
  });

  it("omits nonfinite native values and declares bounded tree omissions", async () => {
    const h = await harness(fake({ name: "x".repeat(9_000), finite: 1, nan: Number.NaN, infinity: Number.POSITIVE_INFINITY })); try {
      const result = await h.client.callTool({ name: "godot_lsp_native_symbol", arguments: { nativeClass: "Node" } });
      expect(result).toMatchObject({ structuredContent: { found: true, truncated: true, symbol: { finite: 1 } } });
      expect((result.structuredContent as any).symbol).not.toHaveProperty("nan");
      expect(result.content[0]).toEqual({ type: "text", text: JSON.stringify(result.structuredContent) });
    } finally { await h.close(); }
  });
});
