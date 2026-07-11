import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClientStatus } from "./bridge/ws-client.js";
import { registerCoreTools, type CoreBridge } from "./tools/core.js";
import type { SafetyMode } from "./config.js";
import { registerScriptTool } from "./tools/script.js";
import { registerIntrospectionTools } from "./tools/introspection.js";

export interface ServerDependencies { bridge?: CoreBridge; mode?: SafetyMode }

const disconnectedBridge: CoreBridge = {
  getStatus: (): ClientStatus => ({ state: "disconnected", url: "ws://127.0.0.1:9200", connectedSince: undefined, reconnectAttempt: 0, lastError: undefined }),
  call: () => Promise.reject(new Error("Bridge is not configured.")),
};

export function createServer(dependencies: ServerDependencies): McpServer {
  const server = new McpServer({ name: "godot-control-mcp", version: "0.1.0" });
  const bridge = dependencies.bridge ?? disconnectedBridge;
  registerCoreTools(server, bridge);
  registerScriptTool(server, bridge, dependencies.mode ?? "full");
  registerIntrospectionTools(server, bridge);
  return server;
}
