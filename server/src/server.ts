import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClientStatus } from "./bridge/ws-client.js";
import { registerCoreTools, type CoreBridge } from "./tools/core.js";
import type { SafetyMode } from "./config.js";
import { registerScriptTool } from "./tools/script.js";
import { registerIntrospectionTools } from "./tools/introspection.js";
import type { DocsIndex } from "./docs/class-docs.js";
import { MutationLane } from "./mutation/lane.js";
import { registerNodeTools } from "./tools/node.js";
import { registerSceneTools } from "./tools/scene.js";
import { registerSignalTools } from "./tools/signal.js";
import { registerResourceTools } from "./tools/resource.js";
import { registerProjectTools } from "./tools/project.js";
import { registerLspTools, type LspToolClient } from "./tools/lsp.js";
import { GodotMcpError } from "./errors.js";
import { disconnectedRuntime, registerRuntimeTools, type RuntimeToolService } from "./tools/runtime.js";

export interface ServerDependencies { bridge?: CoreBridge; mode?: SafetyMode; docsLoader?: () => Promise<DocsIndex>; lsp?: LspToolClient; runtime?: RuntimeToolService }

const disconnectedBridge: CoreBridge = {
  getStatus: (): ClientStatus => ({ state: "disconnected", url: "ws://127.0.0.1:9200", connectedSince: undefined, reconnectAttempt: 0, lastError: undefined }),
  call: () => Promise.reject(new Error("Bridge is not configured.")),
};
const lspUnavailable = () => Promise.reject(new GodotMcpError("not_connected", "The Godot language server is not configured.", "Start Godot with --editor --headless --lsp-port 6005 --path <project>, or configure the RoboGodot LSP client."));
const disconnectedLsp: LspToolClient = {
  diagnostics: { sequence: 0, waitFor: lspUnavailable }, sync: lspUnavailable,
  assertPosition: () => { throw new GodotMcpError("not_connected", "The Godot language server is not configured.", "Start Godot with --editor --headless --lsp-port 6005 --path <project>, or configure the RoboGodot LSP client."); },
  supports: () => { throw new GodotMcpError("not_connected", "The Godot language server is not configured.", "Start Godot with --editor --headless --lsp-port 6005 --path <project>, or configure the RoboGodot LSP client."); }, request: lspUnavailable,
  ensureReady: lspUnavailable,
};

export function createServer(dependencies: ServerDependencies): McpServer {
  const server = new McpServer({ name: "godot-control-mcp", version: "0.1.0" });
  const bridge = dependencies.bridge ?? disconnectedBridge;
  registerCoreTools(server, bridge);
  registerScriptTool(server, bridge, dependencies.mode ?? "full");
  registerIntrospectionTools(server, bridge, dependencies.docsLoader);
  const mutationLane = new MutationLane();
  registerNodeTools(server, bridge, mutationLane);
  registerSceneTools(server, bridge);
  registerSignalTools(server, bridge, mutationLane);
  registerResourceTools(server, bridge);
  registerProjectTools(server, bridge, mutationLane);
  registerLspTools(server, dependencies.lsp ?? disconnectedLsp);
  registerRuntimeTools(server, dependencies.runtime ?? disconnectedRuntime);
  return server;
}
