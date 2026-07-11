import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("built stdio server", () => {
  it("emits only MCP JSON and lists exactly three probes while Godot is absent", async () => {
    const child = spawn(process.execPath, ["dist/index.js"], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    const lines: string[] = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => lines.push(...chunk.split("\n").filter(Boolean)));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "stdio-test", version: "1" } } }) + "\n");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("initialize timeout")), 3000);
      const poll = setInterval(() => { if (lines.some((line) => JSON.parse(line).id === 1)) { clearInterval(poll); clearTimeout(timer); resolve(); } }, 10);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("list timeout")), 3000);
      const poll = setInterval(() => { if (lines.some((line) => JSON.parse(line).id === 2)) { clearInterval(poll); clearTimeout(timer); resolve(); } }, 10);
    });
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    const messages = lines.map((line) => JSON.parse(line));
    expect(messages.find((message) => message.id === 2).result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "godot_connection_status", "godot_get_version", "godot_ping",
    ]);
    expect(lines).toHaveLength(messages.length);
  });
});
