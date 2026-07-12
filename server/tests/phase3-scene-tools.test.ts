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

describe("Phase 3 scene tools", () => {
  it("registers five scene tools with lifecycle, persistence, and read annotations", async () => {
    const h = await harness();
    try {
      const tools = (await h.client.listTools()).tools.slice(16);
      expect(tools.map(t => t.name)).toEqual(["godot_scene_open", "godot_scene_new", "godot_scene_save", "godot_scene_tree", "godot_scene_current"]);
      expect(tools.every(t => t.inputSchema.additionalProperties === false)).toBe(true);
      const lifecycle = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
      const persistence = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
      const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
      expect(tools[0]?.annotations).toEqual(lifecycle); expect(tools[1]?.annotations).toEqual(lifecycle);
      expect(tools[2]?.annotations).toEqual(persistence);
      expect(tools[3]?.annotations).toEqual(read); expect(tools[4]?.annotations).toEqual(read);
      expect(tools[2]?.description).toMatch(/non-undoable/i);
    } finally { await h.close(); }
  });

  it("dispatches canonical project paths, defaults, and explicit confirmations", async () => {
    const call = vi.fn(async (method: string) => method === "edit.scene_tree" ? { nodes: [], truncated: false } : { path: "res://phase3/a.tscn", unsaved: false });
    const h = await harness(call);
    try {
      await h.client.callTool({ name: "godot_scene_open", arguments: { path: "res://phase3/a.tscn", discardUnsaved: true } });
      expect(call).toHaveBeenLastCalledWith("edit.scene_open", { path: "res://phase3/a.tscn", discardUnsaved: true }, expect.any(Object));
      await h.client.callTool({ name: "godot_scene_new", arguments: { rootType: "Node2D", rootName: "Main", discardUnsaved: true } });
      expect(call).toHaveBeenLastCalledWith("edit.scene_new", { rootType: "Node2D", rootName: "Main", discardUnsaved: true }, expect.any(Object));
      await h.client.callTool({ name: "godot_scene_save", arguments: { path: "res://phase3/a.tscn", overwrite: true } });
      expect(call).toHaveBeenLastCalledWith("edit.scene_save", { path: "res://phase3/a.tscn", overwrite: true }, expect.any(Object));
      await h.client.callTool({ name: "godot_scene_tree", arguments: {} });
      expect(call).toHaveBeenLastCalledWith("edit.scene_tree", { maxDepth: 8, limit: 100 }, expect.any(Object));
    } finally { await h.close(); }
  });

  it("rejects absolute and traversal paths before bridge dispatch", async () => {
    const h = await harness();
    try {
      for (const path of ["C:\\outside.tscn", "/tmp/outside.tscn", "res://phase3/../outside.tscn", "user://outside.tscn"]) {
        const result = await h.client.callTool({ name: "godot_scene_open", arguments: { path } });
        expect(result.isError).toBe(true);
      }
      expect(h.call).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it("preserves stable ordered tree pages and cursor", async () => {
    const page = { nodes: [{ name: "A", class: "Node", path: "/root/Main/A", children: [] }, { name: "B", class: "Node", path: "/root/Main/B", children: [] }], truncated: true, nextCursor: "2" };
    const h = await harness(vi.fn().mockResolvedValue(page));
    try {
      const result = await h.client.callTool({ name: "godot_scene_tree", arguments: { root: "/root/Main", maxDepth: 2, cursor: "0", limit: 2 } });
      expect(result.structuredContent).toEqual(page);
      expect(h.call).toHaveBeenCalledWith("edit.scene_tree", { root: "/root/Main", maxDepth: 2, cursor: "0", limit: 2 }, expect.any(Object));
    } finally { await h.close(); }
  });

  it("represents a new unsaved scene with an empty persistence path", async () => {
    const h = await harness(vi.fn().mockResolvedValue({ path: "", unsaved: true }));
    try {
      const result = await h.client.callTool({ name: "godot_scene_new", arguments: {} });
      expect(result).toMatchObject({ structuredContent: { path: "", unsaved: true } });
    } finally { await h.close(); }
  });
});
