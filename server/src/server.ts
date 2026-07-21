import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClientStatus } from "./bridge/ws-client.js";
import { registerCoreTools, type CoreBridge } from "./tools/core.js";
import type { SafetyMode } from "./config.js";
import { registerScriptTool } from "./tools/script.js";
import { registerIntrospectionTools } from "./tools/introspection.js";
import type { DocsIndex } from "./docs/class-docs.js";
import { registerNodeTools } from "./tools/node.js";
import { registerSceneTools } from "./tools/scene.js";
import { registerSignalTools } from "./tools/signal.js";
import { registerResourceTools } from "./tools/resource.js";
import { registerProjectTools } from "./tools/project.js";
import { registerLspTools, type LspToolClient } from "./tools/lsp.js";
import { GodotMcpError } from "./errors.js";
import { disconnectedRuntime, registerRuntimeTools, type RuntimeToolService } from "./tools/runtime.js";
import { disconnectedDebug, registerDebugTools, type DebugToolService } from "./tools/debug.js";
import { registerFsTools, type FsToolService } from "./tools/fs.js";
import { registerBatchTools, type BatchToolService } from "./tools/batch.js";
import { registerUidTools, type UidToolService } from "./tools/uid.js";
import { registerAssetTools, type AssetToolService } from "./tools/assets.js";
import { DisabledAssetProvider } from "./assets/provider.js";
import { HeadlessRunner } from "./batch/headless.js";
import { ProjectExporter } from "./batch/export.js";
import type { FsGuard } from "./fs/guard.js";
import { createPolicyBundle, type PolicyBundle } from "./policy.js";
import { bindPolicy } from "./registry.js";
import type { ChannelState } from "./obs/health.js";

export interface ServerDependencies {
  bridge?: CoreBridge;
  mode?: SafetyMode;
  docsLoader?: () => Promise<DocsIndex>;
  lsp?: LspToolClient;
  runtime?: RuntimeToolService;
  debug?: DebugToolService;
  fs?: FsToolService;
  batch?: BatchToolService;
  uid?: UidToolService;
  assets?: AssetToolService;
  policy?: PolicyBundle;
  healthProbes?: Partial<{
    editorBridge: () => ChannelState;
    lsp: () => ChannelState;
    runtime: () => ChannelState;
    filesystem: () => ChannelState;
  }>;
}

const unconfiguredGuard = new Proxy({} as FsGuard, {
  get() {
    throw new GodotMcpError(
      "editor_required",
      "Filesystem tools require GODOT_PROJECT_PATH.",
      "Set GODOT_PROJECT_PATH to a Godot project directory containing project.godot.",
    );
  },
});

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
  const mode = dependencies.mode ?? "full";
  const policy = dependencies.policy ?? createPolicyBundle(mode, dependencies.healthProbes);
  bindPolicy(server, policy);
  const bridge = dependencies.bridge ?? disconnectedBridge;
  registerCoreTools(server, bridge);
  registerScriptTool(server, bridge, mode);
  registerIntrospectionTools(server, bridge, dependencies.docsLoader);
  registerNodeTools(server, bridge);
  registerSceneTools(server, bridge);
  registerSignalTools(server, bridge);
  registerResourceTools(server, bridge);
  registerProjectTools(server, bridge);
  registerLspTools(server, dependencies.lsp ?? disconnectedLsp);
  registerRuntimeTools(server, dependencies.runtime ?? disconnectedRuntime);
  registerDebugTools(server, dependencies.debug ?? disconnectedDebug);
  const fsService = dependencies.fs ?? { guard: unconfiguredGuard };
  registerFsTools(server, fsService);
  registerBatchTools(server, dependencies.batch ?? {
    headless: new HeadlessRunner(),
    exporter: new ProjectExporter(),
    guard: unconfiguredGuard,
  });
  registerUidTools(server, dependencies.uid ?? { guard: unconfiguredGuard });
  registerAssetTools(server, dependencies.assets ?? {
    guard: unconfiguredGuard,
    provider: new DisabledAssetProvider(),
    enabled: false,
  });
  return server;
}

export type { PolicyBundle };
