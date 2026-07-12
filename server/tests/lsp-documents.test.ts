import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LspDocuments } from "../src/lsp/documents.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "robogodot-docs-")); roots.push(root);
  await mkdir(join(root, "phase4"));
  const notifications: Array<{ method: string; params: any }> = [];
  let generation = 3;
  const session = {
    ready: { generation },
    ensureReady: async () => ({ generation, capabilities: {} }),
    notify: async (method: string, params: unknown) => { notifications.push({ method, params }); },
  };
  return { root, notifications, session, setGeneration(value: number) { generation = value; session.ready.generation = value; } };
}

describe("LspDocuments", () => {
  it("synchronizes exact bytes and only changes when disk bytes change", async () => {
    const { root, session, notifications } = await setup();
    const file = join(root, "phase4", "player.gd"); await writeFile(file, "extends Node\r\n", "utf8");
    const docs = new LspDocuments(root, session);
    const opened = await docs.sync("res://phase4/player.gd");
    expect(opened).toMatchObject({ uri: "res://phase4/player.gd", text: "extends Node\r\n", version: 1, generation: 3 });
    expect(notifications.at(-1)).toMatchObject({ method: "textDocument/didOpen", params: { textDocument: { languageId: "gdscript", version: 1, text: "extends Node\r\n" } } });
    await docs.sync("res://phase4/player.gd"); expect(notifications).toHaveLength(1);
    await writeFile(file, "extends Node\r\nvar café = 1\r\n", "utf8");
    const changed = await docs.sync("res://phase4/player.gd");
    expect(changed.version).toBe(2);
    expect(notifications.at(-1)).toMatchObject({ method: "textDocument/didChange", params: { contentChanges: [{ text: "extends Node\r\nvar café = 1\r\n" }] } });
  });

  it("replays current documents in sorted URI order", async () => {
    const { root, session, notifications } = await setup();
    await writeFile(join(root, "phase4", "z.gd"), "z", "utf8"); await writeFile(join(root, "phase4", "a.gd"), "a", "utf8");
    const docs = new LspDocuments(root, session); await docs.sync("res://phase4/z.gd"); await docs.sync("res://phase4/a.gd"); notifications.length = 0;
    await docs.replay(9);
    expect(notifications.map((n) => n.params.textDocument.text)).toEqual(["a", "z"]);
  });

  it("rejects invalid UTF-8, invalid URI forms, missing files, oversized input, and escapes", async () => {
    const { root, session } = await setup(); const docs = new LspDocuments(root, session);
    await writeFile(join(root, "phase4", "bad.gd"), Buffer.from([0xc3, 0x28]));
    const invalid = ["", "file:///tmp/x", "http://x", "/absolute", "res://../x", "res://%2e%2e/x", "res://phase4/missing.gd", `res://${"a".repeat(1025)}`];
    for (const uri of invalid) await expect(docs.sync(uri)).rejects.toMatchObject({ code: "invalid_args" });
    await expect(docs.sync("res://phase4/bad.gd")).rejects.toMatchObject({ code: "invalid_args" });
    await writeFile(join(root, "phase4", "huge.gd"), Buffer.alloc(2 * 1024 * 1024 + 1));
    await expect(docs.sync("res://phase4/huge.gd")).rejects.toMatchObject({ code: "invalid_args" });
    const outside = await mkdtemp(join(tmpdir(), "robogodot-outside-")); roots.push(outside); await writeFile(join(outside, "secret.gd"), "secret");
    await symlink(outside, join(root, "phase4", "escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(docs.sync("res://phase4/escape/secret.gd")).rejects.toMatchObject({ code: "invalid_args" });
  });

  it("validates UTF-16 positions and excludes line terminators", async () => {
    const { root, session } = await setup(); await writeFile(join(root, "phase4", "unicode.gd"), "a😀b\r\nnext", "utf8");
    const docs = new LspDocuments(root, session); const document = await docs.sync("res://phase4/unicode.gd");
    expect(() => docs.assertPosition(document, { line: 0, character: 4 })).not.toThrow();
    expect(() => docs.assertPosition(document, { line: 0, character: 5 })).toThrow();
    expect(() => docs.assertPosition(document, { line: 1, character: 4 })).not.toThrow();
    expect(() => docs.assertPosition(document, { line: 2, character: 0 })).toThrow();
  });
});
