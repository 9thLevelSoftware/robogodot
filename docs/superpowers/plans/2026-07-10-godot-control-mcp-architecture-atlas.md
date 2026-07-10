# Godot Control MCP Architecture Atlas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a source-backed Mermaid architecture atlas that engineers and AI agents can use to implement Phases 1–8 of `godot-control-mcp`.

**Architecture:** Canonical diagrams live inside focused Markdown documents. A dependency-free Node.js wrapper extracts each Mermaid block, verifies exhaustive stable-ID traceability, renders with pinned Mermaid CLI 11.16.0, and writes eleven SVGs plus a provenance manifest. Every view has adjacent prose and relationship tables; source truth, inference, and unresolved decisions remain textually distinct.

**Tech Stack:** Markdown, Mermaid, Node.js built-ins, Node test runner, `@mermaid-js/mermaid-cli@11.16.0`, SVG, Git.

## Global Constraints

- Treat `docs/superpowers/specs/2026-07-10-godot-control-mcp-architecture-atlas-design.md` as the approved contract.
- Use `C:\Users\dasbl\Downloads\files.zip` with SHA-256 `0B78D0AC0B0676AEFD31A394ADBB95980B6AC2A6273246840325633CB1F96229` as the only architecture source baseline.
- Do not scaffold or implement the Godot MCP product; add documentation and atlas-verification support only.
- Keep Markdown-embedded Mermaid canonical. Do not add PlantUML, Structurizr, DOT, hand-positioned coordinates, or a second diagram source language.
- Pin rendering to `@mermaid-js/mermaid-cli@11.16.0` with neutral theme, white background, and `Arial, sans-serif`.
- Assign every modeled node, state, phase, channel, and relationship a stable `ACT-*`, `SYS-*`, `CNT-*`, `CMP-*`, `CH-*`, `PHASE-*`, `STATE-*`, or `FLOW-*` ID.
- Put `%% atlas-node: <ID>` immediately before every node/state declaration and `%% atlas-flow: <ID>` immediately before every relationship/transition/message.
- Treat explicit, inferred, and unresolved evidence as textual data. Flowcharts reinforce it with solid, dashed, or dotted styling; sequence and state diagrams use `[INFERRED]` and `[UNRESOLVED]` prefixes without repurposing message/transition semantics.
- Give every diagram an accessible `accTitle` and `accDescr`, a prose summary, a structured node/relationship outline, phase ownership, and source anchors.
- Maintain bidirectional traceability: the set of atlas IDs in Mermaid blocks must equal the set of IDs in `traceability.md`, excluding `Q-*` open-question IDs.
- Generate seven single-view SVGs, four lifecycle SVGs, and `rendered/manifest.json`; do not commit temporary render files.
- Preserve source contradictions as `Q-*` entries rather than selecting an unsupported answer.
- End every task with passing targeted tests and a focused commit.

---

## File Map

| Path | Responsibility |
|---|---|
| `docs/architecture/README.md` | Atlas entry point, source baseline, legend, reading order, regeneration, and acceptance summary |
| `docs/architecture/01-system-context.md` | Actors, local system scope, trust boundaries, and optional external provider |
| `docs/architecture/02-container-channels.md` | Primary five-channel runtime/container architecture and protocols |
| `docs/architecture/03-phase-dependencies.md` | Phase prerequisites plus produced and consumed interfaces |
| `docs/architecture/04-server-components.md` | TypeScript control plane, Godot plugin, middleware, adapters, and version-coupled services |
| `docs/architecture/05-editor-mutation-sequence.md` | Tier A validation, safety, serialization, UndoRedo, invalidation, audit, and errors |
| `docs/architecture/06-runtime-debug-sequence.md` | Process launch, output, DAP, runtime IPC, screenshot/input, stop, and cleanup |
| `docs/architecture/07-policy-pipeline.md` | Mode gate, guards, read cache, mutation queue, handler, audit, and structured outcomes |
| `docs/architecture/08-connection-lifecycles.md` | Four focused WebSocket, LSP, process, and DAP state diagrams |
| `docs/architecture/traceability.md` | Exhaustive node/edge evidence, source, phase, interface, and consequence table |
| `docs/architecture/open-questions.md` | Stable unresolved decisions and implementation impact |
| `docs/architecture/mermaid-config.json` | Reproducible Mermaid theme, font, security, and layout configuration |
| `docs/architecture/render.mjs` | Block extraction, ID validation, CLI rendering, cleanup, and provenance manifest generation |
| `docs/architecture/rendered/*.svg` | Generated vector exports; never edited by hand |
| `docs/architecture/rendered/manifest.json` | Export-to-source provenance and renderer metadata |
| `tests/architecture/render.test.mjs` | Pure rendering/validation helper tests |
| `tests/architecture/assertions.mjs` | Shared exact-ID, block-count, accessibility, and token assertions for content tests |
| `tests/architecture/open-questions.test.mjs` | Required unresolved-decision inventory |
| `tests/architecture/structural-views.test.mjs` | Context, channels, phases, and component content contracts |
| `tests/architecture/behavioral-views.test.mjs` | Sequence, policy, lifecycle, evidence-marker, and error-path contracts |
| `tests/architecture/atlas-acceptance.test.mjs` | Links, full traceability, export count, manifest, and accessibility acceptance |

## Shared Testing Convention

Each content test reads the canonical Markdown, calls helpers exported from `render.mjs`, and checks exact ID sets plus required protocol/source tokens. Use Node's built-in runner so no repository dependency manifest is required:

```powershell
node --test tests/architecture/*.test.mjs
```

Expected final result: every subtest reports `ok`, the summary reports zero failures, and the process exits `0`.

Content-test files use this exact shape, with each task's complete ID and token inventories substituted into the arrays:

```js
import test from "node:test";
import { assertView } from "./assertions.mjs";

test("view contract", async () => {
  await assertView("01-system-context.md", {
    ids: ["ACT-ENGINEER-AI", "SYS-GODOT-CONTROL-MCP", "FLOW-CTX-001"],
    tokens: ["0B78D0AC0B0676AEFD31A394ADBB95980B6AC2A6273246840325633CB1F96229"],
  });
});
```

Do not leave the abbreviated three-ID example in the completed test; use the full inventory specified by the task.

---

### Task 1: Build the deterministic render and validation harness

**Files:**
- Create: `docs/architecture/mermaid-config.json`
- Create: `docs/architecture/render.mjs`
- Create: `tests/architecture/render.test.mjs`
- Create: `tests/architecture/assertions.mjs`

**Interfaces:**
- Consumes: Markdown files containing fenced `mermaid` blocks and `docs/architecture/traceability.md`.
- Produces: `extractMermaidBlocks(markdown): string[]`, `collectAtlasIds(blocks): Set<string>`, `parseTraceabilityIds(markdown): Set<string>`, `diffTraceability(diagramIds, traceabilityIds): {missing: string[], stale: string[]}`, `mergeManifestEntries(existing, next): object[]`, `buildManifest(entries, generatedAt): object`, and the CLI `node docs/architecture/render.mjs [--check] [--only <comma-list>]`.

- [ ] **Step 1: Write the failing helper tests**

Create `tests/architecture/render.test.mjs` with these cases:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  ARCHIVE_SHA256,
  CLI_VERSION,
  EXPORT_MAP,
  buildManifest,
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
```

- [ ] **Step 2: Run the test and verify the expected failure**

Run:

```powershell
node --test tests/architecture/render.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `docs/architecture/render.mjs`.

- [ ] **Step 3: Add the pinned Mermaid configuration**

Create `docs/architecture/mermaid-config.json`:

```json
{
  "theme": "neutral",
  "securityLevel": "strict",
  "fontFamily": "Arial, sans-serif",
  "flowchart": {
    "defaultRenderer": "dagre",
    "htmlLabels": false,
    "curve": "linear",
    "useMaxWidth": false
  },
  "sequence": {
    "useMaxWidth": false,
    "wrap": true,
    "diagramMarginX": 24,
    "diagramMarginY": 24
  },
  "themeVariables": {
    "background": "#ffffff",
    "fontFamily": "Arial, sans-serif",
    "primaryTextColor": "#17202a",
    "lineColor": "#455a64"
  }
}
```

- [ ] **Step 4: Implement the pure helpers and export contract**

Create `docs/architecture/render.mjs` with the following constants and functions. Keep all filesystem and process work behind `renderAtlas()` so importing the module does not execute rendering.

```js
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CLI_VERSION = "11.16.0";
export const ARCHIVE_SHA256 = "0B78D0AC0B0676AEFD31A394ADBB95980B6AC2A6273246840325633CB1F96229";
export const EXPORT_MAP = Object.freeze({
  "01-system-context.md": ["01-system-context.svg"],
  "02-container-channels.md": ["02-container-channels.svg"],
  "03-phase-dependencies.md": ["03-phase-dependencies.svg"],
  "04-server-components.md": ["04-server-components.svg"],
  "05-editor-mutation-sequence.md": ["05-editor-mutation-sequence.svg"],
  "06-runtime-debug-sequence.md": ["06-runtime-debug-sequence.svg"],
  "07-policy-pipeline.md": ["07-policy-pipeline.svg"],
  "08-connection-lifecycles.md": [
    "08a-editor-websocket-lifecycle.svg",
    "08b-lsp-lifecycle.svg",
    "08c-game-process-lifecycle.svg",
    "08d-dap-lifecycle.svg",
  ],
});

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ID_PATTERN = /\b(?:ACT|SYS|CNT|CMP|CH|PHASE|STATE|FLOW)-[A-Z0-9-]+\b/g;

export function extractMermaidBlocks(markdown) {
  return [...markdown.matchAll(/```mermaid\s*\r?\n([\s\S]*?)```/g)].map((match) => match[1].trim());
}

export function collectAtlasIds(blocks) {
  const ids = new Set();
  for (const block of blocks) {
    for (const match of block.matchAll(ID_PATTERN)) ids.add(match[0]);
  }
  return ids;
}

export function parseTraceabilityIds(markdown) {
  const ids = new Set();
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^\|\s*`((?:ACT|SYS|CNT|CMP|CH|PHASE|STATE|FLOW)-[A-Z0-9-]+)`\s*\|/);
    if (match) ids.add(match[1]);
  }
  return ids;
}

export function diffTraceability(diagramIds, traceabilityIds) {
  return {
    missing: [...diagramIds].filter((id) => !traceabilityIds.has(id)).sort(),
    stale: [...traceabilityIds].filter((id) => !diagramIds.has(id)).sort(),
  };
}

export function buildManifest(entries, generatedAt = new Date().toISOString()) {
  return {
    schemaVersion: 1,
    generatedAt,
    renderer: `@mermaid-js/mermaid-cli@${CLI_VERSION}`,
    sourceArchive: { path: "C:\\Users\\dasbl\\Downloads\\files.zip", sha256: ARCHIVE_SHA256 },
    exports: entries,
  };
}

export function mergeManifestEntries(existing, next) {
  const replaced = new Set(next.map((entry) => entry.output));
  return [...existing.filter((entry) => !replaced.has(entry.output)), ...next]
    .sort((left, right) => left.output.localeCompare(right.output));
}

function parseArgs(argv) {
  const onlyIndex = argv.indexOf("--only");
  return {
    check: argv.includes("--check"),
    only: onlyIndex >= 0 ? new Set(argv[onlyIndex + 1].split(",")) : null,
  };
}

export async function renderAtlas({ check = false, only = null, root = ROOT } = {}) {
  const selected = Object.entries(EXPORT_MAP).filter(([source]) => !only || only.has(source.replace(/\.md$/, "")));
  if (selected.length === 0) throw new Error("No atlas views selected");

  const renderedDir = path.join(root, "rendered");
  const tempDir = path.join(root, ".render-tmp");
  const traceability = parseTraceabilityIds(await readFile(path.join(root, "traceability.md"), "utf8"));
  const diagramIds = new Set();
  const jobs = [];

  for (const [source, outputs] of selected) {
    const markdown = await readFile(path.join(root, source), "utf8");
    const blocks = extractMermaidBlocks(markdown);
    if (blocks.length !== outputs.length) {
      throw new Error(`${source}: expected ${outputs.length} Mermaid block(s), found ${blocks.length}`);
    }
    blocks.forEach((block, index) => {
      if (!block.includes("accTitle:") || !block.includes("accDescr:")) {
        throw new Error(`${source} block ${index + 1}: missing accTitle or accDescr`);
      }
      collectAtlasIds([block]).forEach((id) => diagramIds.add(id));
      jobs.push({ source, block: index + 1, definition: block, output: outputs[index] });
    });
  }

  const diff = diffTraceability(diagramIds, traceability);
  if (diff.missing.length || (!only && diff.stale.length)) {
    throw new Error(`Traceability mismatch: ${JSON.stringify(diff)}`);
  }
  if (check) return { jobs, diff };

  await mkdir(renderedDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });
  const entries = [];
  try {
    for (const job of jobs) {
      const input = path.join(tempDir, `${job.output}.mmd`);
      const output = path.join(renderedDir, job.output);
      await writeFile(input, `${job.definition}\n`, "utf8");
      const executable = process.platform === "win32" ? "npx.cmd" : "npx";
      const result = spawnSync(executable, [
        "--yes",
        `@mermaid-js/mermaid-cli@${CLI_VERSION}`,
        "-i", input,
        "-o", output,
        "-c", path.join(root, "mermaid-config.json"),
        "-t", "neutral",
        "-b", "white",
      ], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(`${job.output}: ${result.stderr || result.stdout}`);
      entries.push({ output: job.output, source: job.source, block: job.block });
    }
    let manifestEntries = entries;
    if (only) {
      try {
        const current = JSON.parse(await readFile(path.join(renderedDir, "manifest.json"), "utf8"));
        manifestEntries = mergeManifestEntries(current.exports || [], entries);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    await writeFile(
      path.join(renderedDir, "manifest.json"),
      `${JSON.stringify(buildManifest(manifestEntries), null, 2)}\n`,
      "utf8",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
  return { jobs, entries };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const options = parseArgs(process.argv.slice(2));
  await renderAtlas(options);
  process.stdout.write(options.check ? "Atlas validation passed\n" : "Atlas render passed\n");
}
```

- [ ] **Step 5: Add the shared content assertion helper**

Create `tests/architecture/assertions.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectAtlasIds, extractMermaidBlocks } from "../../docs/architecture/render.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs/architecture");

export async function assertView(filename, { blockCount = 1, ids, tokens = [] }) {
  const markdown = await readFile(path.join(ROOT, filename), "utf8");
  const blocks = extractMermaidBlocks(markdown);
  assert.equal(blocks.length, blockCount, `${filename}: Mermaid block count`);
  for (const [index, block] of blocks.entries()) {
    assert.match(block, /accTitle:/, `${filename} block ${index + 1}: accTitle`);
    assert.match(block, /accDescr:/, `${filename} block ${index + 1}: accDescr`);
  }
  assert.deepEqual([...collectAtlasIds(blocks)].sort(), [...ids].sort(), `${filename}: atlas IDs`);
  for (const token of tokens) assert.ok(markdown.includes(token), `${filename}: missing ${token}`);
  return markdown;
}
```

- [ ] **Step 6: Run the helper tests**

Run:

```powershell
node --test tests/architecture/render.test.mjs
```

Expected: six passing subtests and zero failures.

- [ ] **Step 7: Check formatting and commit**

Run:

```powershell
git diff --check
git add docs/architecture/mermaid-config.json docs/architecture/render.mjs tests/architecture/render.test.mjs tests/architecture/assertions.mjs
git commit -m "test: add architecture atlas render harness"
```

Expected: commit succeeds with only the four listed files.

---

### Task 2: Record the unresolved architecture decisions

**Files:**
- Create: `docs/architecture/open-questions.md`
- Create: `tests/architecture/open-questions.test.mjs`

**Interfaces:**
- Consumes: the ten source documents and the design specification's Open Questions section.
- Produces: stable `Q-001` through `Q-016` records used by unresolved diagram labels and traceability consequences.

- [ ] **Step 1: Write the failing question-inventory test**

Create a test that reads `open-questions.md`, extracts `Q-[0-9]{3}`, and requires exactly this ordered set:

```js
const expected = [
  "Q-001", "Q-002", "Q-003", "Q-004",
  "Q-005", "Q-006", "Q-007", "Q-008",
  "Q-009", "Q-010", "Q-011", "Q-012",
  "Q-013", "Q-014", "Q-015", "Q-016",
];
```

Also require the columns `ID`, `Decision needed`, `Conflicting evidence`, `Implementation impact`, `Recommended resolution`, and `Owning phase`.

- [ ] **Step 2: Run the test and verify the expected failure**

Run `node --test tests/architecture/open-questions.test.mjs`.

Expected: FAIL with `ENOENT` for `docs/architecture/open-questions.md`.

- [ ] **Step 3: Write the question register with exact ownership**

Create one row for each decision:

| ID | Decision needed | Owning phase |
|---|---|---|
| `Q-001` | Canonical universal editor-script tool name | Phase 2 |
| `Q-002` | Whether Phase 2 is a hard prerequisite for Phases 4–6 | Architecture/Phases 4–6 |
| `Q-003` | Heartbeat transport and relationship to `core.ping` | Phase 1 |
| `Q-004` | Local editor authentication, TLS, and multi-client policy | Phase 7 |
| `Q-005` | Undo semantics for project-setting mutation | Phase 3 |
| `Q-006` | Safety classification for arbitrary headless GDScript | Phase 7 |
| `Q-007` | Whether rejected calls always reach audit logging | Phase 7 |
| `Q-008` | Read consistency during an in-progress mutation | Phase 7 |
| `Q-009` | Allowed roots for export output paths | Phases 6–7 |
| `Q-010` | DAP versus ProcessRunner launch ownership | Phase 5 |
| `Q-011` | Host resolution of Godot's `user://` IPC path | Phase 5 |
| `Q-012` | Local-socket negotiation and file-IPC fallback | Phase 5 |
| `Q-013` | Canonical Node.js product engine requirement | Phase 8 |
| `Q-014` | Canonical `add-feature-to-scene` prompt name | Phase 8 |
| `Q-015` | Supported Godot minor-version matrix | Phase 8 |
| `Q-016` | Reconnect acceptance-window duration | Phase 8 |

For each row, quote or paraphrase both relevant source statements, describe the concrete implementation effect, and label the recommendation as a proposal rather than source truth.

- [ ] **Step 4: Run the targeted test**

Run `node --test tests/architecture/open-questions.test.mjs`.

Expected: all subtests pass.

- [ ] **Step 5: Commit the decision register**

```powershell
git add docs/architecture/open-questions.md tests/architecture/open-questions.test.mjs
git commit -m "docs: record architecture open questions"
```

---

### Task 3: Create the system-context and five-channel views

**Files:**
- Create: `docs/architecture/01-system-context.md`
- Create: `docs/architecture/02-container-channels.md`
- Create: `docs/architecture/traceability.md`
- Create: `tests/architecture/structural-views.test.mjs`

**Interfaces:**
- Consumes: master architecture sections on the two capability tiers, five channels, deployment boundaries, protocols, and safety; competitive-research synthesis.
- Produces: the primary architecture reading path and the initial exhaustive traceability table.

- [ ] **Step 1: Write failing structural tests for views 01 and 02**

Require one Mermaid block per file, `accTitle`, `accDescr`, the archive hash, and the exact IDs below.

View 01 nodes:

```text
ACT-ENGINEER-AI
SYS-GODOT-CONTROL-MCP
SYS-GODOT-EDITOR-PROJECT
SYS-RUNNING-GAME
SYS-PROJECT-FILES
SYS-ASSET-PROVIDER
```

View 01 flows:

```text
FLOW-CTX-001  uses tools, resources, and prompts via MCP
FLOW-CTX-002  controls and observes local Godot work
FLOW-CTX-003  edits scenes and resources through editor APIs
FLOW-CTX-004  launches and observes the running game
FLOW-CTX-005  reads and writes guarded project files
FLOW-CTX-006  optionally requests generated assets
```

View 02 nodes:

```text
CNT-MCP-CLIENT
CNT-TYPESCRIPT-SERVER
CH-EDITOR-MUTATION
CH-INTROSPECTION
CH-CODE-INTELLIGENCE
CH-RUNTIME-DEBUG
CH-HEADLESS-BATCH-FS
CNT-EDITOR-PLUGIN
SYS-CLASSDB-DOCS
CNT-GODOT-LSP
CNT-GODOT-DAP
CNT-RUNNING-GAME
CNT-RUNTIME-AUTOLOADS
CNT-HEADLESS-GODOT
CNT-PROJECT-STORAGE
CNT-ASSET-PROVIDER
```

View 02 flows:

```text
FLOW-CH-001  MCP over stdio
FLOW-CH-002  route editor mutation
FLOW-CH-003  WebSocket + JSON-RPC 2.0 on localhost:9200
FLOW-CH-004  route live introspection
FLOW-CH-005  query ClassDB and integrated documentation
FLOW-CH-006  LSP JSON-RPC over TCP 6005
FLOW-CH-007  spawn and control the game process
FLOW-CH-008  DAP over TCP 6006
FLOW-CH-009  correlated user:// file IPC
FLOW-CH-010  spawn godot --headless --script
FLOW-CH-011  guarded project-root file and UID access
FLOW-CH-012  optional provider API with unspecified protocol
```

Require the five source-defined channel names verbatim and reject a sixth top-level channel.

- [ ] **Step 2: Run the tests and verify the expected failure**

Run `node --test tests/architecture/structural-views.test.mjs`.

Expected: FAIL because views 01 and 02 do not exist.

- [ ] **Step 3: Implement view 01 as a C4-style context flowchart**

Use `flowchart LR`, a local-workstation boundary, an external optional-provider node, the exact node/flow anchors above, and relationship labels that preserve local-only scope. Follow the diagram with:

- a text summary stating that the TypeScript server is the control plane and Godot is the authoritative executor;
- a node outline with responsibility and trust boundary;
- a relationship table with ID, source heading, evidence, phase owner, and consequence; and
- an explicit note that provider transport details are not specified.

- [ ] **Step 4: Implement view 02 as the primary compound layered flowchart**

Use `flowchart LR` and group nodes into MCP client, TypeScript control plane, Godot editor, running game, headless execution, project storage, and optional external service. Model the five channels as named nodes. Make editor mutation and introspection converge on the same plugin transport, and make headless/batch/filesystem branch to both process-spawn and guarded-file mechanisms.

Use solid lines for explicit relationships. Label the optional provider edge `provider API · protocol unspecified`; do not attach `Q-012`, which belongs only to the runtime local-socket/file-IPC fallback, and do not label the provider's optional existence as inferred.

- [ ] **Step 5: Create the traceability schema and all view-01/view-02 rows**

Use this exact table header:

```markdown
| ID | Name | View | Evidence | Source | Phase owner | Consumes | Produces | Consequence |
|---|---|---|---|---|---|---|---|---|
```

Add one row for every ID listed in Steps 1–4. Reused entities have one row whose View cell lists both files. Record filename plus section heading, not line number alone.

- [ ] **Step 6: Run targeted checks and render both views**

```powershell
node --test tests/architecture/structural-views.test.mjs
node docs/architecture/render.mjs --check --only 01-system-context,02-container-channels
node docs/architecture/render.mjs --only 01-system-context,02-container-channels
```

Expected: tests and traceability check pass; two SVGs and a partial manifest are generated.

- [ ] **Step 7: Inspect and commit**

Open both SVGs in the local image viewer. Confirm readable labels, obvious left-to-right flow, no overlapping nodes, and no line through a label. Then run:

```powershell
git add docs/architecture/01-system-context.md docs/architecture/02-container-channels.md docs/architecture/traceability.md docs/architecture/rendered/01-system-context.svg docs/architecture/rendered/02-container-channels.svg docs/architecture/rendered/manifest.json tests/architecture/structural-views.test.mjs
git commit -m "docs: map system context and execution channels"
```

---

### Task 4: Map phase dependencies and interface handoffs

**Files:**
- Create: `docs/architecture/03-phase-dependencies.md`
- Modify: `docs/architecture/traceability.md`
- Modify: `tests/architecture/structural-views.test.mjs`

**Interfaces:**
- Consumes: all phase `Consumes`, `Produces`, isolation-contract, and acceptance sections.
- Produces: a phase DAG plus an implementation table usable as a work-order map.

- [ ] **Step 1: Add the failing phase-contract test**

Require nodes `PHASE-00-RESEARCH`, `PHASE-00-MASTER`, and `PHASE-01` through `PHASE-08`. Require these relationships:

```text
FLOW-PH-001  PHASE-00-RESEARCH -> PHASE-01
FLOW-PH-002  PHASE-00-MASTER -> PHASE-01
FLOW-PH-003  PHASE-01 -> PHASE-02
FLOW-PH-004  PHASE-01 -> PHASE-03
FLOW-PH-005  PHASE-02 -> PHASE-03
FLOW-PH-006  PHASE-01 -> PHASE-04
FLOW-PH-007  PHASE-02 -> PHASE-04  [UNRESOLVED Q-002]
FLOW-PH-008  PHASE-01 -> PHASE-05
FLOW-PH-009  PHASE-02 -> PHASE-05
FLOW-PH-010  PHASE-01 -> PHASE-06
FLOW-PH-011  PHASE-02 -> PHASE-06  [UNRESOLVED Q-002]
FLOW-PH-012  PHASE-01 -> PHASE-07
FLOW-PH-013  PHASE-02 -> PHASE-07
FLOW-PH-014  PHASE-03 -> PHASE-07
FLOW-PH-015  PHASE-04 -> PHASE-07
FLOW-PH-016  PHASE-05 -> PHASE-07
FLOW-PH-017  PHASE-06 -> PHASE-07
FLOW-PH-018  PHASE-07 -> PHASE-08
```

Also require interface labels `JsonRpcClient.call`, `registerTool`, `godot_compat.gd`, `TypeParser`, `IntrospectionService`, `SafetyPolicy`, `RequestQueue`, `Cache`, `Health`, and `AuditLog`.

- [ ] **Step 2: Verify the new test fails**

Run the structural test file. Expected: FAIL because view 03 is missing.

- [ ] **Step 3: Implement the phase dependency diagram and interface table**

Use `flowchart TB`. Put documentary inputs above Phase 1, Phases 3–6 at the same visual rank, Phase 7 below their convergence, and Phase 8 last. Use dotted `? unresolved · Q-002` edges for Phase 2 to Phases 4 and 6. In the adjacent table, give every phase an Objective, Consumes, Produces, Isolation stub, and Acceptance evidence cell.

- [ ] **Step 4: Append exact traceability rows**

Add all ten phase/documentary nodes and eighteen flow rows. Explain in `FLOW-PH-007` and `FLOW-PH-011` that the plan headers and master prose disagree about the strength of the Phase 2 prerequisite.

- [ ] **Step 5: Test, render, inspect, and commit**

```powershell
node --test tests/architecture/structural-views.test.mjs
node docs/architecture/render.mjs --check --only 03-phase-dependencies
node docs/architecture/render.mjs --only 03-phase-dependencies
git add docs/architecture/03-phase-dependencies.md docs/architecture/traceability.md docs/architecture/rendered/03-phase-dependencies.svg docs/architecture/rendered/manifest.json tests/architecture/structural-views.test.mjs
git commit -m "docs: map phase dependencies and contracts"
```

Expected visual result: the implementation order is readable without diagonal edge hunting; unresolved Phase 2 edges are textually marked.

---

### Task 5: Map server, plugin, and Godot components

**Files:**
- Create: `docs/architecture/04-server-components.md`
- Modify: `docs/architecture/traceability.md`
- Modify: `tests/architecture/structural-views.test.mjs`

**Interfaces:**
- Consumes: component/file layouts in Phases 1–7 and Phase 8 surface registration.
- Produces: the code-boundary map used by implementers to place modules and preserve version coupling.

- [ ] **Step 1: Add a failing component inventory test**

Require these grouped component IDs:

```text
CMP-MCP-BOOTSTRAP
CMP-REGISTRY
CMP-SCHEMA-CONTRACTS
CMP-TOOL-FAMILIES
CMP-RESOURCE-PROMPT-SURFACES
CMP-SAFETY
CMP-REQUEST-QUEUE
CMP-READ-CACHE
CMP-AUDIT
CMP-HEALTH
CMP-SEMANTIC-SERVICES
CMP-TRANSPORT-ADAPTERS
CMP-WS-SERVER
CMP-COMMAND-ROUTER
CMP-CORE-COMMANDS
CMP-INTROSPECTION-COMMANDS
CMP-EXEC-COMMANDS
CMP-EDIT-COMMANDS
CMP-EDIT-CONTROLLER
CMP-GODOT-COMPAT
CMP-RUNTIME-AUTOLOADS
SYS-EDITOR-APIS
SYS-CLASSDB-DOCS
SYS-UNDO-REDO
```

Require labels for Tier A, Tier B, TypeParser, WebSocket, LSP, DAP, ProcessRunner, runtime IPC, HeadlessRunner, FsGuard, UID/export, and optional AssetProvider.
Require every flow ID from `FLOW-CMP-001` through `FLOW-CMP-023` exactly once.

- [ ] **Step 2: Run the test and observe the missing-view failure**

Run the structural test file. Expected: FAIL for `04-server-components.md`.

- [ ] **Step 3: Implement a top-to-bottom compound component view**

Use four visually subordinate groups: MCP surface, TypeScript server, GDScript editor plugin, and Godot services/runtime. Keep cross-cutting middleware as a single ordered band between registry and handlers. Keep transport adapters grouped in one node with a structured outline below the diagram so the main graph remains readable.

Use these exact relationships, one ID per rendered edge:

```text
FLOW-CMP-001  CMP-MCP-BOOTSTRAP -> CMP-REGISTRY
FLOW-CMP-002  CMP-REGISTRY -> CMP-SCHEMA-CONTRACTS
FLOW-CMP-003  CMP-REGISTRY -> CMP-SAFETY
FLOW-CMP-004  CMP-SAFETY -> CMP-REQUEST-QUEUE
FLOW-CMP-005  CMP-SAFETY -> CMP-READ-CACHE
FLOW-CMP-006  CMP-REGISTRY -> CMP-AUDIT
FLOW-CMP-007  CMP-AUDIT -> CMP-HEALTH
FLOW-CMP-008  CMP-REGISTRY -> CMP-TOOL-FAMILIES
FLOW-CMP-009  CMP-REGISTRY -> CMP-RESOURCE-PROMPT-SURFACES
FLOW-CMP-010  CMP-TOOL-FAMILIES -> CMP-SEMANTIC-SERVICES
FLOW-CMP-011  CMP-TOOL-FAMILIES -> CMP-TRANSPORT-ADAPTERS
FLOW-CMP-012  CMP-TRANSPORT-ADAPTERS -> CMP-WS-SERVER
FLOW-CMP-013  CMP-WS-SERVER -> CMP-COMMAND-ROUTER
FLOW-CMP-014  CMP-COMMAND-ROUTER -> CMP-CORE-COMMANDS
FLOW-CMP-015  CMP-COMMAND-ROUTER -> CMP-INTROSPECTION-COMMANDS
FLOW-CMP-016  CMP-COMMAND-ROUTER -> CMP-EXEC-COMMANDS
FLOW-CMP-017  CMP-COMMAND-ROUTER -> CMP-EDIT-COMMANDS
FLOW-CMP-018  CMP-EDIT-COMMANDS -> CMP-EDIT-CONTROLLER
FLOW-CMP-019  CMP-EDIT-CONTROLLER -> SYS-UNDO-REDO
FLOW-CMP-020  CMP-INTROSPECTION-COMMANDS -> SYS-CLASSDB-DOCS
FLOW-CMP-021  CMP-COMMAND-ROUTER -> CMP-GODOT-COMPAT
FLOW-CMP-022  CMP-GODOT-COMPAT -> SYS-EDITOR-APIS
FLOW-CMP-023  CMP-TRANSPORT-ADAPTERS -> CMP-RUNTIME-AUTOLOADS
```

Do not add an untracked connector for relationships mentioned only in prose. The adjacent outline expands the grouped tool and adapter families without multiplying connectors.

- [ ] **Step 4: Add component and flow traceability**

Append one row for every component and `FLOW-CMP-001..023`. The Consequence column must name the planned module or directory when the source provides it, such as `bridge/ws-client.ts`, `lsp/client.ts`, `runtime/dap-client.ts`, `batch/headless.ts`, `commands/edit.gd`, or `godot_compat.gd`.

- [ ] **Step 5: Test, render, inspect, and commit**

```powershell
node --test tests/architecture/structural-views.test.mjs
node docs/architecture/render.mjs --check --only 04-server-components
node docs/architecture/render.mjs --only 04-server-components
git add docs/architecture/04-server-components.md docs/architecture/traceability.md docs/architecture/rendered/04-server-components.svg docs/architecture/rendered/manifest.json tests/architecture/structural-views.test.mjs
git commit -m "docs: map server and plugin components"
```

Expected: the SVG reads from surface to policy to adapters to plugin/Godot; no connector crosses a group title.

---

### Task 6: Document the curated editor-mutation sequence

**Files:**
- Create: `docs/architecture/05-editor-mutation-sequence.md`
- Modify: `docs/architecture/traceability.md`
- Create: `tests/architecture/behavioral-views.test.mjs`

**Interfaces:**
- Consumes: Phase 3 mutation contract plus Phase 2 typed validation, Phase 1 transport, and Phase 7 middleware.
- Produces: the normative Tier A request order, failure ownership, and cache/audit consequences.

- [ ] **Step 1: Write a failing sequence-contract test**

Require these participants:

```text
CNT-MCP-CLIENT
CMP-REGISTRY
CMP-SCHEMA-CONTRACTS
CMP-SEMANTIC-SERVICES
CMP-SAFETY
CMP-REQUEST-QUEUE
CMP-WS-CLIENT
CMP-COMMAND-ROUTER
CMP-EDIT-CONTROLLER
SYS-UNDO-REDO
CMP-READ-CACHE
CMP-AUDIT
```

Require `FLOW-MUT-001` through `FLOW-MUT-018`, plus the tokens `invalid_args`, `blocked_by_policy`, `not_connected`, `timeout`, `godot_error`, `Q-005`, `cache invalidation`, and `structuredContent`.

- [ ] **Step 2: Run the test and verify it fails for the missing sequence**

Run `node --test tests/architecture/behavioral-views.test.mjs`.

- [ ] **Step 3: Implement the sequence with exact flow order**

Use `sequenceDiagram` and this order:

```text
FLOW-MUT-001  MCP call enters registry
FLOW-MUT-002  Zod schema validation
FLOW-MUT-003  path/property/type validation through semantic services
FLOW-MUT-004  safety mode and annotation evaluation
FLOW-MUT-005  invalid_args alternative return
FLOW-MUT-006  blocked_by_policy alternative
FLOW-MUT-007  [INFERRED] blocked outcome reaches audit (Q-007)
FLOW-MUT-008  enqueue one FIFO mutation
FLOW-MUT-009  correlated JSON-RPC call
FLOW-MUT-010  route edit command
FLOW-MUT-011  create one undo action
FLOW-MUT-012  register do/undo operations
FLOW-MUT-013  commit action
FLOW-MUT-014  result returns through transport
FLOW-MUT-015  invalidate affected cache tags
FLOW-MUT-016  append redacted audit outcome
FLOW-MUT-017  return structuredContent
FLOW-MUT-018  [UNRESOLVED] destructive project-setting exception (Q-005)
```

Add grouped alternatives for transport loss/timeout and Godot failure. Use normal Mermaid arrow semantics; evidence status appears in message text and notes, not arrow shape.

- [ ] **Step 4: Add all participant and flow rows to traceability**

Reuse existing participant rows by adding view 05 to their View cells. Add a new row for each `FLOW-MUT-*` ID with source headings from Phases 1, 2, 3, and 7.

- [ ] **Step 5: Test, render, inspect, and commit**

```powershell
node --test tests/architecture/behavioral-views.test.mjs
node docs/architecture/render.mjs --check --only 05-editor-mutation-sequence
node docs/architecture/render.mjs --only 05-editor-mutation-sequence
git add docs/architecture/05-editor-mutation-sequence.md docs/architecture/traceability.md docs/architecture/rendered/05-editor-mutation-sequence.svg docs/architecture/rendered/manifest.json tests/architecture/behavioral-views.test.mjs
git commit -m "docs: document curated mutation sequence"
```

Expected: chronological order is clear, failure alternatives do not obscure the happy path, and every unresolved message is textually prefixed.

---

### Task 7: Document runtime, DAP, and bridge interaction

**Files:**
- Create: `docs/architecture/06-runtime-debug-sequence.md`
- Modify: `docs/architecture/traceability.md`
- Modify: `tests/architecture/behavioral-views.test.mjs`

**Interfaces:**
- Consumes: Phase 5 ProcessRunner, DapClient, runtime autoload, IPC, screenshot, and cleanup contracts.
- Produces: the end-to-end runtime observation/debug sequence and explicit unresolved ownership notes.

- [ ] **Step 1: Add the failing runtime-contract test**

Require participants:

```text
CNT-MCP-CLIENT
CMP-RUNTIME-TOOLS
CMP-PROCESS-RUNNER
CNT-RUNNING-GAME
CMP-DAP-CLIENT
CNT-GODOT-DAP
CMP-RUNTIME-DRIVER
CMP-RUNTIME-AUTOLOADS
CNT-RUNTIME-IPC-FILES
CMP-AUDIT
```

Require `FLOW-RUN-001..020`, `since`, `next`, `req.json`, `resp-<id>.json`, `PNG`, `Q-010`, `Q-011`, `Q-012`, and `degrade to process + bridge`.

- [ ] **Step 2: Run the behavioral tests and observe the missing-view failure**

- [ ] **Step 3: Implement the sequence in three labeled phases**

Use one `sequenceDiagram` with setup, interaction, and shutdown rectangles. Encode:

```text
FLOW-RUN-001  godot_run_project
FLOW-RUN-002  spawn godot --path <project> [scene]
FLOW-RUN-003  stream stdout/stderr into ring buffer
FLOW-RUN-004  incremental output using since/next
FLOW-RUN-005  initialize DAP
FLOW-RUN-006  [UNRESOLVED] launch or attach ownership (Q-010)
FLOW-RUN-007  inject/use bridge autoloads through Phase 2 execution
FLOW-RUN-008  runtime inspect/input/screenshot request
FLOW-RUN-009  allocate monotonic request ID
FLOW-RUN-010  write user://.mcp/req.json
FLOW-RUN-011  autoload polls and reads request
FLOW-RUN-012  execute requested operation
FLOW-RUN-013  write user://.mcp/resp-<id>.json
FLOW-RUN-014  server reads and deletes response
FLOW-RUN-015  return structured result
FLOW-RUN-016  timeout alternative with game-not-running hint
FLOW-RUN-017  screenshot alternative returns path, dimensions, and PNG
FLOW-RUN-018  graceful stop, then force if required
FLOW-RUN-019  remove IPC files, end DAP, clean orphan PID
FLOW-RUN-020  audit outcome
```

Add notes for unresolved host resolution (`Q-011`) and socket negotiation/fallback (`Q-012`) without inventing protocol details.
Add an explicit degradation note: unavailable or partial DAP support leaves process control and the runtime bridge usable.

- [ ] **Step 4: Extend traceability and run checks**

Append every new participant and `FLOW-RUN-*` row, then run:

```powershell
node --test tests/architecture/behavioral-views.test.mjs
node docs/architecture/render.mjs --check --only 06-runtime-debug-sequence
node docs/architecture/render.mjs --only 06-runtime-debug-sequence
```

- [ ] **Step 5: Inspect and commit**

Confirm setup, interaction, and cleanup are visually separable and that timeout/force-stop paths remain readable.

```powershell
git add docs/architecture/06-runtime-debug-sequence.md docs/architecture/traceability.md docs/architecture/rendered/06-runtime-debug-sequence.svg docs/architecture/rendered/manifest.json tests/architecture/behavioral-views.test.mjs
git commit -m "docs: document runtime and debug sequence"
```

---

### Task 8: Document the centralized policy pipeline

**Files:**
- Create: `docs/architecture/07-policy-pipeline.md`
- Modify: `docs/architecture/traceability.md`
- Modify: `tests/architecture/behavioral-views.test.mjs`

**Interfaces:**
- Consumes: Phase 7 registry middleware order and Phase 6/Phase 2 guard contracts.
- Produces: the normative call-control activity flow for all tools.

- [ ] **Step 1: Add a failing policy inventory test**

Require nodes:

```text
CNT-MCP-CLIENT
CMP-REGISTRY
CMP-MODE-GATE
CMP-PATH-GUARD
CMP-EXEC-GUARD
CMP-REQUEST-CLASSIFIER
CMP-READ-CACHE
CMP-REQUEST-QUEUE
CMP-HANDLER
CMP-CACHE-INVALIDATOR
CMP-AUDIT
SYS-STRUCTURED-RESULT
SYS-STRUCTURED-ERROR
```

Require `FLOW-POL-001..020`, safety modes `full`, `read_only`, and `confirm_destructive`, plus `blocked_by_policy`, `{code, message, hint}`, FIFO, TTL, tags, fairness, backpressure, watchdog, `Q-006`, `Q-007`, `Q-008`, and `Q-009`.

- [ ] **Step 2: Run the behavioral tests and verify the missing-view failure**

- [ ] **Step 3: Implement the activity-like pipeline**

Use `flowchart TD`. The flow order is mode/annotation gate, path guard, execution guard, read/mutation classification, cache or queue, handler, invalidation for mutation, audit, and structured result. Rejected calls branch to structured error and then use a dashed `[INFERRED]` flow to audit linked to `Q-007`.

Use one `FLOW-POL-*` ID for every visible edge:

```text
FLOW-POL-001  CNT-MCP-CLIENT -> CMP-REGISTRY : tool call
FLOW-POL-002  CMP-REGISTRY -> CMP-MODE-GATE : annotations and mode
FLOW-POL-003  CMP-MODE-GATE -> CMP-PATH-GUARD : allowed
FLOW-POL-004  CMP-PATH-GUARD -> CMP-EXEC-GUARD : path safe
FLOW-POL-005  CMP-MODE-GATE -> CMP-AUDIT : [INFERRED] blocked_by_policy (Q-007)
FLOW-POL-006  CMP-PATH-GUARD -> CMP-AUDIT : [INFERRED] blocked path (Q-007)
FLOW-POL-007  CMP-EXEC-GUARD -> CMP-AUDIT : [INFERRED] blocked execution (Q-006, Q-007)
FLOW-POL-008  CMP-AUDIT -> SYS-STRUCTURED-ERROR : rejected outcome
FLOW-POL-009  CMP-EXEC-GUARD -> CMP-REQUEST-CLASSIFIER : safe request
FLOW-POL-010  CMP-REQUEST-CLASSIFIER -> CMP-READ-CACHE : read-only
FLOW-POL-011  CMP-READ-CACHE -> CMP-AUDIT : cache hit
FLOW-POL-012  CMP-READ-CACHE -> CMP-HANDLER : cache miss
FLOW-POL-013  CMP-REQUEST-CLASSIFIER -> CMP-REQUEST-QUEUE : mutation
FLOW-POL-014  CMP-REQUEST-QUEUE -> CMP-HANDLER : FIFO dispatch
FLOW-POL-015  CMP-HANDLER -> CMP-CACHE-INVALIDATOR : mutation success
FLOW-POL-016  CMP-CACHE-INVALIDATOR -> CMP-AUDIT : affected tags invalidated
FLOW-POL-017  CMP-HANDLER -> CMP-AUDIT : read success
FLOW-POL-018  CMP-HANDLER -> CMP-AUDIT : stable mapped failure
FLOW-POL-019  CMP-AUDIT -> SYS-STRUCTURED-RESULT : successful outcome
FLOW-POL-020  SYS-STRUCTURED-RESULT -> CNT-MCP-CLIENT : structuredContent
```

The structured-error node's text lists `{code, message, hint}` and visually terminates the rejected branch. Successful cached, read, and mutation outcomes converge through audit before `structuredContent`.

In adjacent risk notes, state that the queue is not a rollback transaction and that concurrent reads may observe in-progress mutation state (`Q-008`).

- [ ] **Step 4: Extend traceability and run targeted checks**

```powershell
node --test tests/architecture/behavioral-views.test.mjs
node docs/architecture/render.mjs --check --only 07-policy-pipeline
node docs/architecture/render.mjs --only 07-policy-pipeline
```

- [ ] **Step 5: Inspect and commit**

Confirm that read and mutation branches are distinguishable without color and that all outcomes visibly converge on audit/result handling.

```powershell
git add docs/architecture/07-policy-pipeline.md docs/architecture/traceability.md docs/architecture/rendered/07-policy-pipeline.svg docs/architecture/rendered/manifest.json tests/architecture/behavioral-views.test.mjs
git commit -m "docs: document centralized policy pipeline"
```

---

### Task 9: Document transport and runtime lifecycles

**Files:**
- Create: `docs/architecture/08-connection-lifecycles.md`
- Modify: `docs/architecture/traceability.md`
- Modify: `tests/architecture/behavioral-views.test.mjs`

**Interfaces:**
- Consumes: Phase 1 connection states, Phase 4 LSP lifecycle, and inferred Phase 5 process/DAP lifecycles.
- Produces: four independently renderable state diagrams and four named SVG exports.

- [ ] **Step 1: Add failing state and export-map tests**

Require exactly four Mermaid blocks with these state IDs:

```text
STATE-WS-DISCONNECTED
STATE-WS-CONNECTING
STATE-WS-CONNECTED
STATE-WS-RECONNECTING

STATE-LSP-DISCONNECTED
STATE-LSP-TCP-CONNECTED
STATE-LSP-INITIALIZING
STATE-LSP-READY
STATE-LSP-DOCUMENT-SYNCED
STATE-LSP-RECONNECTING
STATE-LSP-SHUTTING-DOWN
STATE-LSP-EXITED

STATE-PROC-STOPPED
STATE-PROC-STARTING
STATE-PROC-RUNNING
STATE-PROC-STOPPING
STATE-PROC-EXITED
STATE-PROC-CRASHED
STATE-PROC-FORCE-STOPPING

STATE-DAP-DISCONNECTED
STATE-DAP-INITIALIZED
STATE-DAP-LAUNCHED-ATTACHED
STATE-DAP-RUNNING
STATE-DAP-PAUSED
STATE-DAP-TERMINATED
```

Require these exact transitions:

```text
FLOW-WS-001    [*] -> STATE-WS-DISCONNECTED
FLOW-WS-002    STATE-WS-DISCONNECTED -> STATE-WS-CONNECTING : start
FLOW-WS-003    STATE-WS-CONNECTING -> STATE-WS-CONNECTED : socket open
FLOW-WS-004    STATE-WS-CONNECTING -> STATE-WS-RECONNECTING : connection failure
FLOW-WS-005    STATE-WS-CONNECTED -> STATE-WS-RECONNECTING : close or missed heartbeat
FLOW-WS-006    STATE-WS-RECONNECTING -> STATE-WS-CONNECTING : backoff elapsed

FLOW-LSP-001   [*] -> STATE-LSP-DISCONNECTED
FLOW-LSP-002   STATE-LSP-DISCONNECTED -> STATE-LSP-TCP-CONNECTED : TCP connect
FLOW-LSP-003   STATE-LSP-TCP-CONNECTED -> STATE-LSP-INITIALIZING : initialize
FLOW-LSP-004   STATE-LSP-INITIALIZING -> STATE-LSP-READY : initialized
FLOW-LSP-005   STATE-LSP-READY -> STATE-LSP-DOCUMENT-SYNCED : didOpen
FLOW-LSP-006   STATE-LSP-DOCUMENT-SYNCED -> STATE-LSP-DOCUMENT-SYNCED : didChange
FLOW-LSP-007   STATE-LSP-READY -> STATE-LSP-RECONNECTING : connection drop
FLOW-LSP-008   STATE-LSP-DOCUMENT-SYNCED -> STATE-LSP-RECONNECTING : connection drop
FLOW-LSP-009   STATE-LSP-RECONNECTING -> STATE-LSP-TCP-CONNECTED : reconnect
FLOW-LSP-010   STATE-LSP-READY -> STATE-LSP-SHUTTING-DOWN : shutdown
FLOW-LSP-011   STATE-LSP-SHUTTING-DOWN -> STATE-LSP-EXITED : exit

FLOW-PROC-001  [*] -> STATE-PROC-STOPPED
FLOW-PROC-002  STATE-PROC-STOPPED -> STATE-PROC-STARTING : run
FLOW-PROC-003  STATE-PROC-STARTING -> STATE-PROC-RUNNING : process started
FLOW-PROC-004  STATE-PROC-STARTING -> STATE-PROC-CRASHED : launch failure
FLOW-PROC-005  STATE-PROC-RUNNING -> STATE-PROC-STOPPING : graceful stop
FLOW-PROC-006  STATE-PROC-STOPPING -> STATE-PROC-STOPPED : clean exit
FLOW-PROC-007  STATE-PROC-STOPPING -> STATE-PROC-FORCE-STOPPING : timeout
FLOW-PROC-008  STATE-PROC-FORCE-STOPPING -> STATE-PROC-STOPPED : killed and cleaned
FLOW-PROC-009  STATE-PROC-RUNNING -> STATE-PROC-EXITED : process exit
FLOW-PROC-010  STATE-PROC-RUNNING -> STATE-PROC-CRASHED : abnormal exit

FLOW-DAP-001   [*] -> STATE-DAP-DISCONNECTED
FLOW-DAP-002   STATE-DAP-DISCONNECTED -> STATE-DAP-INITIALIZED : initialize
FLOW-DAP-003   STATE-DAP-INITIALIZED -> STATE-DAP-LAUNCHED-ATTACHED : launch or attach
FLOW-DAP-004   STATE-DAP-LAUNCHED-ATTACHED -> STATE-DAP-RUNNING : continue
FLOW-DAP-005   STATE-DAP-RUNNING -> STATE-DAP-PAUSED : breakpoint or pause
FLOW-DAP-006   STATE-DAP-PAUSED -> STATE-DAP-RUNNING : continue
FLOW-DAP-007   STATE-DAP-PAUSED -> STATE-DAP-PAUSED : step
FLOW-DAP-008   STATE-DAP-RUNNING -> STATE-DAP-TERMINATED : terminate
FLOW-DAP-009   STATE-DAP-PAUSED -> STATE-DAP-TERMINATED : terminate
```

Require `[INFERRED]` on LSP, process, and DAP transitions whose state structure is derived from explicit operations rather than declared directly as a state machine. Require `Q-003` beside the WebSocket heartbeat transition to show that missed-heartbeat behavior is explicit while heartbeat transport is unresolved.

- [ ] **Step 2: Run the behavioral tests and observe the missing-view failure**

- [ ] **Step 3: Implement four focused `stateDiagram-v2` blocks**

WebSocket transitions cover start, connect, heartbeat/close drop, exponential backoff, and recovery. LSP covers TCP connect, initialize/initialized, ready, didOpen/didChange synchronization, drop/reconnect, shutdown, and exit. Process covers start, running, graceful stop, forced stop, exit, and crash. DAP covers initialize, launch/attach, run, pause, step/continue, and terminate.

Prefix inferred LSP, process, and DAP transitions with `[INFERRED]`. Use transition labels, not line style, for evidence semantics. Put each diagram's source status and operational invariant in the prose immediately below it.

- [ ] **Step 4: Add all state and transition traceability rows**

For inferred lifecycle states, cite the source operations from which the state model is derived and set Evidence to `Inferred`. Do not present inferred states as direct source declarations.

- [ ] **Step 5: Test and render the four blocks**

```powershell
node --test tests/architecture/behavioral-views.test.mjs
node docs/architecture/render.mjs --check --only 08-connection-lifecycles
node docs/architecture/render.mjs --only 08-connection-lifecycles
```

Expected exports: `08a-editor-websocket-lifecycle.svg`, `08b-lsp-lifecycle.svg`, `08c-game-process-lifecycle.svg`, and `08d-dap-lifecycle.svg`.

- [ ] **Step 6: Inspect and commit**

Inspect all four SVGs. Confirm state names fit, transition text is not hidden under states, and recovery/termination paths are obvious.

```powershell
git add docs/architecture/08-connection-lifecycles.md docs/architecture/traceability.md docs/architecture/rendered/08a-editor-websocket-lifecycle.svg docs/architecture/rendered/08b-lsp-lifecycle.svg docs/architecture/rendered/08c-game-process-lifecycle.svg docs/architecture/rendered/08d-dap-lifecycle.svg docs/architecture/rendered/manifest.json tests/architecture/behavioral-views.test.mjs
git commit -m "docs: document connection lifecycles"
```

---

### Task 10: Complete navigation, provenance, and atlas acceptance

**Files:**
- Create: `docs/architecture/README.md`
- Create: `tests/architecture/atlas-acceptance.test.mjs`
- Modify: `docs/architecture/traceability.md`
- Modify: `docs/architecture/rendered/manifest.json`
- Modify: generated `docs/architecture/rendered/*.svg` files as required by final rendering

**Interfaces:**
- Consumes: every canonical view, open-question entry, traceability row, render helper, and approved acceptance criterion.
- Produces: the complete navigable atlas, full provenance, and final verification evidence.

- [ ] **Step 1: Write failing end-to-end acceptance tests**

Create tests that assert:

1. README contains the archive filename/hash, renderer/version, evidence legend, five capability channels, reading order, regeneration command, and links to all ten Markdown documents.
2. SHA-256 of `C:\Users\dasbl\Downloads\files.zip` equals the pinned source hash.
3. Every Markdown link under `docs/architecture/` resolves.
4. Every Mermaid block contains `accTitle` and `accDescr`.
5. Full `collectAtlasIds()` equals `parseTraceabilityIds()` with no missing, stale, or duplicate traceability IDs.
6. Every inferred/unresolved flow contains the required textual marker and a `Q-*` link when a stable question exists.
7. Exactly eleven SVGs exist and none is zero bytes.
8. Every numbered view contains the source archive hash, and the manifest has eleven entries, one per SVG, with source, block ordinal, archive hash, generation date, and renderer `@mermaid-js/mermaid-cli@11.16.0`.
9. The repository contains no committed `.render-tmp` directory or `.mmd` extraction file.

- [ ] **Step 2: Run the acceptance test and verify the expected failure**

Run `node --test tests/architecture/atlas-acceptance.test.mjs`.

Expected: FAIL because README is absent and the manifest is partial.

- [ ] **Step 3: Write the atlas README**

Use this section order:

```text
Purpose and audience
Source baseline and archive hash
Key architecture conclusion
Reading order
Diagram index
Evidence and ID legend
Five capability channels
How to use the atlas during each phase
Rendering and regeneration
Accessibility and text alternatives
Known open questions
Verification commands
```

State that native Markdown/Mermaid is canonical and SVG is generated. Document:

```powershell
node docs/architecture/render.mjs --check
node docs/architecture/render.mjs
node --test tests/architecture/*.test.mjs
```

- [ ] **Step 4: Audit and complete traceability**

Run a local comparison using the helper functions. For each missing ID, add the exact row with source heading and phase ownership. For each stale ID, either restore the matching diagram anchor or remove the obsolete row after confirming it no longer represents a modeled element. Do not silence the validator or weaken the ID pattern.

- [ ] **Step 5: Render the complete atlas**

Run:

```powershell
node docs/architecture/render.mjs --check
node docs/architecture/render.mjs
```

Expected: `Atlas validation passed`, then `Atlas render passed`; eleven SVG files and a complete manifest are present.

- [ ] **Step 6: Perform visual and accessibility inspection**

Open all eleven SVGs in the local image viewer. Check:

- no clipped node, state, actor, group, or edge label;
- no connector under text or through a group title;
- obvious reading order and low crossing count;
- readable grayscale appearance;
- inferred and unresolved meaning remains visible without color;
- the primary context is visible without shrinking text below reading size; and
- each diagram's prose/outline conveys the same conclusion without relying on the image.

If a structural view is too dense, split its content into focused facets inside the same Markdown file and update `EXPORT_MAP`, tests, and manifest expectations together. Do not introduce another diagram language.

- [ ] **Step 7: Run the complete verification suite**

```powershell
node --test tests/architecture/*.test.mjs
node docs/architecture/render.mjs --check
git diff --check
git status --short
```

Expected: all tests pass, validation passes, whitespace check is clean, and status lists only the intended atlas files.

- [ ] **Step 8: Commit the completed atlas**

```powershell
git add docs/architecture tests/architecture
git commit -m "docs: complete Godot MCP architecture atlas"
```

Expected: the commit contains README, final traceability, eleven SVGs, complete manifest, acceptance test, and any layout-only corrections required by visual inspection.

---

## Final Acceptance Checklist

- [ ] The five source-defined capability channels are distinct in the primary view.
- [ ] Every major element names its owning phase and source section.
- [ ] Tier A mutation, runtime/debug, policy, and lifecycle behavior are independently understandable.
- [ ] Explicit, inferred, and unresolved evidence is textually distinguishable in every diagram family.
- [ ] Diagram IDs and traceability IDs match bidirectionally.
- [ ] All Mermaid blocks parse with CLI 11.16.0.
- [ ] Eleven SVGs render and pass visual inspection.
- [ ] Manifest provenance covers every SVG.
- [ ] Every diagram has a prose summary and structured outline.
- [ ] The package adds no Godot MCP implementation code or unsupported capability claim.
