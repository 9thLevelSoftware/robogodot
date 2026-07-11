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

export function buildNpxInvocation(platform = process.platform) {
  return platform === "win32"
    ? { executable: "cmd.exe", argsPrefix: ["/d", "/s", "/c", "npx.cmd"] }
    : { executable: "npx", argsPrefix: [] };
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
      const { executable, argsPrefix } = buildNpxInvocation();
      const result = spawnSync(executable, [
        ...argsPrefix,
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
