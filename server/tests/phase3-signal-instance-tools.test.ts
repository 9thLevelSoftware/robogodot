import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";

async function harness(call = vi.fn()) {
  const server = createServer({ bridge: { getStatus: () => ({ state: "connected" as const, url: "ws://x", connectedSince: "now", reconnectAttempt: 0 }), call } });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, call, close: () => Promise.all([client.close(), server.close()]) };
}

describe("Phase 3 signal and instance tools", () => {
  it("registers instance and exactly three strict signal tools", async () => {
    const h = await harness(); try {
      const tools = (await h.client.listTools()).tools;
      expect(tools.filter(t => /scene_instance|signal_/.test(t.name)).map(t => t.name)).toEqual(["godot_scene_instance", "godot_signal_list", "godot_signal_connect", "godot_signal_disconnect"]);
      expect(tools.filter(t => /scene_instance|signal_/.test(t.name)).every(t => t.inputSchema.additionalProperties === false)).toBe(true);
    } finally { await h.close(); }
  });

  it("maps callable, flags, pagination and scene response", async () => {
    const call = vi.fn(async (method: string, p: any) => method === "edit.signal_list" ? { signals: [], truncated: false } : method === "edit.node_instance" ? { path: `${p.parent}/Child`, type: "Node2D", scenePath: p.scenePath } : { source: p.source, signal: p.signal, callable: p.callable, flags: method === "edit.signal_connect" ? p.flags : 7 });
    const h = await harness(call); try {
      await h.client.callTool({ name: "godot_scene_instance", arguments: { parent: "/root/Main", scenePath: "res://phase3/instanced_child.tscn" } });
      expect(call).toHaveBeenLastCalledWith("edit.node_instance", { parent: "/root/Main", scenePath: "res://phase3/instanced_child.tscn" }, expect.any(Object));
      await h.client.callTool({ name: "godot_signal_list", arguments: { path: "/root/Main", cursor: "0", limit: 5 } });
      expect(call).toHaveBeenLastCalledWith("edit.signal_list", { path: "/root/Main", cursor: "0", limit: 5 }, expect.any(Object));
      await h.client.callTool({ name: "godot_signal_connect", arguments: { source: "/root/Main", signal: "ready", callable: { target: "/root/Main/Child", method: "on_ready" }, flags: 3 } });
      expect(call).toHaveBeenLastCalledWith("edit.signal_connect", { source: "/root/Main", signal: "ready", callable: { target: "/root/Main/Child", method: "on_ready" }, flags: 3 }, expect.any(Object));
      await h.client.callTool({ name: "godot_signal_disconnect", arguments: { source: "/root/Main", signal: "ready", callable: { target: "/root/Main/Child", method: "on_ready" } } });
      expect(call).toHaveBeenLastCalledWith("edit.signal_disconnect", { source: "/root/Main", signal: "ready", callable: { target: "/root/Main/Child", method: "on_ready" } }, expect.any(Object));
    } finally { await h.close(); }
  });

  it("enforces ConnectFlags mask and strict disconnect shape before dispatch", async () => {
    const h = await harness(); try {
      const base = { source: "/root/Main", signal: "ready", callable: { target: "/root/Main", method: "on_ready" } };
      for (const flags of [16, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect((await h.client.callTool({ name: "godot_signal_connect", arguments: { ...base, flags } })).isError).toBe(true);
      expect((await h.client.callTool({ name: "godot_signal_disconnect", arguments: { ...base, flags: 1 } })).isError).toBe(true);
      expect(h.call).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it("accepts exact paginated list metadata and rejects malformed truncation fields", async () => {
    const page = { signals: [{ name: "changed", arguments: [{ name: "value", type: 2 }], connections: [{ callable: { target: "/root/Main/A", method: "on_changed" }, flags: 1 }], connectionCount: 300, connectionsTruncated: true }], truncated: true, nextCursor: "1" };
    const h = await harness(vi.fn().mockResolvedValue(page)); try {
      expect((await h.client.callTool({ name: "godot_signal_list", arguments: { path: "/root/Main", limit: 1 } })).structuredContent).toEqual(page);
    } finally { await h.close(); }
    const bad = await harness(vi.fn().mockResolvedValue({ signals: [{ name: "x", arguments: [], connections: [], connectionCount: 0 }], truncated: false })); try {
      expect((await bad.client.callTool({ name: "godot_signal_list", arguments: { path: "/root/Main" } })).isError).toBe(true);
    } finally { await bad.close(); }
  });

  it("rejects noncanonical and byte-overflow inputs before dispatch", async () => {
    const h = await harness(); try {
      for (const arguments_ of [{ parent: "/root/Main", scenePath: "user://x.tscn" }, { parent: "/root/Main", scenePath: "res://a/../x.tscn" }])
        expect((await h.client.callTool({ name: "godot_scene_instance", arguments: arguments_ })).isError).toBe(true);
      expect((await h.client.callTool({ name: "godot_signal_connect", arguments: { source: "/root/Main", signal: "é".repeat(129), callable: { target: "/root/Main", method: "ok" } } })).isError).toBe(true);
      expect(h.call).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it("serializes signal mutations through the shared FIFO lane", async () => {
    const releases: Array<() => void> = []; const call = vi.fn((_m: string, p: any) => new Promise<any>(resolve => releases.push(() => resolve({ source: p.source, signal: p.signal, callable: p.callable, flags: p.flags ?? 0 }))));
    const h = await harness(call); try {
      const args = { source: "/root/Main", signal: "ready", callable: { target: "/root/Main", method: "on_ready" } };
      const a = h.client.callTool({ name: "godot_signal_connect", arguments: args }); const b = h.client.callTool({ name: "godot_signal_disconnect", arguments: args });
      await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1)); releases[0]!(); await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2)); releases[1]!(); await Promise.all([a,b]);
    } finally { await h.close(); }
  });
});
