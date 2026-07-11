import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildDocsIndex, DOC_SOURCE, DOC_SOURCE_URL, verifyDocsManifest } from "../dist/docs/class-docs.js";
import { validateArchiveEntries } from "../dist/docs/archive-policy.js";

const exec = promisify(execFile);
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(serverRoot, "assets/godot-4.6.2-class-docs.json");
const check = process.argv.includes("--check");
const archiveArgument = process.argv.find((value) => value.startsWith("--archive="));
const compositeInputs = [
  fileURLToPath(import.meta.url), resolve(serverRoot, "src/docs/class-docs.ts"),
  resolve(serverRoot, "docs-generator-config.json"), resolve(serverRoot, "package-lock.json"),
];
const composite = createHash("sha256");
for (const path of compositeInputs) composite.update(relative(serverRoot, path).replaceAll("\\", "/")).update("\0").update(await readFile(path)).update("\0");
const generatorSha256 = composite.digest("hex");
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

async function walkAll(directory, root = directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walkAll(path, root));
    else if (entry.isFile()) result.push({ path: relative(root, path).replaceAll("\\", "/"), size: (await stat(path)).size });
  }
  return result;
}

try {
  if (check && !archiveArgument) {
    const existing = JSON.parse(await readFile(output, "utf8"));
    if (!verifyDocsManifest(existing) || existing.manifest.generatorSha256 !== generatorSha256) throw new Error("Bundled documentation provenance or composite generator hash is stale");
    process.stderr.write(`verified offline ${existing.manifest.classCount} classes, ${existing.manifest.memberCount} members, ${(await stat(output)).size} bytes\n`);
    process.exitCode = 0;
  } else {
  const archive = archiveArgument ? resolve(archiveArgument.slice("--archive=".length)) : join(workspace, "godot-4.6.2-stable.tar.gz");
  if (!archiveArgument) {
    const response = await fetch(DOC_SOURCE_URL);
    if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
  }
  const archiveBytes = await readFile(archive);
  const actualHash = createHash("sha256").update(archiveBytes).digest("hex");
  if (actualHash !== DOC_SOURCE.sourceArchiveSha256) throw new Error(`Archive SHA-256 mismatch: expected ${DOC_SOURCE.sourceArchiveSha256}, got ${actualHash}`);
  const { stdout: archiveList } = await exec("tar", ["-tzf", archive], { maxBuffer: 16 * 1024 * 1024 });
  const listedEntries = archiveList.split(/\r?\n/).filter(Boolean).map((path) => ({ path, size: 0 }));
  validateArchiveEntries(listedEntries);
  await exec("tar", ["-xzf", archive, "-C", workspace]);
  const topLevel = (await readdir(workspace, { withFileTypes: true })).find((entry) => entry.isDirectory() && entry.name.startsWith("godot-"));
  if (!topLevel) throw new Error("Pinned archive did not contain the expected source directory");
  const root = join(workspace, topLevel.name);
  validateArchiveEntries(await walkAll(root));
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
  }
} finally {
  await rm(workspace, { recursive: true, force: true });
}
