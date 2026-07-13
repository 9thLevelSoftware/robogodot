import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

async function harness(runtime?: any) { const server = createServer({ runtime }); const client = new Client({ name: "runtime", version: "1" }); const [ct, st] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(st), client.connect(ct)]); return { client, close: async () => { await client.close(); await server.close(); } }; }

describe("public runtime process tools", () => {
  it("registers exactly three tools with reviewed annotations", async () => { const h = await harness(); try { const tools = (await h.client.listTools()).tools.filter(t => ["godot_run_project", "godot_stop_project", "godot_run_output"].includes(t.name)); expect(tools.map(t => t.name)).toEqual(["godot_run_project", "godot_stop_project", "godot_run_output"]); expect(tools.map(t => t.annotations)).toEqual([
      { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    ]); expect(await h.client.callTool({ name: "godot_run_project", arguments: {} })).toMatchObject({ isError: true, structuredContent: { code: "not_connected", message: "The runtime process service is not configured." } }); } finally { await h.close(); } });

  it("dispatches normalized inputs and outputs independently of editor and LSP", async () => {
    const runtime = { launch: vi.fn().mockResolvedValue({ id: "a".repeat(32), mode: "normal", state: "running", pid: 4, startedAt: 9, bridgeTransport: "socket" }), stop: vi.fn().mockResolvedValue({ sessionId: "a".repeat(32), graceful: true, forced: false }), output: vi.fn().mockResolvedValue({ sessionId: "a".repeat(32), running: true, records: [], next: 0, lost: 0, truncated: false }) };
    const h = await harness(runtime); try { expect(await h.client.callTool({ name: "godot_run_project", arguments: { scene: "res://main.tscn", arguments: ["--headless"] } })).toMatchObject({ structuredContent: { sessionId: "a".repeat(32), mode: "normal", pid: 4 } }); expect(runtime.launch).toHaveBeenCalledWith("normal", { scene: "res://main.tscn", args: ["--headless"] });
      expect(await h.client.callTool({ name: "godot_run_output", arguments: { sessionId: "a".repeat(32), since: 0, limit: 500 } })).toMatchObject({ structuredContent: { running: true, records: [] } });
    } finally { await h.close(); }
  });

  it("rejects strict paths, argument byte limits, totals, cursors, and pages with stable errors", async () => { const h = await harness({ launch: vi.fn(), stop: vi.fn(), output: vi.fn() }); try { const bad = [
      ["godot_run_project", { scene: "main.tscn" }], ["godot_run_project", { arguments: Array(33).fill("x") }], ["godot_run_project", { arguments: ["é".repeat(513)] }], ["godot_run_project", { arguments: Array(9).fill("x".repeat(1024)) }],
      ["godot_run_output", { sessionId: "a".repeat(32), since: Number.MAX_SAFE_INTEGER + 1, limit: 1 }], ["godot_run_output", { sessionId: "a".repeat(32), since: 0, limit: 501 }],
    ] as const; for (const [name, args] of bad) expect(await h.client.callTool({ name, arguments: args as any }), `${name} ${JSON.stringify(args)}`).toMatchObject({ isError: true }); expect(await h.client.callTool({ name: "godot_run_project", arguments: { extra: true } })).toMatchObject({ isError: true }); } finally { await h.close(); } });
});
