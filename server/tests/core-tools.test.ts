import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import type { ClientStatus } from "../src/bridge/ws-client.js";
import { createServer } from "../src/server.js";
import { GodotMcpError } from "../src/errors.js";

const disconnected: ClientStatus = {
  state: "disconnected", url: "ws://127.0.0.1:9200", connectedSince: undefined,
  reconnectAttempt: 0, lastError: undefined,
};

async function harness(bridge: { getStatus(): ClientStatus; call<T>(method: string, params?: unknown): Promise<T> }) {
  const server = createServer({ bridge });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

describe("core MCP tools", () => {
  it("lists exactly the three probes with empty schemas and closed-world read-only annotations", async () => {
    const bridge = { getStatus: () => disconnected, call: vi.fn() as never };
    const { client, close } = await harness(bridge);
    try {
      const { tools } = await client.listTools();
      expect(tools.slice(0, 3).map((tool) => tool.name)).toEqual(["godot_connection_status", "godot_get_version", "godot_ping"]);
      for (const tool of tools.slice(0, 3)) {
        expect(tool.inputSchema).toEqual({ $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: {}, additionalProperties: false });
        expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      }
    } finally { await close(); }
  });

  it("returns disconnected status locally without crossing the bridge", async () => {
    const call = vi.fn();
    const { client, close } = await harness({ getStatus: () => disconnected, call });
    try {
      const result = await client.callTool({ name: "godot_connection_status", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(disconnected);
      expect(call).not.toHaveBeenCalled();
    } finally { await close(); }
  });

  it.each([["godot_get_version", "core.get_version"], ["godot_ping", "core.ping"]])("maps %s to %s", async (name, method) => {
    const call = vi.fn().mockResolvedValue(name === "godot_ping" ? { pong: true } : { engine: { string: "4.4" }, plugin: "0.1.0", projectPath: "C:/game", connected: true });
    const { client, close } = await harness({ getStatus: () => ({ ...disconnected, state: "connected" }), call });
    try {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(call).toHaveBeenCalledWith(method);
      if (name === "godot_ping") expect(result.structuredContent).toEqual({ connected: true, pong: true, latencyMs: expect.any(Number) });
      else expect(result.structuredContent).toEqual({ engine: { string: "4.4" }, plugin: "0.1.0", projectPath: "C:/game", connected: true });
    } finally { await close(); }
  });

  it.each(["godot_get_version", "godot_ping"])("returns actionable not_connected from %s", async (name) => {
    const error = new GodotMcpError("not_connected", "Godot editor is not connected.", "Open Godot and enable the plugin.");
    const { client, close } = await harness({ getStatus: () => disconnected, call: vi.fn().mockRejectedValue(error) });
    try {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: "not_connected", hint: expect.stringMatching(/open Godot.*enable the plugin/i) });
    } finally { await close(); }
  });

  it.each([
    ["godot_get_version", { engine: "not-an-object", plugin: "0.1.0", projectPath: "C:/game", connected: true }],
    ["godot_ping", { pong: false }],
  ])("converts invalid remote payload from %s to stable godot_error", async (name, payload) => {
    const { client, close } = await harness({ getStatus: () => disconnected, call: vi.fn().mockResolvedValue(payload) });
    try {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        code: "godot_error",
        message: "Godot returned an invalid response for the requested core command.",
        hint: "Check that the Godot plugin and MCP server versions are compatible.",
      });
    } finally { await close(); }
  });
});
