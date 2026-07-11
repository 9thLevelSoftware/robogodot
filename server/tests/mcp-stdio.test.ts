import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it, vi } from "vitest";

const execute = promisify(execFile);
const artifact = path.resolve("dist/index.js");
let buildStartedAt = 0;

beforeAll(async () => {
  buildStartedAt = Date.now();
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("npm_execpath is required to build the stdio fixture");
  await execute(process.execPath, [npmCli, "run", "build"], { cwd: process.cwd() });
  expect((await stat(artifact)).mtimeMs).toBeGreaterThanOrEqual(buildStartedAt - 1000);
});

describe("freshly built stdio server", () => {
  it("emits only complete MCP JSON frames and lists exactly three probes while Godot is absent", async () => {
    const child = spawn(process.execPath, [artifact], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    const messages: Array<Record<string, any>> = [];
    let buffer = "";
    let parseFailure: Error | undefined;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const frame = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (frame.length === 0) continue;
        try { messages.push(JSON.parse(frame)); }
        catch (error) { parseFailure = error instanceof Error ? error : new Error(String(error)); }
      }
    });
    const waitForId = async (id: number): Promise<void> => {
      await vi.waitFor(() => {
        if (parseFailure) throw parseFailure;
        expect(messages.some((message) => message.id === id)).toBe(true);
      }, { timeout: 3000 });
    };
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "stdio-test", version: "1" } } }) + "\n");
    await waitForId(1);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    await waitForId(2);
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    expect(parseFailure).toBeUndefined();
    expect(buffer).toBe("");
    expect(messages.find((message) => message.id === 2)?.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "godot_connection_status", "godot_get_version", "godot_ping",
    ]);
  });
});
