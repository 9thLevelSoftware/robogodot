import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { LspToolClient } from "../src/tools/lsp.js";

const document = { uri: "res://phase4/player.gd", fileUri: "file:///game/phase4/player.gd", path: "/game/phase4/player.gd", text: "func x():\n\tqueue_free()\n", version: 1, generation: 2 };
function fake(result: unknown, capabilities = ["completion", "hover", "signatureHelp", "documentSymbols", "workspaceSymbols", "nativeSymbol"]): LspToolClient {
  return {
    diagnostics: { sequence: 0, waitFor: vi.fn().mockResolvedValue({ uri: document.uri, generation: 2, sequence: 1, diagnostics: [], fresh: true }) },
    sync: vi.fn().mockResolvedValue(document), assertPosition: vi.fn(), supports: vi.fn((value) => capabilities.includes(value)),
    request: vi.fn().mockResolvedValue(result),
  };
}
async function harness(lsp?: LspToolClient) {
  const server = createServer({ lsp }); const client = new Client({ name: "lsp", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(st), client.connect(ct)]);
  return { server, client, close: async () => { await client.close(); await server.close(); } };
}

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

  it("gates capabilities and sends the exact native-symbol payload", async () => {
    const disabled = fake([], []); const a = await harness(disabled); try {
      const value = await a.client.callTool({ name: "godot_lsp_workspace_symbols", arguments: { query: "Player" } });
      expect(value).toMatchObject({ isError: true, structuredContent: { code: "feature_disabled" } });
      expect(disabled.request).not.toHaveBeenCalled();
    } finally { await a.close(); }
    const native = fake({ name: "Sprite2D", documentation: "docs" }); const b = await harness(native); try {
      const value = await b.client.callTool({ name: "godot_lsp_native_symbol", arguments: { nativeClass: "Sprite2D" } });
      expect(value).toMatchObject({ structuredContent: { found: true, symbol: { name: "Sprite2D" } } });
      expect(native.request).toHaveBeenCalledWith("textDocument/nativeSymbol", { native_class: "Sprite2D", symbol_name: "" });
    } finally { await b.close(); }
  });

  it("normalizes null hover and disconnected fallback", async () => {
    const lsp = fake(null); const h = await harness(lsp); try {
      expect(await h.client.callTool({ name: "godot_lsp_hover", arguments: { uri: document.uri, position: { line: 0, character: 1 } } })).toMatchObject({ structuredContent: { found: false } });
    } finally { await h.close(); }
    const fallback = await harness(); try {
      expect(await fallback.client.callTool({ name: "godot_lsp_native_symbol", arguments: { nativeClass: "Node" } })).toMatchObject({ isError: true, structuredContent: { code: "not_connected" } });
    } finally { await fallback.close(); }
  });

  it("omits malformed or unbounded nested remote ranges", async () => {
    const lsp = fake({ contents: "ok", range: { start: { line: 1_000_001, character: 0 }, end: { line: "2", character: 4 } } });
    const h = await harness(lsp); try {
      const value = await h.client.callTool({ name: "godot_lsp_hover", arguments: { uri: document.uri, position: { line: 0, character: 1 } } });
      expect(value.structuredContent).toEqual({ found: true, contents: "ok" });
    } finally { await h.close(); }
  });
});
