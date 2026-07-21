import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import { createServer } from "../src/server.js";
import { createPhase6Services } from "../src/index.js";
import { resolveConfig } from "../src/config.js";

const godotPath = process.env.GODOT_PATH;
const liveDescribe = godotPath ? describe : describe.skip;
const projectPath = resolve(process.env.GODOT_PROJECT_PATH ?? "../tests/fixtures/godot_project");

liveDescribe("Phase 6 live headless and filesystem acceptance (set GODOT_PATH to enable)", () => {
  test("writes a project file and runs a headless script that prints a known token", async () => {
    process.env.GODOT_MCP_TOKEN ??= "0123456789abcdef0123456789abcdef";
    const config = resolveConfig({
      ...process.env,
      GODOT_PATH: godotPath!,
      GODOT_PROJECT_PATH: projectPath,
      GODOT_MCP_TOKEN: process.env.GODOT_MCP_TOKEN!,
    }, projectPath, process.platform);
    const phase6 = await createPhase6Services(config);
    const server = createServer({ fs: phase6.fs, batch: phase6.batch, uid: phase6.uid, assets: phase6.assets });
    const client = new Client({ name: "phase6-live", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    try {
      const write = await client.callTool({
        name: "godot_fs_write",
        arguments: { path: "res://phase6_live_note.txt", content: "phase6-live", overwrite: true },
      });
      expect(write.isError).toBeFalsy();
      const read = await client.callTool({ name: "godot_fs_read", arguments: { path: "res://phase6_live_note.txt" } });
      expect(read.structuredContent).toMatchObject({ content: "phase6-live" });
      const headless = await client.callTool({
        name: "godot_headless_run",
        arguments: {
          source: "extends SceneTree\nfunc _init():\n\tprint(\"phase6-headless-token\")\n\tquit()\n",
          timeoutMs: 30_000,
        },
      });
      expect(headless.isError).toBeFalsy();
      expect(String((headless.structuredContent as { stdout?: string }).stdout ?? "")).toContain("phase6-headless-token");
    } finally {
      await client.close();
      await server.close();
    }
  }, 60_000);
});
