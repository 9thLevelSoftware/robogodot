import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { GodotMcpError } from "../errors.js";
import { DOC_EXPECTED } from "./docs-expected.js";

export const DOC_SOURCE = {
  engineVersion: "4.6.2",
  sourceCommit: "001aa128b1cd80dc4e47e823c360bccf45ed6bad",
  sourceArchiveSha256: "146a0af84fa4b11670ee5574d98d0a508f047db626407909121b38984531f3d1",
  generatorVersion: 2,
} as const;
export const DOC_SOURCE_URL = `https://codeload.github.com/godotengine/godot/tar.gz/${DOC_SOURCE.sourceCommit}`;
const MAX_RESPONSE_BYTES = 65_536;
const MEMBER_KINDS = ["method", "property", "signal", "constant", "enum"] as const;
export type MemberKind = typeof MEMBER_KINDS[number];
export interface DocsProvenance { engineVersion: string; sourceCommit: string; sourceArchiveSha256: string; generatorVersion: number; generatorSha256: string }
export interface DocsManifest extends DocsProvenance { classCount: number; memberCount: number; contentSha256: string }
export interface OverloadDoc { signature: string; description: string }
export interface MemberDoc { description: string; overloads?: OverloadDoc[]; values?: string[]; valueDescriptions?: Record<string, string> }
export interface ClassEntry { brief: string; description: string; members: Record<string, MemberDoc> }
export interface DocsIndex { manifest: DocsManifest; classes: Record<string, ClassEntry> }
export interface VersionClient { call<T>(method: string, params?: unknown): Promise<T> }
export interface ClassDocParams { class: string; member?: { kind: MemberKind; name: string } }

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", trimValues: false,
  parseTagValue: false, parseAttributeValue: false, processEntities: false, ignoreDeclaration: true,
  transformTagName: (name) => ["constructor", "prototype", "__proto__"].includes(name) ? `__reserved_${name}` : name,
  isArray: (name) => ["method", "member", "signal", "constant", "param"].includes(name),
});

function decodeXml(value: string): string {
  return value.replace(/&([^;\s]+);/g, (_all, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error(`Invalid numeric XML entity '&${entity};'`);
      return String.fromCodePoint(code);
    }
    const predefined = ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" } as Record<string, string>)[entity.toLowerCase()];
    if (predefined === undefined) throw new Error(`Unsupported XML entity '&${entity};'`);
    return predefined;
  });
}

function text(value: unknown): string {
  const raw = typeof value === "string" ? value : value && typeof value === "object" && "#text" in value ? String((value as Record<string, unknown>)["#text"] ?? "") : "";
  return decodeXml(raw).replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function array(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value as Array<Record<string, unknown>> : value && typeof value === "object" ? [value as Record<string, unknown>] : [];
}

function parseClass(file: { path: string; xml: string }): [string, ClassEntry] {
  if (/<!DOCTYPE|<!ENTITY/i.test(file.xml)) throw new Error(`DTD/entities are forbidden in ${file.path}`);
  const valid = XMLValidator.validate(file.xml, { allowBooleanAttributes: false });
  if (valid !== true) throw new Error(`Invalid XML in ${file.path}: ${valid.err.msg}`);
  decodeXml(file.xml);
  const root = parser.parse(file.xml) as Record<string, unknown>;
  const node = root.class as Record<string, unknown> | undefined;
  const name = node?.["@_name"];
  if (typeof name !== "string" || !name) throw new Error(`No <class name> found in ${file.path}`);
  const result: ClassEntry = { brief: text(node.brief_description), description: text(node.description), members: {} };
  const methods = array((node.methods as Record<string, unknown> | undefined)?.method);
  for (const method of methods) {
    const methodName = String(method["@_name"] ?? "");
    if (!methodName) throw new Error(`Method without name in ${file.path}`);
    const params = array(method.param).sort((a, b) => Number(a["@_index"] ?? 0) - Number(b["@_index"] ?? 0));
    const signature = `${methodName}(${params.map((param) => `${param["@_name"] ?? ""}:${param["@_type"] ?? "Variant"}`).join(",")})`;
    const key = `method:${methodName}`;
    const member = result.members[key] ?? { description: "", overloads: [] };
    member.overloads!.push({ signature, description: text(method.description) });
    result.members[key] = member;
  }
  for (const member of array((node.members as Record<string, unknown> | undefined)?.member)) {
    const memberName = String(member["@_name"] ?? "");
    if (memberName) result.members[`property:${memberName}`] = { description: text(member) };
  }
  for (const signal of array((node.signals as Record<string, unknown> | undefined)?.signal)) {
    const signalName = String(signal["@_name"] ?? "");
    if (signalName) result.members[`signal:${signalName}`] = { description: text(signal.description) };
  }
  for (const constant of array((node.constants as Record<string, unknown> | undefined)?.constant)) {
    const constantName = String(constant["@_name"] ?? "");
    if (!constantName) continue;
    const description = text(constant);
    result.members[`constant:${constantName}`] = { description };
    const enumName = constant["@_enum"];
    if (typeof enumName === "string" && enumName) {
      const key = `enum:${enumName}`;
      const enumDoc = result.members[key] ?? { description: "", values: [], valueDescriptions: {} };
      enumDoc.values!.push(constantName);
      enumDoc.valueDescriptions![constantName] = description;
      result.members[key] = enumDoc;
    }
  }
  for (const member of Object.values(result.members)) {
    member.overloads?.sort((a, b) => a.signature.localeCompare(b.signature, "en") || a.description.localeCompare(b.description, "en"));
    if (member.overloads?.length) member.description = member.overloads[0]!.description;
    member.values?.sort((a, b) => a.localeCompare(b, "en"));
  }
  result.members = Object.fromEntries(Object.entries(result.members).sort(([a], [b]) => a.localeCompare(b, "en")));
  return [name, result];
}

function contentHash(classes: Record<string, ClassEntry>): string { return createHash("sha256").update(JSON.stringify(classes)).digest("hex"); }

export function buildDocsIndex(files: Array<{ path: string; xml: string }>, provenance: DocsProvenance): DocsIndex {
  const classes = Object.fromEntries(files.map(parseClass).sort(([a], [b]) => a.localeCompare(b, "en")));
  const memberCount = Object.values(classes).reduce((sum, value) => sum + Object.keys(value.members).length, 0);
  return { manifest: { ...provenance, classCount: Object.keys(classes).length, memberCount, contentSha256: contentHash(classes) }, classes };
}

export function verifyDocsManifest(index: DocsIndex, expected: DocsManifest | DocsProvenance = DOC_EXPECTED): boolean {
  const manifest = index.manifest;
  for (const field of ["engineVersion", "sourceCommit", "sourceArchiveSha256", "generatorVersion", "generatorSha256"] as const) if (manifest[field] !== expected[field]) return false;
  if ("classCount" in expected && manifest.classCount !== expected.classCount) return false;
  if ("memberCount" in expected && manifest.memberCount !== expected.memberCount) return false;
  if ("contentSha256" in expected && manifest.contentSha256 !== expected.contentSha256) return false;
  return manifest.classCount === Object.keys(index.classes).length
    && manifest.memberCount === Object.values(index.classes).reduce((sum, value) => sum + Object.keys(value.members).length, 0)
    && manifest.contentSha256 === contentHash(index.classes);
}

export async function loadBundledDocsIndex(): Promise<DocsIndex> {
  const parsed = JSON.parse(await readFile(new URL("../../assets/godot-4.6.2-class-docs.json", import.meta.url), "utf8")) as DocsIndex;
  if (!verifyDocsManifest(parsed)) throw new GodotMcpError("feature_disabled", "Bundled Godot documentation failed its provenance or integrity check.", "Restore the pinned documentation artifact and run npm run docs:check.");
  return parsed;
}

function boundResponse<T extends Record<string, unknown>>(result: T): T & { truncated?: boolean } {
  if (Buffer.byteLength(JSON.stringify(result)) <= MAX_RESPONSE_BYTES) return result;
  const bounded = structuredClone(result) as T & { truncated: boolean };
  bounded.truncated = true;
  const strings: Array<{ owner: Record<string, unknown>; key: string }> = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (typeof child === "string" && ["brief", "description"].includes(key)) strings.push({ owner: value as Record<string, unknown>, key });
      else visit(child);
    }
  };
  visit(bounded);
  for (const item of strings.reverse()) {
    let value = String(item.owner[item.key]);
    while (value && Buffer.byteLength(JSON.stringify(bounded)) > MAX_RESPONSE_BYTES) {
      const excess = Buffer.byteLength(JSON.stringify(bounded)) - MAX_RESPONSE_BYTES;
      value = Buffer.from(value).subarray(0, Math.max(0, Buffer.byteLength(value) - excess)).toString("utf8").replace(/\uFFFD$/, "");
      item.owner[item.key] = value;
    }
  }
  if (Buffer.byteLength(JSON.stringify(bounded)) > MAX_RESPONSE_BYTES) throw new GodotMcpError("feature_disabled", "Documentation result exceeds the 65536-byte response cap.", "Request one exact class member or regenerate a more compact index.");
  return bounded;
}

export async function requireDocsVersion(client: VersionClient): Promise<void> {
  const version = await client.call<{ engine?: { major?: number; minor?: number; patch?: number } }>("core.get_version");
  const engine = version.engine;
  if (engine?.major !== 4 || engine.minor !== 6) throw new GodotMcpError("feature_disabled", `Bundled class docs support Godot 4.6.x; connected engine is ${engine?.major ?? "?"}.${engine?.minor ?? "?"}.${engine?.patch ?? "?"}.`, "Use a Godot 4.6.x editor or install a documentation index matching the connected engine.");
}

export function classDocFromVerifiedVersion(index: DocsIndex, params: ClassDocParams) {
  const hasClass = typeof params.class === "string" && params.class.length > 0 && Object.hasOwn(index.classes, params.class);
  if (!hasClass) throw new GodotMcpError("invalid_args", `Unknown documented class '${String(params.class)}'.`, "Call godot_api_list_classes and pass an exact class name.");
  const entry = index.classes[params.class]!;
  const result: Record<string, unknown> = { class: params.class, engineVersion: index.manifest.engineVersion, brief: entry.brief, description: entry.description };
  if (params.member) {
    if (!MEMBER_KINDS.includes(params.member.kind) || !params.member.name) throw new GodotMcpError("invalid_args", "Invalid documentation member selector.", "Use kind method, property, signal, constant, or enum with an exact member name.");
    const memberKey = `${params.member.kind}:${params.member.name}`;
    if (!Object.hasOwn(entry.members, memberKey)) throw new GodotMcpError("invalid_args", `Unknown ${params.member.kind} '${params.member.name}' on '${params.class}'.`, "Call godot_api_describe_class and pass an exact member name and kind.");
    const doc = entry.members[memberKey]!;
    result.member = { kind: params.member.kind, name: params.member.name, ...doc };
  }
  return boundResponse(result);
}

export async function classDoc(client: VersionClient, index: DocsIndex, params: ClassDocParams) {
  await requireDocsVersion(client);
  return classDocFromVerifiedVersion(index, params);
}
