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
  it("registers strict node tools with accurate annotations", async () => {
    const h = await harness();
    try {
      const tools = (await h.client.listTools()).tools.slice(8, 17);
      expect(tools.map(t => t.name)).toEqual(["godot_node_add", "godot_node_delete", "godot_node_reparent", "godot_node_rename", "godot_node_duplicate", "godot_node_get", "godot_node_set_property", "godot_node_call_method", "godot_scene_instance"]);
      expect(tools.every(t => t.inputSchema.additionalProperties === false)).toBe(true);
      const mutation = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
      const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
      for (const tool of tools.slice(0, 5).concat(tools.slice(6, 7), tools.slice(8, 9))) expect(tool.annotations).toEqual(mutation);
      for (const tool of [tools[5], tools[7]]) expect(tool?.annotations).toEqual(read);
    } finally { await h.close(); }
  });

  it("maps reads, mutations, variants, and allowlisted methods", async () => {
    const call = vi.fn(async (method: string, params: any) => method === "edit.node_get" ? { path: params.path, class: "Node", name: "Main", childCount: 0, properties: {} } : method === "edit.node_call_readonly" ? { path: params.path, method: params.method, value: 0 } : { path: `${params.parent}/C` });
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

  it("enforces 256-byte property and method boundaries while node names remain 255", async () => {
    const call = vi.fn().mockResolvedValue({ path: "/root/Main", property: "x", before: 0, after: 1 });
    const h = await harness(call);
    try {
      const property256 = "p".repeat(256);
      await h.client.callTool({ name: "godot_node_set_property", arguments: { path: "/root/Main", property: property256, value: 1 } });
      expect(call).toHaveBeenCalledTimes(1);
      const property257 = await h.client.callTool({ name: "godot_node_set_property", arguments: { path: "/root/Main", property: "p".repeat(257), value: 1 } });
      expect(property257.isError).toBe(true);
      const method257 = await h.client.callTool({ name: "godot_node_call_method", arguments: { path: "/root/Main", method: "m".repeat(257), args: [] } });
      expect(method257.isError).toBe(true);
      const method256 = await h.client.callTool({ name: "godot_node_call_method", arguments: { path: "/root/Main", method: "m".repeat(256), args: [] } });
      expect(method256).toMatchObject({ isError: true, structuredContent: { code: "invalid_args" } });
      const name256 = await h.client.callTool({ name: "godot_node_rename", arguments: { path: "/root/Main", name: "n".repeat(256) } });
      expect(name256.isError).toBe(true);
      expect(call).toHaveBeenCalledTimes(1);
    } finally { await h.close(); }
  });

  it("maps every mutation with defaults, exact curated options, and FIFO ordering", async () => {
    const releases: Array<() => void> = [];
    const call = vi.fn((method: string, params: any) => new Promise<any>(resolve => releases.push(() => resolve(method === "edit.node_set_property" ? { path: params.path, property: params.property, before: 0, after: params.value } : { path: params.path ?? `${params.parent}/${params.name ?? "Node"}` }))));
    const h = await harness(call);
    try {
      const cases = [
        ["godot_node_add", { parent: "/root/Main", type: "Node", name: "N" }, "edit.node_add", { parent: "/root/Main", type: "Node", name: "N", properties: {} }],
        ["godot_node_delete", { path: "/root/Main/N" }, "edit.node_delete", { path: "/root/Main/N" }],
        ["godot_node_reparent", { path: "/root/Main/N", parent: "/root/Main/P" }, "edit.node_reparent", { path: "/root/Main/N", parent: "/root/Main/P" }],
        ["godot_node_rename", { path: "/root/Main/N", name: "R" }, "edit.node_rename", { path: "/root/Main/N", name: "R" }],
        ["godot_node_duplicate", { path: "/root/Main/N" }, "edit.node_duplicate", { path: "/root/Main/N", flags: 15 }],
        ["godot_node_set_property", { path: "/root/Main/N", property: "process_priority", value: 1 }, "edit.node_set_property", { path: "/root/Main/N", property: "process_priority", value: 1 }],
      ] as const;
      const pending = cases.map(([name, args]) => h.client.callTool({ name, arguments: args }));
      await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
      for (let index = 0; index < cases.length; index++) {
        releases[index]?.();
        if (index + 1 < cases.length) await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(index + 2));
      }
      await Promise.all(pending);
      cases.forEach(([, , method, params], index) => expect(call).toHaveBeenNthCalledWith(index + 1, method, params, { timeoutMs: 15000, maxRequestBytes: 32768 }));
    } finally { await h.close(); }
  });

  it("normalizes responses over 262144 serialized bytes", async () => {
    const h = await harness(vi.fn().mockResolvedValue({ path: "/root/Main", class: "Node", name: "Main", childCount: 0, properties: { huge: "x".repeat(262144) } }));
    try {
      const result = await h.client.callTool({ name: "godot_node_get", arguments: { path: "/root/Main" } });
      expect(result).toMatchObject({ isError: true, structuredContent: { code: "godot_error" } });
    } finally { await h.close(); }
  });

  it("rejects non-JSON Variant values before dispatch and accepts typed/literal values", async () => {
    const call = vi.fn().mockResolvedValue({ path: "/root/Main", property: "position", before: null, after: null });
    const h = await harness(call);
    try {
      await h.client.callTool({ name: "godot_node_set_property", arguments: { path: "/root/Main", property: "position", value: { $type: "Vector2", x: 1, y: 2 } } });
      await h.client.callTool({ name: "godot_node_set_property", arguments: { path: "/root/Main", property: "position", value: "Vector2(1,2)" } });
      const invalid = await h.client.callTool({ name: "godot_node_set_property", arguments: { path: "/root/Main", property: "position", value: Number.NaN } });
      expect(invalid.isError).toBe(true);
      expect(call).toHaveBeenCalledTimes(2);
    } finally { await h.close(); }
  });
});
