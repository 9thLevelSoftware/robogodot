import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLogger } from "./logger.js";
import { createServer } from "./server.js";
import { resolveConfig } from "./config.js";
import { JsonRpcClient } from "./bridge/ws-client.js";

export async function runServer(): Promise<void> {
  const config = resolveConfig(process.env, process.cwd(), process.platform);
  const logger = createLogger(config.debug ? "debug" : "info");
  const bridge = new JsonRpcClient({ url: `ws://${config.editorHost}:${config.editorPort}`, logger });
  const server = createServer({ bridge });
  const shutdown = (): void => {
    bridge.stop();
    void server.close().catch((error: unknown) => {
      createLogger("error").error("Failed to close MCP server", { error: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  bridge.start();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runServer().catch((error: unknown) => {
    createLogger("error").error("MCP server failed", { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
}
