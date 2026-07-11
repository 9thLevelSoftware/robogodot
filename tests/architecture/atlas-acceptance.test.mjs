import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ARCHIVE_SHA256,
  CLI_VERSION,
  EXPORT_MAP,
  collectAtlasIds,
  extractMermaidBlocks,
  parseTraceabilityIds,
  validateTraceability,
} from "../../docs/architecture/render.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ARCHITECTURE = path.join(ROOT, "docs", "architecture");
const RENDERED = path.join(ARCHITECTURE, "rendered");
const VIEWS = Object.keys(EXPORT_MAP);
const DOCUMENTS = [...VIEWS, "open-questions.md", "traceability.md"];
const README_SECTIONS = [
  "Purpose and audience",
  "Source baseline and archive hash",
  "Key architecture conclusion",
  "Reading order",
  "Diagram index",
  "Evidence and ID legend",
  "Five capability channels",
  "How to use the atlas during each phase",
  "Rendering and regeneration",
  "Accessibility and text alternatives",
  "Known open questions",
  "Verification commands",
];

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(target);
    return entry.isFile() && entry.name.endsWith(".md") ? [target] : [];
  }));
  return nested.flat();
}

export function assertMermaidEvidence(block, context = "Mermaid block") {
  const isFlowchart = /^\s*(?:flowchart|graph)\s+/m.test(block);
  const edgePattern = /(?:-\.->|-\.-|-->|==>|---|->>|-->>|-x|--x)/;
  for (const line of block.split(/\r?\n/).filter((candidate) => edgePattern.test(candidate))) {
    if (isFlowchart && /inferred/i.test(line)) assert.match(line, /«inferred»/i, `${context}: inferred flowchart marker: ${line}`);
    if (isFlowchart && /unresolved/i.test(line)) {
      assert.match(line, /\? unresolved/i, `${context}: unresolved flowchart marker: ${line}`);
      assert.match(line, /\bQ-\d{3}\b/, `${context}: unresolved flowchart Q ID: ${line}`);
    }
    if (!isFlowchart && /inferred|unresolved/i.test(line)) {
      assert.match(line, /\[(?:INFERRED|UNRESOLVED)\]/, `${context}: sequence/state evidence marker: ${line}`);
    }
  }
}

export function assertNoDoubledBacktickCitations(markdown, context = "Markdown") {
  const prose = markdown.split(/\r?\n/).filter((line) => !/^\s*```/.test(line)).join("\n");
  assert.doesNotMatch(prose, /``/, `${context}: malformed doubled-backtick citation`);
}

test("dotted flowchart edges require the family-specific unresolved marker and Q ID", () => {
  assert.doesNotThrow(() => assertMermaidEvidence(`flowchart TB\n  A -.->|"? unresolved · Q-002"| B`, "phase fixture"));
  assert.throws(
    () => assertMermaidEvidence(`flowchart TB\n  A -.->|"unresolved · Q-002"| B`, "phase fixture"),
    /unresolved flowchart marker/,
  );
});

test("doubled-backtick citation detection covers source-summary filename lines", () => {
  assert.throws(
    () => assertNoDoubledBacktickCitations("- Source: `phase-01-foundation-and-transport.md` — ``4–6 and 8–9."),
    /malformed doubled-backtick citation/,
  );
  assert.doesNotThrow(() => assertNoDoubledBacktickCitations("```mermaid\nflowchart LR\n```"));
});

test("README is the complete atlas entry point in the required order", async () => {
  const markdown = await readFile(path.join(ARCHITECTURE, "README.md"), "utf8");
  let previous = -1;
  for (const section of README_SECTIONS) {
    const index = markdown.indexOf(`## ${section}`);
    assert.ok(index > previous, `missing or out-of-order README section: ${section}`);
    previous = index;
  }
  for (const filename of DOCUMENTS) assert.match(markdown, new RegExp(`\\(${filename.replaceAll(".", "\\.")}\\)`));
  for (const token of [
    "files.zip", ARCHIVE_SHA256, `@mermaid-js/mermaid-cli@${CLI_VERSION}`,
    "Explicit", "Inferred", "Unresolved", "Editor mutation", "Introspection",
    "Code intelligence", "Runtime/debug", "Headless batch/filesystem",
    "node docs/architecture/render.mjs --check", "node docs/architecture/render.mjs",
    "node --test tests/architecture/*.test.mjs", "canonical", "generated",
  ]) assert.ok(markdown.includes(token), `README missing: ${token}`);
});

test("the pinned source archive hash matches the actual ZIP", async () => {
  const archive = await readFile("C:\\Users\\dasbl\\Downloads\\files.zip");
  assert.equal(createHash("sha256").update(archive).digest("hex").toUpperCase(), ARCHIVE_SHA256);
});

test("every local Markdown link in the architecture package resolves", async () => {
  for (const filename of await markdownFiles(ARCHITECTURE)) {
    const markdown = await readFile(filename, "utf8");
    for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split("#", 1)[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      await assert.doesNotReject(access(path.resolve(path.dirname(filename), decodeURIComponent(target))), `${filename}: ${target}`);
    }
  }
});

test("all Mermaid blocks provide accessibility metadata and evidence text", async () => {
  for (const filename of VIEWS) {
    const markdown = await readFile(path.join(ARCHITECTURE, filename), "utf8");
    for (const block of extractMermaidBlocks(markdown)) {
      assert.match(block, /\baccTitle:/, `${filename}: accTitle`);
      assert.match(block, /\baccDescr:/, `${filename}: accDescr`);
      assertMermaidEvidence(block, filename);
    }
    const diagramText = extractMermaidBlocks(markdown).join("\n");
    for (const question of new Set([...diagramText.matchAll(/\b(Q-\d{3})\b/g)].map((match) => match[1]))) {
      assert.match(markdown, new RegExp(`\\[${question}\\]\\(open-questions\\.md#architecture-open-questions\\)`), `${filename}: linked ${question}`);
    }
  }
});

test("atlas and traceability IDs match bidirectionally without duplicate trace rows", async () => {
  const blocks = [];
  for (const filename of VIEWS) blocks.push(...extractMermaidBlocks(await readFile(path.join(ARCHITECTURE, filename), "utf8")));
  const traceMarkdown = await readFile(path.join(ARCHITECTURE, "traceability.md"), "utf8");
  assert.deepEqual([...collectAtlasIds(blocks)].sort(), [...parseTraceabilityIds(traceMarkdown)].sort());
  assert.deepEqual([...validateTraceability(traceMarkdown)].sort(), [...parseTraceabilityIds(traceMarkdown)].sort());
});

test("lifecycle view contains no malformed doubled-backtick citations", async () => {
  const markdown = await readFile(path.join(ARCHITECTURE, "08-connection-lifecycles.md"), "utf8");
  assertNoDoubledBacktickCitations(markdown, "08-connection-lifecycles.md");
});

test("all eleven SVG exports are nonempty and have complete manifest provenance", async () => {
  const expected = Object.values(EXPORT_MAP).flat().sort();
  const actual = (await readdir(RENDERED)).filter((name) => name.endsWith(".svg")).sort();
  assert.equal(expected.length, 11);
  assert.deepEqual(actual, expected);
  for (const output of actual) assert.ok((await stat(path.join(RENDERED, output))).size > 0, `${output}: empty`);
  const manifest = JSON.parse(await readFile(path.join(RENDERED, "manifest.json"), "utf8"));
  assert.equal(manifest.renderer, `@mermaid-js/mermaid-cli@${CLI_VERSION}`);
  assert.equal(manifest.sourceArchive.sha256, ARCHIVE_SHA256);
  assert.match(manifest.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(manifest.exports.length, 11);
  assert.deepEqual(manifest.exports.map(({ output }) => output).sort(), expected);
  for (const entry of manifest.exports) {
    assert.ok(VIEWS.includes(entry.source), `${entry.output}: source`);
    assert.ok(Number.isInteger(entry.block) && entry.block > 0, `${entry.output}: block ordinal`);
    assert.equal(entry.archiveSha256, ARCHIVE_SHA256, `${entry.output}: archive SHA-256`);
    assert.match(entry.generatedAt, /^\d{4}-\d{2}-\d{2}T/, `${entry.output}: generation date`);
    assert.equal(entry.renderer, `@mermaid-js/mermaid-cli@${CLI_VERSION}`, `${entry.output}: renderer`);
  }
  for (const filename of VIEWS) assert.ok((await readFile(path.join(ARCHITECTURE, filename), "utf8")).includes(ARCHIVE_SHA256));
});

test("the repository tracks no render temporary directories or extracted Mermaid files", async () => {
  const { spawnSync } = await import("node:child_process");
  const tracked = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(tracked.status, 0, tracked.stderr);
  assert.doesNotMatch(tracked.stdout, /(?:^|[/\\])\.render-tmp(?:[/\\]|$)|\.mmd$/m);
});
