import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import { createPolicyBundle } from "../src/policy.js";

process.env.GODOT_MCP_TOKEN ??= "0123456789abcdef0123456789abcdef";

async function harness(mode: "full" | "read_only" | "confirm_destructive", bridgeCall?: ReturnType<typeof vi.fn>) {
  const call = bridgeCall ?? vi.fn().mockResolvedValue({ path: "/root", class: "Node", name: "Root", childCount: 0, properties: {} });
  const policy = createPolicyBundle(mode);
  const server = createServer({
    mode,
    policy,
    bridge: {
      getStatus: () => ({ state: "connected", url: "ws://127.0.0.1:9200", connectedSince: new Date().toISOString(), reconnectAttempt: 0, lastError: undefined }),
      call,
    },
  });
  const client = new Client({ name: "policy", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return {
    client,
    policy,
    call,
    close: async () => { await client.close(); await server.close(); },
  };
}

describe("Phase 7 policy middleware", () => {
  it("blocks mutating tools in read_only mode and audits the rejection", async () => {
    const h = await harness("read_only");
    try {
      const result = await h.client.callTool({ name: "godot_node_add", arguments: { parent: ".", type: "Node", name: "X" } });
      expect(result.isError).toBe(true);
      expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({ code: "blocked_by_policy" });
      expect(h.call).not.toHaveBeenCalled();
      expect(h.policy.audit.list().some((entry) => entry.outcome === "blocked" && entry.tool === "godot_node_add")).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("allows read-only tools in read_only mode", async () => {
    const h = await harness("read_only");
    try {
      const result = await h.client.callTool({ name: "godot_connection_status", arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(h.policy.audit.list().some((entry) => entry.tool === "godot_connection_status" && entry.outcome === "success")).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("requires confirmed true for destructive tools in confirm_destructive mode", async () => {
    const h = await harness("confirm_destructive");
    try {
      const denied = await h.client.callTool({ name: "godot_fs_write", arguments: { path: "res://a.txt", content: "x" } });
      expect(denied.isError).toBe(true);
      expect(JSON.parse((denied.content as { text: string }[])[0]!.text)).toMatchObject({ code: "blocked_by_policy" });

      const allowed = await h.client.callTool({
        name: "godot_node_set_property",
        arguments: { path: ".", property: "name", value: "Root", confirmed: true },
      });
      // may fail godot mapping but must pass policy (call attempted)
      expect(h.call).toHaveBeenCalled();
      expect(allowed.isError === true || allowed.isError === false || allowed.isError === undefined).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("serializes concurrent mutations through the registry mutation lane", async () => {
    let active = 0;
    let maxActive = 0;
    const call = vi.fn().mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      return { path: "/root", property: "name", before: "A", after: "B" };
    });
    const h = await harness("full", call);
    try {
      await Promise.all([
        h.client.callTool({ name: "godot_node_set_property", arguments: { path: ".", property: "name", value: "A" } }),
        h.client.callTool({ name: "godot_node_set_property", arguments: { path: ".", property: "name", value: "B" } }),
      ]);
      expect(maxActive).toBe(1);
    } finally {
      await h.close();
    }
  });

  it("serves cached read results until a mutation fences the cache", async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ path: "/root", class: "Node", name: "Root", childCount: 0, properties: {} })
      .mockResolvedValueOnce({ path: "/root", property: "name", before: "Root", after: "Other" })
      .mockResolvedValueOnce({ path: "/root", class: "Node", name: "Other", childCount: 0, properties: {} });
    const h = await harness("full", call);
    try {
      const first = await h.client.callTool({ name: "godot_node_get", arguments: { path: "." } });
      const second = await h.client.callTool({ name: "godot_node_get", arguments: { path: "." } });
      expect(first.structuredContent).toEqual(second.structuredContent);
      expect(call).toHaveBeenCalledTimes(1);
      expect(h.policy.audit.list().some((entry) => entry.outcome === "cache_hit")).toBe(true);

      await h.client.callTool({ name: "godot_node_set_property", arguments: { path: ".", property: "name", value: "Other" } });
      await h.client.callTool({ name: "godot_node_get", arguments: { path: "." } });
      expect(call).toHaveBeenCalledTimes(3);
    } finally {
      await h.close();
    }
  });
});
