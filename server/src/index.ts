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

interface BridgeLifecycle extends CoreBridge { start(): void; stop(): void }
interface ServerLifecycle { connect(transport: Transport): Promise<void>; close(): Promise<void> }
interface LspHostLifecycle { ensureAvailable(): Promise<LspOwnership>; close(): Promise<void> }
interface LspClientLifecycle extends LspToolClient { close(): Promise<void> }
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
  const server = dependencies.server ?? createServer({ bridge, mode: config.mode, lsp: lspClient });
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runServer().catch((error: unknown) => {
    createLogger("error").error("MCP server failed", { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
}
