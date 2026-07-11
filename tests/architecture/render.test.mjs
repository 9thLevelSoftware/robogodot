import test from "node:test";
import assert from "node:assert/strict";
import {
  ARCHIVE_SHA256,
  CLI_VERSION,
  EXPORT_MAP,
  buildManifest,
  buildNpxInvocation,
  collectAtlasIds,
  diffTraceability,
  extractMermaidBlocks,
  mergeManifestEntries,
  parseTraceabilityIds,
} from "../../docs/architecture/render.mjs";

const sample = `# Sample

\`\`\`mermaid
flowchart LR
  accTitle: Sample
  accDescr: Accessible sample
  %% atlas-node: ACT-SAMPLE
  ACT_SAMPLE["Sample"]
  %% atlas-node: SYS-TARGET
  SYS_TARGET["Target"]
  %% atlas-flow: FLOW-SAMPLE-001
  ACT_SAMPLE -->|uses| SYS_TARGET
\`\`\`
`;

test("extracts Mermaid blocks", () => {
  assert.equal(extractMermaidBlocks(sample).length, 1);
});

test("collects semantic IDs from Mermaid source", () => {
  assert.deepEqual(
    [...collectAtlasIds(extractMermaidBlocks(sample))].sort(),
    ["ACT-SAMPLE", "FLOW-SAMPLE-001", "SYS-TARGET"],
  );
});

test("parses traceability IDs and reports both directions", () => {
  const trace = `| ID | Name |\n|---|---|\n| \`ACT-SAMPLE\` | Sample |\n| \`FLOW-STALE\` | Stale |`;
  const ids = parseTraceabilityIds(trace);
  assert.deepEqual(diffTraceability(new Set(["ACT-SAMPLE", "SYS-TARGET"]), ids), {
    missing: ["SYS-TARGET"],
    stale: ["FLOW-STALE"],
  });
});

test("pins the renderer and declares eleven exports", () => {
  assert.equal(CLI_VERSION, "11.16.0");
  assert.equal(ARCHIVE_SHA256, "0B78D0AC0B0676AEFD31A394ADBB95980B6AC2A6273246840325633CB1F96229");
  assert.equal(Object.values(EXPORT_MAP).flat().length, 11);
});

test("routes Windows npm command shims through cmd.exe", () => {
  assert.equal(typeof buildNpxInvocation, "function", "renderer exports its launcher contract");
  assert.deepEqual(buildNpxInvocation("win32"), {
    executable: "cmd.exe",
    argsPrefix: ["/d", "/s", "/c", "npx.cmd"],
  });
  assert.deepEqual(buildNpxInvocation("linux"), {
    executable: "npx",
    argsPrefix: [],
  });
});

test("builds detached export provenance", () => {
  const manifest = buildManifest(
    [{ output: "01-system-context.svg", source: "01-system-context.md", block: 1 }],
    "2026-07-10T00:00:00.000Z",
  );
  assert.equal(manifest.renderer, "@mermaid-js/mermaid-cli@11.16.0");
  assert.equal(manifest.sourceArchive.sha256, ARCHIVE_SHA256);
  assert.equal(manifest.exports[0].block, 1);
});

test("merges targeted exports without dropping prior manifest entries", () => {
  assert.deepEqual(
    mergeManifestEntries(
      [{ output: "01-system-context.svg", source: "01-system-context.md", block: 1 }],
      [{ output: "02-container-channels.svg", source: "02-container-channels.md", block: 1 }],
    ).map((entry) => entry.output),
    ["01-system-context.svg", "02-container-channels.svg"],
  );
});
