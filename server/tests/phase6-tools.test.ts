import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { FsGuard } from "../src/fs/guard.js";
import { HeadlessRunner } from "../src/batch/headless.js";
import { ProjectExporter } from "../src/batch/export.js";
import { DisabledAssetProvider } from "../src/assets/provider.js";

process.env.GODOT_MCP_TOKEN ??= "0123456789abcdef0123456789abcdef";

async function harness(root: string) {
  const guard = await FsGuard.create(root);
  const server = createServer({
    fs: { guard },
    batch: { godotPath: "godot", projectPath: root, headless: new HeadlessRunner(), exporter: new ProjectExporter(), guard },
    uid: { guard },
    assets: { guard, provider: new DisabledAssetProvider(), enabled: false },
  });
  const client = new Client({ name: "phase6", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return {
    client,
    close: async () => { await client.close(); await server.close(); },
  };
}

describe("Phase 6 tools", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it("reads and writes project files through the public MCP surface", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "phase6-tools-"));
    roots.push(root);
    await writeFile(path.join(root, "project.godot"), "");
    await mkdir(path.join(root, "docs"));
    const h = await harness(root);
    try {
      const written = await h.client.callTool({ name: "godot_fs_write", arguments: { path: "res://docs/note.txt", content: "phase6-ok" } });
      expect(written.isError).toBeFalsy();
      expect(written.structuredContent).toMatchObject({ path: "res://docs/note.txt", created: true });
      const read = await h.client.callTool({ name: "godot_fs_read", arguments: { path: "res://docs/note.txt" } });
      expect(read.structuredContent).toMatchObject({ content: "phase6-ok" });
      const listed = await h.client.callTool({ name: "godot_fs_list", arguments: { path: "res://docs" } });
      expect((listed.structuredContent as { entries: Array<{ name: string }> }).entries.some((entry) => entry.name === "note.txt")).toBe(true);
      const asset = await h.client.callTool({ name: "godot_asset_generate", arguments: { prompt: "tree", path: "res://icon.png" } });
      expect(asset.isError).toBe(true);
      expect(JSON.parse((asset.content as { text: string }[])[0]!.text)).toMatchObject({ code: "feature_disabled" });
    } finally {
      await h.close();
    }
  });
});
