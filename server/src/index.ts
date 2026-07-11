import { pathToFileURL } from "node:url";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLogger } from "./logger.js";
import { createServer } from "./server.js";
import { resolveConfig } from "./config.js";
import { JsonRpcClient } from "./bridge/ws-client.js";
import type { CoreBridge } from "./tools/core.js";

interface BridgeLifecycle extends CoreBridge { start(): void; stop(): void }
interface ServerLifecycle { connect(transport: Transport): Promise<void>; close(): Promise<void> }
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
}

export async function runServer(dependencies: RunServerDependencies = {}): Promise<void> {
  const config = resolveConfig(process.env, process.cwd(), process.platform);
  const logger = createLogger(config.debug ? "debug" : "info");
  const bridge = dependencies.bridge ?? new JsonRpcClient({ url: `ws://${config.editorHost}:${config.editorPort}`, token: config.token, logger });
  const server = dependencies.server ?? createServer({ bridge, mode: config.mode });
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
    bridge.stop();
    await server.close();
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
