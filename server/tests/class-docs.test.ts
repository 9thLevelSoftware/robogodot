import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { buildDocsIndex, classDoc, loadBundledDocsIndex, verifyDocsManifest, type VersionClient } from "../src/docs/class-docs.js";

const fixture = resolve(import.meta.dirname, "fixtures/docs/Node.xml");
const provenance = {
  engineVersion: "4.6.2",
  sourceCommit: "001aa128b1cd80dc4e47e823c360bccf45ed6bad",
  sourceArchiveSha256: "908b759e7517fec65d687b3d468cd639fd8967d25da1522ef8a2087af638b3fe",
  generatorVersion: 1,
  generatorSha256: "fixture-generator-sha256",
};

describe("pinned official class docs", () => {
  test("generates a deterministic normalized index and manifest", async () => {
    const xml = await readFile(fixture, "utf8");
    const first = buildDocsIndex([{ path: "doc/classes/Node.xml", xml }], provenance);
    const second = buildDocsIndex([{ path: "doc/classes/Node.xml", xml }], provenance);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.manifest).toMatchObject({ ...provenance, classCount: 1, memberCount: 5 });
    expect(first.classes.Node.description).toContain("Base fixture");
    expect(first.classes.Node.members["method:add_child"]).toBe("Adds a child fixture.");
    expect(verifyDocsManifest(first)).toBe(true);
  });

  test("check mode detects a changed generated artifact", async () => {
    const xml = await readFile(fixture, "utf8");
    const index = buildDocsIndex([{ path: "doc/classes/Node.xml", xml }], provenance);
    const directory = await mkdtemp(join(tmpdir(), "godot-doc-index-"));
    const output = join(directory, "index.json");
    await writeFile(output, JSON.stringify(index));
    expect(verifyDocsManifest(JSON.parse(await readFile(output, "utf8")))).toBe(true);
    index.classes.Node.description += "changed";
    expect(verifyDocsManifest(index)).toBe(false);
  });

  test("returns bounded class and member docs only for a matching live 4.6 engine", async () => {
    const xml = await readFile(fixture, "utf8");
    const index = buildDocsIndex([{ path: "doc/classes/Node.xml", xml }], provenance);
    const matching: VersionClient = { call: async () => ({ engine: { major: 4, minor: 6, patch: 2, status: "stable", build: "official", hash: "71f334935" } }) };
    await expect(classDoc(matching, index, { class: "Node" })).resolves.toMatchObject({ class: "Node", description: expect.stringContaining("Base fixture") });
    await expect(classDoc(matching, index, { class: "Node", member: { kind: "method", name: "add_child" } })).resolves.toMatchObject({ member: { kind: "method", name: "add_child", description: "Adds a child fixture." } });
    const mismatched: VersionClient = { call: async () => ({ engine: { major: 4, minor: 7, patch: 0 } }) };
    await expect(classDoc(mismatched, index, { class: "Node" })).rejects.toMatchObject({ code: "feature_disabled" });
    await expect(classDoc(matching, index, { class: "Missing" })).rejects.toMatchObject({ code: "invalid_args" });
    await expect(classDoc(matching, index, { class: "Node", member: { kind: "method", name: "missing" } })).rejects.toMatchObject({ code: "invalid_args" });
  });

  test("bundles nonempty official Node class and member documentation", async () => {
    const index = await loadBundledDocsIndex();
    const matching: VersionClient = { call: async () => ({ engine: { major: 4, minor: 6, patch: 2 } }) };
    const node = await classDoc(matching, index, { class: "Node" });
    const addChild = await classDoc(matching, index, { class: "Node", member: { kind: "method", name: "add_child" } });
    expect(node.description.length).toBeGreaterThan(100);
    expect(addChild.member?.description.length).toBeGreaterThan(20);
    expect(Buffer.byteLength(JSON.stringify(addChild))).toBeLessThanOrEqual(262_144);
  });
});
