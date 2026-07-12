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

describe("Phase 3 resource and project tools", () => {
  it("registers six exact tools with opaque handles and exact annotations", async () => {
    const h = await harness();
    try {
      const tools = (await h.client.listTools()).tools.slice(-6);
      expect(tools.map(tool => tool.name)).toEqual([
        "godot_resource_load", "godot_resource_create", "godot_resource_save",
        "godot_project_setting_get", "godot_project_setting_set", "godot_project_setting_list",
      ]);
      expect(tools.every(tool => tool.inputSchema.additionalProperties === false)).toBe(true);
      const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
      const create = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
      const persist = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
      const mutate = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
      expect(tools.map(tool => tool.annotations)).toEqual([read, create, persist, read, mutate, read]);
      expect(tools[2]?.description).toMatch(/not (?:Ctrl-Z|undo)/i);
      expect(tools[4]?.inputSchema.properties).not.toHaveProperty("undoable");
    } finally { await h.close(); }
  });

  it("dispatches exact bounded curated calls and rejects forged handles and unsafe paths", async () => {
    const handle = "res_0123456789abcdefghijkl";
    const call = vi.fn(async (method: string) => {
      if (method === "edit.resource_save") return { handle, path: "res://data/a.tres", class: "Resource" };
      return { handle, class: "Resource", path: "" };
    });
    const h = await harness(call);
    try {
      await h.client.callTool({ name: "godot_resource_load", arguments: { path: "res://data/a.tres" } });
      expect(call).toHaveBeenLastCalledWith("edit.resource_load", { path: "res://data/a.tres" }, expect.any(Object));
      await h.client.callTool({ name: "godot_resource_create", arguments: { class: "Resource", properties: { resource_name: "sample" } } });
      expect(call).toHaveBeenLastCalledWith("edit.resource_create", { class: "Resource", properties: { resource_name: "sample" } }, expect.any(Object));
      await h.client.callTool({ name: "godot_resource_save", arguments: { handle, path: "res://data/a.tres", overwrite: true } });
      expect(call).toHaveBeenLastCalledWith("edit.resource_save", { handle, path: "res://data/a.tres", overwrite: true }, expect.any(Object));
      for (const arguments_ of [
        { handle: "res_forged", path: "res://data/a.tres" },
        { handle, path: "res://data/../a.tres" },
        { handle, path: "C:\\a.tres" },
      ]) expect((await h.client.callTool({ name: "godot_resource_save", arguments: arguments_ })).isError).toBe(true);
      expect(call).toHaveBeenCalledTimes(3);
    } finally { await h.close(); }
  });

  it("validates own-property setting keys, stable pagination, variants, and exact response versions", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "edit.project_setting_list") return { settings: [{ key: "display/window/size/viewport_width", value: 1152 }], truncated: true, nextCursor: "1" };
      if (method === "edit.project_setting_get") return { key: "display/window/size/viewport_width", exists: true, value: 1152 };
      return { key: "display/window/size/viewport_width", beforeExists: true, before: 1152, after: 1280 };
    });
    const h = await harness(call);
    try {
      const listed = await h.client.callTool({ name: "godot_project_setting_list", arguments: { prefix: "display/", cursor: "0", limit: 1 } });
      expect(listed.structuredContent).toMatchObject({ settings: [{ key: "display/window/size/viewport_width", value: 1152 }], nextCursor: "1" });
      await h.client.callTool({ name: "godot_project_setting_get", arguments: { key: "display/window/size/viewport_width" } });
      await h.client.callTool({ name: "godot_project_setting_set", arguments: { key: "display/window/size/viewport_width", value: 1280 } });
      expect(call).toHaveBeenLastCalledWith("edit.project_setting_set", { key: "display/window/size/viewport_width", value: 1280 }, expect.any(Object));
      for (const key of ["__proto__", "constructor", "prototype", "", "a//b"])
        expect((await h.client.callTool({ name: "godot_project_setting_get", arguments: { key } })).isError).toBe(true);
      for (const cursor of ["00", "+1", "-1"])
        expect((await h.client.callTool({ name: "godot_project_setting_list", arguments: { cursor } })).isError).toBe(true);
    } finally { await h.close(); }
  });

  it("serializes setting mutations through the shared FIFO lane", async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const call = vi.fn(async (_method: string, input: any) => {
      if (input.value === 1) await blocked;
      return { key: input.key, beforeExists: false, after: input.value };
    });
    const h = await harness(call);
    try {
      const first = h.client.callTool({ name: "godot_project_setting_set", arguments: { key: "phase3/a", value: 1 } });
      await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
      const second = h.client.callTool({ name: "godot_project_setting_set", arguments: { key: "phase3/b", value: 2 } });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(call).toHaveBeenCalledTimes(1);
      release(); await Promise.all([first, second]);
      expect(call.mock.calls.map(entry => entry[1].value)).toEqual([1, 2]);
    } finally { await h.close(); }
  });

  it("rejects malformed or wrong-version bridge payloads", async () => {
    for (const payload of [{ handle: "res_short", class: "Resource", path: "" }, { handle: "res_0123456789abcdefghijkl", class: "Resource", path: "", extra: true }]) {
      const h = await harness(vi.fn().mockResolvedValue(payload));
      try { expect((await h.client.callTool({ name: "godot_resource_create", arguments: { class: "Resource" } })).isError).toBe(true); }
      finally { await h.close(); }
    }
  });
});
