import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";

async function harness(call = vi.fn()) {
  const server = createServer({ bridge: { getStatus: () => ({ state: "connected", url: "ws://x", connectedSince: "now", reconnectAttempt: 0 }), call } });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, call, close: () => Promise.all([client.close(), server.close()]) };
}

describe("Phase 3 node tools", () => {
  it("registers exactly eight strict node tools with accurate annotations", async () => {
    const h = await harness();
    try {
      const tools = (await h.client.listTools()).tools.slice(8);
      expect(tools.map(t => t.name)).toEqual(["godot_node_add", "godot_node_delete", "godot_node_reparent", "godot_node_rename", "godot_node_duplicate", "godot_node_get", "godot_node_set_property", "godot_node_call_method"]);
      expect(tools.every(t => t.inputSchema.additionalProperties === false)).toBe(true);
      expect(tools.slice(0, 5).concat(tools.slice(6, 7)).every(t => t.annotations?.readOnlyHint === false)).toBe(true);
      expect([tools[5], tools[7]].every(t => t?.annotations?.readOnlyHint === true)).toBe(true);
    } finally { await h.close(); }
  });

  it("maps reads, mutations, variants, and allowlisted methods", async () => {
    const call = vi.fn(async (method: string, params: any) => method === "edit.node_get" ? { ok: true, path: params.path, class: "Node", name: "Main", childCount: 0, properties: {} } : { ok: true, ...params });
    const h = await harness(call);
    try {
      await h.client.callTool({ name: "godot_node_add", arguments: { parent: "/root/Main", type: "Node2D", name: "C", properties: { position: "Vector2(1,2)" } } });
      expect(call).toHaveBeenCalledWith("edit.node_add", { parent: "/root/Main", type: "Node2D", name: "C", properties: { position: "Vector2(1,2)" } }, expect.any(Object));
      await h.client.callTool({ name: "godot_node_call_method", arguments: { path: "/root/Main", method: "get_child_count", args: [] } });
      expect(call).toHaveBeenLastCalledWith("edit.node_call_readonly", { path: "/root/Main", method: "get_child_count", args: [] }, expect.any(Object));
    } finally { await h.close(); }
  });

  it("rejects unsafe methods and UTF-8 overflow without dispatch", async () => {
    const h = await harness();
    try {
      const unsafe = await h.client.callTool({ name: "godot_node_call_method", arguments: { path: "/root/Main", method: "queue_free", args: [] } });
      expect(unsafe).toMatchObject({ isError: true, structuredContent: { code: "invalid_args" } });
      const large = await h.client.callTool({ name: "godot_node_get", arguments: { path: `/${"é".repeat(512)}` } });
      expect(large.isError).toBe(true);
      expect(h.call).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it("normalizes malformed responses", async () => {
    const h = await harness(vi.fn().mockResolvedValue({ unexpected: true }));
    try {
      const response = await h.client.callTool({ name: "godot_node_get", arguments: { path: "/root/Main" } });
      expect(response).toMatchObject({ isError: true, structuredContent: { code: "godot_error" } });
    } finally { await h.close(); }
  });
});
