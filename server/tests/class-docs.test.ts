import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { buildDocsIndex, classDoc, loadBundledDocsIndex, verifyDocsManifest, type VersionClient } from "../src/docs/class-docs.js";

const fixture = resolve(import.meta.dirname, "fixtures/docs/Node.xml");
const provenance = {
  engineVersion: "4.6.2",
  sourceCommit: "001aa128b1cd80dc4e47e823c360bccf45ed6bad",
  sourceArchiveSha256: "146a0af84fa4b11670ee5574d98d0a508f047db626407909121b38984531f3d1",
  generatorVersion: 1,
  generatorSha256: "fixture-generator-sha256",
};

describe("pinned official class docs", () => {
  test("generates a deterministic normalized index and manifest", async () => {
    const xml = await readFile(fixture, "utf8");
    const first = buildDocsIndex([{ path: "doc/classes/Node.xml", xml }], provenance);
    const second = buildDocsIndex([{ path: "doc/classes/Node.xml", xml }], provenance);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.manifest).toMatchObject({ ...provenance, classCount: 1 });
    expect(first.classes.Node.description).toContain("Base fixture");
    expect(first.classes.Node.members["method:add_child"]?.overloads.map((value) => value.description)).toEqual(["Adds by fixture name.", "Adds a child fixture."]);
    expect(first.classes.Node.members["enum:ProcessMode"]?.values).toEqual(["PROCESS_MODE_DISABLED", "PROCESS_MODE_INHERIT"]);
    expect(verifyDocsManifest(first, first.manifest)).toBe(true);
  });

  test("check mode detects a changed generated artifact", async () => {
    const xml = await readFile(fixture, "utf8");
    const index = buildDocsIndex([{ path: "doc/classes/Node.xml", xml }], provenance);
    const directory = await mkdtemp(join(tmpdir(), "godot-doc-index-"));
    const output = join(directory, "index.json");
    await writeFile(output, JSON.stringify(index));
    expect(verifyDocsManifest(JSON.parse(await readFile(output, "utf8")), index.manifest)).toBe(true);
    index.classes.Node.description += "changed";
    expect(verifyDocsManifest(index, buildDocsIndex([{ path: "doc/classes/Node.xml", xml }], provenance).manifest)).toBe(false);
  });

  test("rejects every mutated immutable provenance field", async () => {
    const xml = await readFile(fixture, "utf8");
    const index = buildDocsIndex([{ path: "doc/classes/Node.xml", xml }], provenance);
    for (const field of ["engineVersion", "sourceCommit", "sourceArchiveSha256", "generatorVersion", "generatorSha256", "classCount", "memberCount", "contentSha256"] as const) {
      const changed = structuredClone(index);
      (changed.manifest as Record<string, unknown>)[field] = field.includes("Count") || field === "generatorVersion" ? 999 : "tampered";
      expect(verifyDocsManifest(changed, index.manifest), field).toBe(false);
    }
  });

  test("rejects malformed XML, DTDs, entities, and invalid numeric entities", () => {
    for (const xml of ["<class>", '<!DOCTYPE class SYSTEM "file:///secret"><class name="X"></class>', '<!ENTITY x SYSTEM "https://example.com"><class name="X">&x;</class>', '<class name="X"><description>&#x110000;</description></class>']) {
      expect(() => buildDocsIndex([{ path: "bad.xml", xml }], provenance)).toThrow();
    }
  });

  test("returns bounded class and member docs only for a matching live 4.6 engine", async () => {
    const xml = await readFile(fixture, "utf8");
    const index = buildDocsIndex([{ path: "doc/classes/Node.xml", xml }], provenance);
    const matching: VersionClient = { call: async () => ({ engine: { major: 4, minor: 6, patch: 2, status: "stable", build: "official", hash: "71f334935" } }) };
    await expect(classDoc(matching, index, { class: "Node" })).resolves.toMatchObject({ class: "Node", description: expect.stringContaining("Base fixture") });
    await expect(classDoc(matching, index, { class: "Node", member: { kind: "method", name: "add_child" } })).resolves.toMatchObject({ member: { kind: "method", name: "add_child", overloads: [{ description: "Adds by fixture name." }, { description: "Adds a child fixture." }] } });
    await expect(classDoc(matching, index, { class: "Node", member: { kind: "enum", name: "ProcessMode" } })).resolves.toMatchObject({ member: { values: ["PROCESS_MODE_DISABLED", "PROCESS_MODE_INHERIT"] } });
    const mismatched: VersionClient = { call: async () => ({ engine: { major: 4, minor: 7, patch: 0 } }) };
    await expect(classDoc(mismatched, index, { class: "Node" })).rejects.toMatchObject({ code: "feature_disabled" });
    await expect(classDoc(matching, index, { class: "Missing" })).rejects.toMatchObject({ code: "invalid_args" });
    await expect(classDoc(matching, index, { class: "Node", member: { kind: "method", name: "missing" } })).rejects.toMatchObject({ code: "invalid_args" });
  });

  test("bounds the complete serialized response to 65536 bytes", async () => {
    const xml = `<class name="Huge"><brief_description>${"b".repeat(70_000)}</brief_description><description>${"d".repeat(70_000)}</description><methods><method name="large"><description>${"m".repeat(70_000)}</description></method></methods></class>`;
    const index = buildDocsIndex([{ path: "Huge.xml", xml }], provenance);
    const matching: VersionClient = { call: async () => ({ engine: { major: 4, minor: 6, patch: 2 } }) };
    const result = await classDoc(matching, index, { class: "Huge", member: { kind: "method", name: "large" } });
    expect(Buffer.byteLength(JSON.stringify(result))).toBe(65_536);
    expect(result.truncated).toBe(true);
  });

  test("bundles nonempty official Node class and member documentation", async () => {
    const index = await loadBundledDocsIndex();
    const matching: VersionClient = { call: async () => ({ engine: { major: 4, minor: 6, patch: 2 } }) };
    const node = await classDoc(matching, index, { class: "Node" });
    const addChild = await classDoc(matching, index, { class: "Node", member: { kind: "method", name: "add_child" } });
    expect(node.description.length).toBeGreaterThan(100);
    expect(addChild.member?.description.length).toBeGreaterThan(20);
    const processMode = await classDoc(matching, index, { class: "Node", member: { kind: "enum", name: "ProcessMode" } });
    expect((processMode.member as { values: string[] }).values).toContain("PROCESS_MODE_DISABLED");
    expect(Buffer.byteLength(JSON.stringify(addChild))).toBeLessThanOrEqual(262_144);
  });
});
