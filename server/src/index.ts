import { pathToFileURL } from "node:url";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLogger } from "./logger.js";
import { createServer } from "./server.js";
import { resolveConfig } from "./config.js";
import { JsonRpcClient } from "./bridge/ws-client.js";
import type { CoreBridge } from "./tools/core.js";
import type { LspToolClient } from "./tools/lsp.js";
import { LspHost, type LspOwnership } from "./lsp/host.js";
import { LspSession } from "./lsp/session.js";
import { LspClient } from "./lsp/client.js";
import { ProcessRunner } from "./runtime/process.js";
import { RuntimeSessionCoordinator } from "./runtime/session.js";
import { RuntimeBootstrap } from "./runtime/bootstrap.js";
import { RuntimeBridgeClient } from "./runtime/bridge-client.js";
import type { RuntimeToolService } from "./tools/runtime.js";
import type { DebugToolService } from "./tools/debug.js";
import { GodotMcpError } from "./errors.js";

interface BridgeLifecycle extends CoreBridge { start(): void; stop(): void }
interface ServerLifecycle { connect(transport: Transport): Promise<void>; close(): Promise<void> }
interface LspHostLifecycle { ensureAvailable(): Promise<LspOwnership>; close(): Promise<void> }
interface LspClientLifecycle extends LspToolClient { close(): Promise<void> }
interface RuntimeLifecycle extends RuntimeToolService, DebugToolService { close(): Promise<void> }
interface SignalSource {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}
interface InputSource {
  once(event: "end" | "close", listener: () => void): unknown;
  removeListener(event: "end" | "close", listener: () => void): unknown;
}
export interface RunServerDependencies {
  bridge?: BridgeLifecycle;
  server?: ServerLifecycle;
  transport?: Transport;
  signals?: SignalSource;
  input?: InputSource;
  lspHost?: LspHostLifecycle;
  lspClient?: LspClientLifecycle;
  runtime?: RuntimeLifecycle;
}

export async function runServer(dependencies: RunServerDependencies = {}): Promise<void> {
  const config = resolveConfig(process.env, process.cwd(), process.platform);
  const logger = createLogger(config.debug ? "debug" : "info");
  const bridge = dependencies.bridge ?? new JsonRpcClient({ url: `ws://${config.editorHost}:${config.editorPort}`, token: config.token, logger });
  const lspHost = dependencies.lspHost ?? new LspHost(config);
  const projectPath = config.projectPath ?? process.cwd();
  const lspClient = dependencies.lspClient ?? new LspClient(projectPath, new LspSession({
    host: "127.0.0.1", port: config.lspPort, projectRootUri: pathToFileURL(projectPath).href,
    beforeConnect: async () => { await lspHost.ensureAvailable(); },
  }));
  const runtime = dependencies.runtime ?? createRuntimeService(config, bridge);
  const server = dependencies.server ?? createServer({ bridge, mode: config.mode, lsp: lspClient, runtime, debug: runtime });
  const transport = dependencies.transport ?? new StdioServerTransport();
  const signals = dependencies.signals ?? process;
  const input = dependencies.input ?? process.stdin;
  let requestShutdown!: () => void;
  const shutdownRequested = new Promise<void>((resolve) => { requestShutdown = resolve; });
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    signals.removeListener("SIGINT", requestShutdown);
    signals.removeListener("SIGTERM", requestShutdown);
    input.removeListener("end", requestShutdown);
    input.removeListener("close", requestShutdown);
    let firstError: unknown;
    const attempt = async (work: () => void | Promise<void>) => { try { await work(); } catch (error) { firstError ??= error; } };
    await attempt(() => bridge.stop());
    await attempt(() => runtime.close());
    await attempt(() => lspClient.close());
    await attempt(() => lspHost.close());
    await attempt(() => server.close());
    if (firstError !== undefined) throw firstError;
  };
  signals.once("SIGINT", requestShutdown);
  signals.once("SIGTERM", requestShutdown);
  input.once("end", requestShutdown);
  input.once("close", requestShutdown);
  try {
    bridge.start();
    await server.connect(transport);
    await shutdownRequested;
  } finally {
    await cleanup();
  }
}

export function createRuntimeService(config: ReturnType<typeof resolveConfig>, editorBridge: CoreBridge): RuntimeLifecycle {
  const coordinator = new RuntimeSessionCoordinator({ runner: new ProcessRunner(), projectPath: config.projectPath } as any);
  const bootstrap = new RuntimeBootstrap(editorBridge as any);
  const configured = () => {
    if (!config.godotPath || !config.projectPath) throw new GodotMcpError("not_connected", "The runtime process service is not configured.", "Set GODOT_PATH and GODOT_PROJECT_PATH before launching a managed runtime.");
    return { godotPath: config.godotPath, projectPath: config.projectPath };
  };
  const launchIntegrated = (mode: "normal" | "debug", options: { scene?: string; args?: string[]; timeoutMs?: number; initialBreakpoints?: { path: string; lines: number[] }[] }) => {
    const paths = configured(); const scene = options.scene ?? "res://test_scene.tscn";
    return coordinator.integratedLaunch(mode, async (sessionId, token) => {
      const runtimePort = Number(process.env.GODOT_RUNTIME_PORT ?? config.editorPort + 1);
      const debugPort = Number(process.env.GODOT_REMOTE_DEBUG_PORT ?? 6007);
      const prepared = await bootstrap.prepare({ sessionId, token, protocolVersion: 1, preferredPort: runtimePort, scene });
      const client = new RuntimeBridgeClient();
      let artifactsClosed = false;
      const closeArtifacts = async () => { if (artifactsClosed) return; await bootstrap.cleanup(prepared); artifactsClosed = true; };
      return {
        process: { ...paths, args: [...(mode === "debug" ? ["--remote-debug", `tcp://127.0.0.1:${debugPort}`] : []), ...prepared.args, ...(options.args ?? [])] },
        close: closeArtifacts,
        connect: async () => {
          const transport = await client.connect(prepared);
          return { attachment: { request: client.request.bind(client), close: client.close.bind(client) }, root: prepared.sessionRoot, transport };
        },
      };
    }, mode === "debug" ? { host: "127.0.0.1", port: config.dapPort, timeoutMs: options.timeoutMs ?? 15_000, ...(options.initialBreakpoints ? { initialBreakpoints: options.initialBreakpoints } : {}) } : undefined);
  };
  return {
    launch: (mode, options) => mode === "normal" ? launchIntegrated("normal", options) : launchIntegrated("debug", options),
    stop: coordinator.stop.bind(coordinator), output: coordinator.output.bind(coordinator), sceneTree: coordinator.sceneTree.bind(coordinator), getNode: coordinator.getNode.bind(coordinator), input: coordinator.input.bind(coordinator), screenshot: coordinator.screenshot.bind(coordinator),
    debugLaunch: options => launchIntegrated("debug", options), debugSetBreakpoints: coordinator.debugSetBreakpoints.bind(coordinator), debugContinue: coordinator.debugContinue.bind(coordinator), debugStep: coordinator.debugStep.bind(coordinator), debugStack: coordinator.debugStack.bind(coordinator), debugInspect: coordinator.debugInspect.bind(coordinator), close: coordinator.close.bind(coordinator),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runServer().catch((error: unknown) => {
    createLogger("error").error("MCP server failed", { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
}
