import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ClientStatus } from "../bridge/ws-client.js";
import { registerTool } from "../registry.js";

export interface CoreBridge {
  getStatus(): ClientStatus;
  call<T>(method: string, params?: unknown): Promise<T>;
}

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const emptyInput = z.object({}).strict();
const statusOutput = z.object({
  state: z.enum(["disconnected", "connecting", "connected", "reconnecting"]),
  url: z.string(),
  connectedSince: z.string().optional(),
  reconnectAttempt: z.number().int().nonnegative(),
  lastError: z.string().optional(),
});
const versionOutput = z.object({
  engine: z.record(z.string(), z.unknown()),
  plugin: z.string(),
  projectPath: z.string(),
  connected: z.literal(true),
});
const pingOutput = z.object({ connected: z.literal(true), pong: z.literal(true), latencyMs: z.number().nonnegative() });

export function registerCoreTools(server: McpServer, bridge: CoreBridge): void {
  registerTool(server, {
    name: "godot_connection_status",
    description: "Return the current Godot editor bridge connection status.",
    inputSchema: emptyInput,
    outputSchema: statusOutput,
    annotations,
    handler: async () => ({ ...bridge.getStatus() }),
  });
  registerTool(server, {
    name: "godot_get_version",
    description: "Return Godot engine, plugin, and project version information.",
    inputSchema: emptyInput,
    outputSchema: versionOutput,
    annotations,
    handler: async () => bridge.call<Record<string, unknown>>("core.get_version"),
  });
  registerTool(server, {
    name: "godot_ping",
    description: "Ping the Godot editor bridge and report round-trip latency.",
    inputSchema: emptyInput,
    outputSchema: pingOutput,
    annotations,
    handler: async () => {
      const started = performance.now();
      const result = await bridge.call<{ pong: boolean }>("core.ping");
      return { connected: true as const, pong: result.pong as true, latencyMs: performance.now() - started };
    },
  });
}
