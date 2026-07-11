import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildDocsIndex, DOC_SOURCE, DOC_SOURCE_URL } from "../dist/docs/class-docs.js";

const exec = promisify(execFile);
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(serverRoot, "assets/godot-4.6.2-class-docs.json");
const check = process.argv.includes("--check");
const archiveArgument = process.argv.find((value) => value.startsWith("--archive="));
const generatorBytes = await readFile(fileURLToPath(import.meta.url));
const generatorSha256 = createHash("sha256").update(generatorBytes).digest("hex");
const workspace = await mkdtemp(join(tmpdir(), "godot-docs-"));

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else if (entry.isFile() && entry.name.endsWith(".xml") && (path.includes(`${join("doc", "classes")}`) || path.includes("doc_classes"))) result.push(path);
  }
  return result;
}

try {
  const archive = archiveArgument ? resolve(archiveArgument.slice("--archive=".length)) : join(workspace, "godot-4.6.2-stable.tar.gz");
  if (!archiveArgument) {
    const response = await fetch(DOC_SOURCE_URL);
    if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
  }
  const archiveBytes = await readFile(archive);
  const actualHash = createHash("sha256").update(archiveBytes).digest("hex");
  if (actualHash !== DOC_SOURCE.sourceArchiveSha256) throw new Error(`Archive SHA-256 mismatch: expected ${DOC_SOURCE.sourceArchiveSha256}, got ${actualHash}`);
  const extracted = join(workspace, "source");
  await exec("tar", ["-xzf", archive, "-C", workspace]);
  const topLevel = (await readdir(workspace, { withFileTypes: true })).find((entry) => entry.isDirectory() && entry.name.startsWith("godot-4.6.2-stable"));
  if (!topLevel) throw new Error("Pinned archive did not contain the expected source directory");
  const root = join(workspace, topLevel.name);
  const paths = (await walk(root)).sort();
  const files = await Promise.all(paths.map(async (path) => ({ path: relative(root, path).replaceAll("\\", "/"), xml: await readFile(path, "utf8") })));
  const index = buildDocsIndex(files, { ...DOC_SOURCE, generatorSha256 });
  const bytes = `${JSON.stringify(index)}\n`;
  if (check) {
    const existing = await readFile(output, "utf8");
    if (existing !== bytes) throw new Error("Generated documentation index is stale; run npm run docs:generate");
  } else {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, bytes);
  }
  const size = (await stat(output)).size;
  process.stderr.write(`${check ? "verified" : "generated"} ${index.manifest.classCount} classes, ${index.manifest.memberCount} members, ${size} bytes\n`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}
