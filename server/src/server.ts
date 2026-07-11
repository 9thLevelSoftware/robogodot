import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface ServerDependencies {}

export function createServer(_dependencies: ServerDependencies): McpServer {
  return new McpServer({ name: "godot-control-mcp", version: "0.1.0" });
}
