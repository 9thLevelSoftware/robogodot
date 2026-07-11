import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClientStatus } from "./bridge/ws-client.js";
import { registerCoreTools, type CoreBridge } from "./tools/core.js";

export interface ServerDependencies { bridge?: CoreBridge }

const disconnectedBridge: CoreBridge = {
  getStatus: (): ClientStatus => ({ state: "disconnected", url: "ws://127.0.0.1:9200", connectedSince: undefined, reconnectAttempt: 0, lastError: undefined }),
  call: () => Promise.reject(new Error("Bridge is not configured.")),
};

export function createServer(dependencies: ServerDependencies): McpServer {
  const server = new McpServer({ name: "godot-control-mcp", version: "0.1.0" });
  registerCoreTools(server, dependencies.bridge ?? disconnectedBridge);
  return server;
}
