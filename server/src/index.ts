import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLogger } from "./logger.js";
import { createServer } from "./server.js";

export async function runServer(): Promise<void> {
  const server = createServer({});
  const shutdown = (): void => {
    void server.close().catch((error: unknown) => {
      createLogger("error").error("Failed to close MCP server", { error: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runServer().catch((error: unknown) => {
    createLogger("error").error("MCP server failed", { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
}
