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
export const VIEW_ID_CONTRACTS = Object.freeze({
  "01-system-context.md": Object.freeze([
    "ACT-ENGINEER-AI",
    "SYS-GODOT-CONTROL-MCP",
    "SYS-GODOT-EDITOR-PROJECT",
    "SYS-RUNNING-GAME",
    "SYS-PROJECT-FILES",
    "SYS-ASSET-PROVIDER",
    "FLOW-CTX-001",
    "FLOW-CTX-002",
    "FLOW-CTX-003",
    "FLOW-CTX-004",
    "FLOW-CTX-005",
    "FLOW-CTX-006",
  ]),
  "02-container-channels.md": Object.freeze([
    "CNT-MCP-CLIENT",
    "CNT-TYPESCRIPT-SERVER",
    "CH-EDITOR-MUTATION",
    "CH-INTROSPECTION",
    "CH-CODE-INTELLIGENCE",
    "CH-RUNTIME-DEBUG",
    "CH-HEADLESS-BATCH-FS",
    "CNT-EDITOR-PLUGIN",
    "SYS-CLASSDB-DOCS",
    "CNT-GODOT-LSP",
    "CNT-GODOT-DAP",
    "CNT-RUNNING-GAME",
    "CNT-RUNTIME-AUTOLOADS",
    "CNT-HEADLESS-GODOT",
    "CNT-PROJECT-STORAGE",
    "CNT-ASSET-PROVIDER",
    "FLOW-CH-001",
    "FLOW-CH-002",
    "FLOW-CH-003",
    "FLOW-CH-004",
    "FLOW-CH-005",
    "FLOW-CH-006",
    "FLOW-CH-007",
    "FLOW-CH-008",
    "FLOW-CH-009",
    "FLOW-CH-010",
    "FLOW-CH-011",
    "FLOW-CH-012",
  ]),
  "03-phase-dependencies.md": Object.freeze([
    "PHASE-00-RESEARCH",
    "PHASE-00-MASTER",
    "PHASE-01",
    "PHASE-02",
    "PHASE-03",
    "PHASE-04",
    "PHASE-05",
    "PHASE-06",
    "PHASE-07",
    "PHASE-08",
    "FLOW-PH-001",
    "FLOW-PH-002",
    "FLOW-PH-003",
    "FLOW-PH-004",
    "FLOW-PH-005",
    "FLOW-PH-006",
    "FLOW-PH-007",
    "FLOW-PH-008",
    "FLOW-PH-009",
    "FLOW-PH-010",
    "FLOW-PH-011",
    "FLOW-PH-012",
    "FLOW-PH-013",
    "FLOW-PH-014",
    "FLOW-PH-015",
    "FLOW-PH-016",
    "FLOW-PH-017",
    "FLOW-PH-018",
  ]),
});

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ID_PATTERN = /\b(?:ACT|SYS|CNT|CMP|CH|PHASE|STATE|FLOW)-[A-Z0-9-]+\b/g;
const TRACEABILITY_HEADER = "| ID | Name | View | Evidence | Source | Phase owner | Consumes | Produces | Consequence |";
const TRACEABILITY_DIVIDER = "|---|---|---|---|---|---|---|---|---|";
const ATLAS_ANCHOR_PATTERN = /^\s*%% atlas-(node|flow): ((?:ACT|SYS|CNT|CMP|CH|PHASE|STATE|FLOW)-[A-Z0-9-]+)\s*$/;

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

export function validateTraceability(markdown) {
  const lines = markdown.split(/\r?\n/);
  const headerIndexes = lines
    .map((line, index) => line === TRACEABILITY_HEADER ? index : -1)
    .filter((index) => index >= 0);
  if (headerIndexes.length !== 1) {
    throw new Error(`Traceability must contain the exact traceability header once: ${TRACEABILITY_HEADER}`);
  }
  if (lines[headerIndexes[0] + 1] !== TRACEABILITY_DIVIDER) {
    throw new Error(`Traceability must use the exact divider: ${TRACEABILITY_DIVIDER}`);
  }

  const occurrences = [];
  for (const line of lines) {
    const match = line.match(/^\|\s*`((?:ACT|SYS|CNT|CMP|CH|PHASE|STATE|FLOW)-[A-Z0-9-]+)`\s*\|/);
    if (match) occurrences.push(match[1]);
  }
  const duplicates = [...new Set(occurrences.filter((id, index) => occurrences.indexOf(id) !== index))].sort();
  if (duplicates.length) throw new Error(`Duplicate traceability IDs: ${duplicates.join(", ")}`);
  return new Set(occurrences);
}

function parseAtlasAnchor(line) {
  const match = line.match(ATLAS_ANCHOR_PATTERN);
  return match ? { kind: match[1], id: match[2] } : null;
}

function stripMermaidEdgeLabels(line) {
  return line
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/\|[^|]*\|/g, "");
}

function parseFlowchartEdge(line) {
  const sanitized = stripMermaidEdgeLabels(line);
  const arrows = [...sanitized.matchAll(/<-->|<---|-\.->|==>|-->|---|-\.-|===|~~~|--o|--x|o--o|x--x/g)];
  if (arrows.length === 0) return null;

  const expands = sanitized.includes("&");
  const edgeCount = arrows.length === 1 && !expands ? 1 : Math.max(2, arrows.length);
  const endpoints = [];
  if (arrows.length === 1) {
    const arrow = arrows[0];
    const leftIds = sanitized.slice(0, arrow.index).match(/[A-Za-z_][A-Za-z0-9_-]*/g) ?? [];
    const rightIds = sanitized.slice(arrow.index + arrow[0].length).match(/[A-Za-z_][A-Za-z0-9_-]*/g) ?? [];
    if (leftIds.length) endpoints.push(leftIds.at(-1));
    if (rightIds.length) endpoints.push(rightIds[0]);
  }
  return { edgeCount, endpoints };
}

function parseFlowchartNode(line) {
  if (parseFlowchartEdge(line)) return null;
  const trimmed = line.trim();
  if (!trimmed || trimmed === "end") return null;
  const shaped = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*(?:@\{|\[|\(|\{|>)/);
  if (shaped) return shaped[1];
  const bare = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*)(?:::[A-Za-z_][A-Za-z0-9_-]*)?$/);
  return bare?.[1] ?? null;
}

export function validateMermaidAnchors(block, context = "Mermaid block") {
  const lines = block.split(/\r?\n/);
  const isFlowchart = lines.some((line) => /^\s*(?:flowchart|graph)\s+/.test(line));
  const anchors = [];
  const seenAnchors = new Set();

  for (const [index, line] of lines.entries()) {
    const anchor = parseAtlasAnchor(line);
    if (!anchor) continue;
    if (seenAnchors.has(anchor.id)) throw new Error(`${context}: Duplicate atlas anchor: ${anchor.id}`);
    if (anchor.kind === "flow" && !anchor.id.startsWith("FLOW-")) {
      throw new Error(`${context} line ${index + 1}: atlas-flow anchor must use a FLOW-* ID`);
    }
    if (anchor.kind === "node" && anchor.id.startsWith("FLOW-")) {
      throw new Error(`${context} line ${index + 1}: atlas-node anchor cannot use a FLOW-* ID`);
    }
    seenAnchors.add(anchor.id);
    anchors.push({ ...anchor, index });
  }

  if (!isFlowchart) return new Set(anchors.map(({ id }) => id));

  const declaredNodes = new Map();
  const edges = [];
  for (const [index, line] of lines.entries()) {
    const node = parseFlowchartNode(line);
    if (node) {
      const anchor = parseAtlasAnchor(lines[index - 1] ?? "");
      if (!anchor || anchor.kind !== "node") {
        throw new Error(
          `${context} line ${index + 1}: ${node} missing immediately preceding atlas-node anchor; atlas-node must immediately precede every flowchart node`,
        );
      }
      declaredNodes.set(node, anchor.id);
    }

    const edge = parseFlowchartEdge(line);
    if (edge) {
      const anchor = parseAtlasAnchor(lines[index - 1] ?? "");
      if (!anchor || anchor.kind !== "flow") {
        throw new Error(
          `${context} line ${index + 1}: edge missing immediately preceding atlas-flow anchor; atlas-flow must immediately precede every flowchart edge`,
        );
      }
      if (edge.edgeCount !== 1) {
        throw new Error(`${context} line ${index + 1}: ${anchor.id} must map to exactly one Mermaid edge`);
      }
      edges.push({ ...edge, anchor });
    }
  }

  for (const { kind, id, index } of anchors) {
    const next = lines[index + 1] ?? "";
    if (kind === "node" && !parseFlowchartNode(next)) {
      throw new Error(`${context} line ${index + 1}: atlas-node ${id} must immediately precede a flowchart node`);
    }
    if (kind === "flow" && !parseFlowchartEdge(next)) {
      throw new Error(`${context} line ${index + 1}: atlas-flow ${id} must immediately precede a flowchart edge`);
    }
  }

  for (const { endpoints } of edges) {
    for (const endpoint of endpoints) {
      if (!declaredNodes.has(endpoint)) {
        throw new Error(`${context}: ${endpoint} must have an anchored node declaration`);
      }
    }
  }

  const unanchoredIds = [...collectAtlasIds([block])].filter((id) => !seenAnchors.has(id)).sort();
  if (unanchoredIds.length) throw new Error(`${context}: Unanchored atlas IDs: ${unanchoredIds.join(", ")}`);
  return new Set(anchors.map(({ id }) => id));
}

export function diffTraceability(diagramIds, traceabilityIds) {
  return {
    missing: [...diagramIds].filter((id) => !traceabilityIds.has(id)).sort(),
    stale: [...traceabilityIds].filter((id) => !diagramIds.has(id)).sort(),
  };
}

export function validateViewIdContract(source, actualIds, contracts = VIEW_ID_CONTRACTS) {
  const configured = contracts[source];
  if (!configured) return { missing: [], extra: [] };
  const expected = new Set(configured);
  if (expected.size !== configured.length) throw new Error(`${source} ID contract contains duplicate IDs`);
  const actual = actualIds instanceof Set ? actualIds : new Set(actualIds);
  const diff = {
    missing: [...expected].filter((id) => !actual.has(id)).sort(),
    extra: [...actual].filter((id) => !expected.has(id)).sort(),
  };
  if (diff.missing.length || diff.extra.length) {
    throw new Error(`${source} ID contract mismatch: ${JSON.stringify(diff)}`);
  }
  return diff;
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

export function buildNpxInvocation(platform = process.platform, execPath = process.execPath) {
  return platform === "win32"
    ? {
        executable: execPath,
        argsPrefix: [path.win32.join(path.win32.dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js")],
      }
    : { executable: "npx", argsPrefix: [] };
}

function parseArgs(argv) {
  const onlyIndex = argv.indexOf("--only");
  return {
    check: argv.includes("--check"),
    only: onlyIndex >= 0 ? new Set(argv[onlyIndex + 1].split(",")) : null,
  };
}

export async function renderAtlas({
  check = false,
  only = null,
  root = ROOT,
  spawn = spawnSync,
  platform = process.platform,
  execPath = process.execPath,
  viewIdContracts = VIEW_ID_CONTRACTS,
} = {}) {
  const selected = Object.entries(EXPORT_MAP).filter(([source]) => !only || only.has(source.replace(/\.md$/, "")));
  if (selected.length === 0) throw new Error("No atlas views selected");

  const renderedDir = path.join(root, "rendered");
  const tempDir = path.join(root, ".render-tmp");
  const traceability = validateTraceability(await readFile(path.join(root, "traceability.md"), "utf8"));
  const diagramIds = new Set();
  const jobs = [];

  for (const [source, outputs] of selected) {
    const markdown = await readFile(path.join(root, source), "utf8");
    const blocks = extractMermaidBlocks(markdown);
    if (blocks.length !== outputs.length) {
      throw new Error(`${source}: expected ${outputs.length} Mermaid block(s), found ${blocks.length}`);
    }
    const sourceIds = new Set();
    blocks.forEach((block, index) => {
      if (!block.includes("accTitle:") || !block.includes("accDescr:")) {
        throw new Error(`${source} block ${index + 1}: missing accTitle or accDescr`);
      }
      validateMermaidAnchors(block, `${source} block ${index + 1}`).forEach((id) => {
        diagramIds.add(id);
        sourceIds.add(id);
      });
      jobs.push({ source, block: index + 1, definition: block, output: outputs[index] });
    });
    validateViewIdContract(source, sourceIds, viewIdContracts);
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
      const { executable, argsPrefix } = buildNpxInvocation(platform, execPath);
      const result = spawn(executable, [
        ...argsPrefix,
        "--yes",
        `@mermaid-js/mermaid-cli@${CLI_VERSION}`,
        "-i", input,
        "-o", output,
        "-c", path.join(root, "mermaid-config.json"),
        "-t", "neutral",
        "-b", "white",
      ], { encoding: "utf8" });
      if (result.error) {
        const detail = result.error.code ? `${result.error.code}: ${result.error.message}` : result.error.message;
        throw new Error(`${job.output}: renderer launch failed: ${detail}`, { cause: result.error });
      }
      if (result.status !== 0) {
        throw new Error(`${job.output}: ${result.stderr || result.stdout || `renderer exited with status ${result.status}`}`);
      }
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
