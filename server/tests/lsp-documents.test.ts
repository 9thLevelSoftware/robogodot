import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
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
  it.each(["textDocument/didOpen", "textDocument/didChange", "textDocument/didSave"])("retries a first sync when generation drops at %s", async (dropMethod) => {
    const { root } = await setup();
    const file = join(root, "phase4", "generation.gd"); await writeFile(file, "extends Node\n", "utf8");
    let generation = 1; let dropped = false;
    const notifications: Array<{ generation: number; method: string }> = [];
    const session = {
      ensureReady: async () => ({ generation }),
      notify: async () => { throw new Error("unbound notification used"); },
      notifyForGeneration: async (expected: number, method: string) => {
        if (!dropped && method === dropMethod) { dropped = true; generation = 2; throw new Error("generation dropped"); }
        if (expected !== generation) throw new Error("stale generation");
        notifications.push({ generation: expected, method });
      },
    };
    const synced = await new LspDocuments(root, session).sync("res://phase4/generation.gd");
    expect(synced).toMatchObject({ version: 2, generation: 2 });
    expect(notifications.slice(-3)).toEqual([
      { generation: 2, method: "textDocument/didOpen" },
      { generation: 2, method: "textDocument/didChange" },
      { generation: 2, method: "textDocument/didSave" },
    ]);
  });

  it("bounds perpetual generation flapping with a structured failure", async () => {
    const { root } = await setup();
    await writeFile(join(root, "phase4", "flapping.gd"), "extends Node\n", "utf8");
    let generation = 0; let attempts = 0;
    const session = {
      ensureReady: async () => ({ generation: ++generation }),
      notify: async () => { throw new Error("unbound notification used"); },
      notifyForGeneration: async () => { attempts++; throw new Error("generation dropped"); },
    };
    await expect(new LspDocuments(root, session).sync("res://phase4/flapping.gd")).rejects.toMatchObject({ code: "not_connected" });
    expect(attempts).toBe(4);
  });
  it("synchronizes exact bytes and only changes when disk bytes change", async () => {
    const { root, session, notifications } = await setup();
    const file = join(root, "phase4", "player.gd"); await writeFile(file, "extends Node\r\n", "utf8");
    const docs = new LspDocuments(root, session);
    const opened = await docs.sync("res://phase4/player.gd");
    expect(opened).toMatchObject({ uri: "res://phase4/player.gd", text: "extends Node\r\n", version: 2, generation: 3 });
    expect(notifications[0]).toMatchObject({ method: "textDocument/didOpen", params: { textDocument: { languageId: "gdscript", version: 1, text: "extends Node\r\n" } } });
    expect(notifications[1]).toMatchObject({ method: "textDocument/didChange", params: { textDocument: { version: 2 }, contentChanges: [{ text: "extends Node\r\n" }] } });
    expect(notifications[2]).toMatchObject({ method: "textDocument/didSave", params: { textDocument: { uri: expect.stringContaining("player.gd") }, text: "extends Node\r\n" } });
    await docs.sync("res://phase4/player.gd"); expect(notifications).toHaveLength(3);
    await writeFile(file, "extends Node\r\nvar café = 1\r\n", "utf8");
    const changed = await docs.sync("res://phase4/player.gd");
    expect(changed.version).toBe(3);
    expect(notifications.at(-2)).toMatchObject({ method: "textDocument/didChange", params: { contentChanges: [{ text: "extends Node\r\nvar café = 1\r\n" }] } });
    expect(notifications.at(-1)).toMatchObject({ method: "textDocument/didSave", params: { text: "extends Node\r\nvar café = 1\r\n" } });
  });

  it("reuses one synchronized document for equivalent res URI spellings", async () => {
    const { root, session, notifications } = await setup();
    await writeFile(join(root, "phase4", "player.gd"), "extends Node\n", "utf8");
    const docs = new LspDocuments(root, session);
    const encoded = await docs.sync("res://phase4/player%2Egd");
    const plain = await docs.sync("res://phase4/player.gd");
    expect(plain.uri).toBe(encoded.uri);
    expect(notifications.filter(({ method }) => method === "textDocument/didOpen")).toHaveLength(1);
    expect(notifications).toHaveLength(3);
  });

  it("replays current documents in sorted URI order", async () => {
    const { root, session, notifications } = await setup();
    await writeFile(join(root, "phase4", "z.gd"), "z", "utf8"); await writeFile(join(root, "phase4", "a.gd"), "a", "utf8");
    const docs = new LspDocuments(root, session); await docs.sync("res://phase4/z.gd"); await docs.sync("res://phase4/a.gd"); notifications.length = 0;
    await docs.replay(9);
    expect(notifications.map((n) => n.params.textDocument.text)).toEqual(["a", "z"]);
  });

  it("maps Godot's percent-encoded lowercase Windows drive URI to an authorized document", async () => {
    const { root, session } = await setup();
    await writeFile(join(root, "phase4", "player.gd"), "extends Node\n", "utf8");
    const docs = new LspDocuments(root, session); const document = await docs.sync("res://phase4/player.gd");
    const encodedDrive = process.platform === "win32"
      ? document.fileUri.replace(/file:\/\/\/([A-Za-z]):/, (_match, drive: string) => `file:///${drive.toLowerCase()}%3A`)
      : document.fileUri;
    expect(docs.publicUriForFileUri(encodedDrive)).toBe("res://phase4/player.gd");
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

  it("only synchronizes case-appropriate GDScript files", async () => {
    const { root, session } = await setup(); const docs = new LspDocuments(root, session);
    await writeFile(join(root, "phase4", "notes.txt"), "extends Node");
    await writeFile(join(root, "phase4", "upper.GD"), "extends Node");
    await expect(docs.sync("res://phase4/notes.txt")).rejects.toMatchObject({ code: "invalid_args" });
    await expect(docs.sync("res://phase4/upper.GD")).rejects.toMatchObject({ code: "invalid_args" });
  });

  it("denies a target whose canonical path changes after its handle is opened", async () => {
    const { root, session } = await setup(); const file = join(root, "phase4", "race.gd"); await writeFile(file, "extends Node");
    const outside = await mkdtemp(join(tmpdir(), "robogodot-race-")); roots.push(outside); const escaped = join(outside, "race.gd"); await writeFile(escaped, "escape");
    let targetCalls = 0;
    const docs = new LspDocuments(root, session, { realpath: async (value) => {
      // Compare the stable document identity rather than the pre-canonical path string.
      // Windows realpath may normalize drive-letter casing before the second call.
      if (basename(value) === "race.gd" && ++targetCalls === 2) return escaped;
      return (await import("node:fs/promises")).realpath(value);
    } });
    await expect(docs.sync("res://phase4/race.gd")).rejects.toMatchObject({ code: "invalid_args" });
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
