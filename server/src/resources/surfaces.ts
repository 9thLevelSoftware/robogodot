import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CoreBridge } from "../tools/core.js";
import type { HealthService } from "../obs/health.js";
import type { SafetyMode } from "../config.js";

export interface ResourceSurfaces {
  health: HealthService;
  bridge: CoreBridge;
  mode: SafetyMode;
  godotMinor: string;
  nodeEngine: string;
  reconnectAcceptanceMs: number;
  toolCount: number;
}

export function registerResourceSurfaces(server: McpServer, surfaces: ResourceSurfaces): void {
  const text = (uri: URL, data: unknown) => ({
    contents: [{
      uri: uri.href,
      mimeType: "application/json" as const,
      text: JSON.stringify(data, null, 2),
    }],
  });

  server.registerResource("health", "godot://health", {
    description: "Aggregated channel readiness, mode, audit size, and cache generation.",
    mimeType: "application/json",
  }, async (uri) => text(uri, surfaces.health.snapshot()));

  server.registerResource("connection", "godot://connection", {
    description: "Local editor WebSocket bridge status.",
    mimeType: "application/json",
  }, async (uri) => text(uri, surfaces.bridge.getStatus()));

  server.registerResource("mode", "godot://mode", {
    description: "Configured GODOT_MCP_MODE safety mode.",
    mimeType: "application/json",
  }, async (uri) => text(uri, { mode: surfaces.mode }));

  server.registerResource("support-matrix", "godot://support-matrix", {
    description: "Supported Node and Godot product matrix and reconnect acceptance window.",
    mimeType: "application/json",
  }, async (uri) => text(uri, {
    node: surfaces.nodeEngine,
    godotMinors: [surfaces.godotMinor],
    reconnectAcceptanceMs: surfaces.reconnectAcceptanceMs,
    publicToolCount: surfaces.toolCount,
    prompts: ["add-feature-to-scene"],
  }));
}
