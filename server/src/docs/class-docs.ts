import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { GodotMcpError } from "../errors.js";

export const DOC_SOURCE = {
  engineVersion: "4.6.2",
  sourceCommit: "001aa128b1cd80dc4e47e823c360bccf45ed6bad",
  sourceArchiveSha256: "908b759e7517fec65d687b3d468cd639fd8967d25da1522ef8a2087af638b3fe",
  generatorVersion: 1,
} as const;
export const DOC_SOURCE_URL = "https://codeload.github.com/godotengine/godot/tar.gz/refs/tags/4.6.2-stable";
const MAX_DOC_BYTES = 64 * 1024;
const MEMBER_KINDS = ["method", "property", "signal", "constant", "enum"] as const;
export type MemberKind = typeof MEMBER_KINDS[number];
export interface DocsProvenance { engineVersion: string; sourceCommit: string; sourceArchiveSha256: string; generatorVersion: number; generatorSha256: string }
export interface DocsManifest extends DocsProvenance { classCount: number; memberCount: number; contentSha256: string }
export interface ClassEntry { brief: string; description: string; members: Record<string, string> }
export interface DocsIndex { manifest: DocsManifest; classes: Record<string, ClassEntry> }
export interface VersionClient { call<T>(method: string, params?: unknown): Promise<T> }
export interface ClassDocParams { class: string; member?: { kind: MemberKind; name: string } }

function decodeXml(value: string): string {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_all, code: string) => String.fromCodePoint(code[0]?.toLowerCase() === "x" ? Number.parseInt(code.slice(1), 16) : Number(code)));
}

function normalize(value: string | undefined): string {
  return decodeXml(value ?? "").replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function tag(body: string, name: string): string {
  return normalize(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`).exec(body)?.[1]);
}

function members(body: string, container: string, element: string, kind: MemberKind): Array<[string, string]> {
  const section = new RegExp(`<${container}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${container}>`).exec(body)?.[1] ?? "";
  const result: Array<[string, string]> = [];
  const expression = new RegExp(`<${element}\\s+[^>]*name="([^"]+)"[^>]*>([\\s\\S]*?)<\\/${element}>`, "g");
  for (const match of section.matchAll(expression)) {
    const name = decodeXml(match[1] ?? "");
    const description = element === "member" || element === "constant" ? normalize(match[2]) : tag(match[2] ?? "", "description");
    const key = `${kind}:${name}`;
    const existing = result.find(([candidate]) => candidate === key);
    if (existing) {
      if (description && !existing[1].includes(description)) existing[1] = normalize(`${existing[1]}\n\n${description}`);
    } else result.push([key, description]);
  }
  return result;
}

function contentHash(classes: Record<string, ClassEntry>): string {
  return createHash("sha256").update(JSON.stringify(classes)).digest("hex");
}

export function buildDocsIndex(files: Array<{ path: string; xml: string }>, provenance: DocsProvenance): DocsIndex {
  const classes: Record<string, ClassEntry> = {};
  let memberCount = 0;
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path, "en"))) {
    const classMatch = /<class\s+[^>]*name="([^"]+)"[^>]*>([\s\S]*)<\/class>/.exec(file.xml);
    if (!classMatch) throw new Error(`No <class name> found in ${file.path}`);
    const name = decodeXml(classMatch[1] ?? "");
    const body = classMatch[2] ?? "";
    const entries = [
      ...members(body, "methods", "method", "method"), ...members(body, "members", "member", "property"),
      ...members(body, "signals", "signal", "signal"), ...members(body, "constants", "constant", "constant"),
      ...members(body, "enums", "enum", "enum"),
    ].sort(([a], [b]) => a.localeCompare(b, "en"));
    classes[name] = { brief: tag(body, "brief_description"), description: tag(body, "description"), members: Object.fromEntries(entries) };
    memberCount += entries.length;
  }
  const sortedClasses = Object.fromEntries(Object.entries(classes).sort(([a], [b]) => a.localeCompare(b, "en")));
  return { manifest: { ...provenance, classCount: Object.keys(sortedClasses).length, memberCount, contentSha256: contentHash(sortedClasses) }, classes: sortedClasses };
}

export function verifyDocsManifest(index: DocsIndex): boolean {
  return index.manifest.classCount === Object.keys(index.classes).length
    && index.manifest.memberCount === Object.values(index.classes).reduce((sum, value) => sum + Object.keys(value.members).length, 0)
    && index.manifest.contentSha256 === contentHash(index.classes);
}

export async function loadBundledDocsIndex(): Promise<DocsIndex> {
  const path = new URL("../../assets/godot-4.6.2-class-docs.json", import.meta.url);
  const parsed = JSON.parse(await readFile(path, "utf8")) as DocsIndex;
  if (!verifyDocsManifest(parsed)) throw new GodotMcpError("feature_disabled", "Bundled Godot documentation failed its integrity check.", "Regenerate the pinned documentation index with npm run docs:generate.");
  return parsed;
}

function bounded(value: string): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= MAX_DOC_BYTES) return value;
  return bytes.subarray(0, MAX_DOC_BYTES).toString("utf8").replace(/\uFFFD$/, "");
}

export async function classDoc(client: VersionClient, index: DocsIndex, params: ClassDocParams) {
  const version = await client.call<{ engine?: { major?: number; minor?: number; patch?: number } }>("core.get_version");
  const engine = version.engine;
  if (engine?.major !== 4 || engine.minor !== 6) throw new GodotMcpError("feature_disabled", `Bundled class docs support Godot 4.6.x; connected engine is ${engine?.major ?? "?"}.${engine?.minor ?? "?"}.${engine?.patch ?? "?"}.`, "Use a Godot 4.6.x editor or install a documentation index matching the connected engine.");
  if (typeof params.class !== "string" || !params.class || !index.classes[params.class]) throw new GodotMcpError("invalid_args", `Unknown documented class '${String(params.class)}'.`, "Call godot_api_list_classes and pass an exact class name.");
  const entry = index.classes[params.class]!;
  const result: { class: string; engineVersion: string; brief: string; description: string; member?: { kind: MemberKind; name: string; description: string } } = {
    class: params.class, engineVersion: index.manifest.engineVersion, brief: bounded(entry.brief), description: bounded(entry.description),
  };
  if (params.member) {
    if (!MEMBER_KINDS.includes(params.member.kind) || !params.member.name) throw new GodotMcpError("invalid_args", "Invalid documentation member selector.", "Use kind method, property, signal, constant, or enum with an exact member name.");
    const description = entry.members[`${params.member.kind}:${params.member.name}`];
    if (description === undefined) throw new GodotMcpError("invalid_args", `Unknown ${params.member.kind} '${params.member.name}' on '${params.class}'.`, "Call godot_api_describe_class and pass an exact member name and kind.");
    result.member = { ...params.member, description: bounded(description) };
  }
  return result;
}
