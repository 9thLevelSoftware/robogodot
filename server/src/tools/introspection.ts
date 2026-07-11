import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { classDocFromVerifiedVersion, loadBundledDocsIndex, requireDocsVersion, type DocsIndex, type VersionClient } from "../docs/class-docs.js";
import { GodotMcpError } from "../errors.js";
import { registerTool } from "../registry.js";

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const page = { offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(200).optional() };
const listInput = z.object(page).strict();
const listOutput = z.object({ classes: z.array(z.string()), total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), limit: z.number().int().positive(), hasMore: z.boolean() }).strict();
const typedMember = z.object({ name: z.string(), type: z.string(), class: z.string() }).passthrough();
const member = z.object({ name: z.string(), owner: z.string(), declaredHere: z.boolean() }).passthrough();
const describeInput = z.object({ class: z.string().min(1).max(128), memberOffset: z.number().int().nonnegative().optional(), memberLimit: z.number().int().min(1).max(500).optional() }).strict();
const describeOutput = z.object({
  class: z.string(), inherits: z.string(), includeInherited: z.literal(false),
  memberPage: z.object({ offset: z.number().int().nonnegative(), limit: z.number().int().positive(), total: z.number().int().nonnegative(), hasMore: z.boolean() }),
  methods: z.array(member.extend({ signature: z.string(), args: z.array(typedMember), return: typedMember, static: z.boolean(), vararg: z.boolean() })),
  properties: z.array(member), signals: z.array(member), enums: z.array(member), constants: z.array(member),
}).strict();
const searchInput = z.object({ query: z.string().trim().min(1).refine((value) => Buffer.byteLength(value, "utf8") <= 128, "query must be at most 128 UTF-8 bytes"), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
const searchOutput = z.object({ query: z.string(), results: z.array(z.object({ kind: z.string(), class: z.string(), member: z.string().optional() }).strict()), total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), limit: z.number().int().positive(), hasMore: z.boolean() }).strict();
const memberKind = z.enum(["method", "property", "signal", "constant", "enum"]);
const docInput = z.object({ class: z.string().min(1).max(128), member: z.object({ kind: memberKind, name: z.string().min(1).max(128) }).strict().optional() }).strict();
const docOutput = z.object({ class: z.string(), engineVersion: z.string(), brief: z.string(), description: z.string(), member: z.record(z.string(), z.unknown()).optional(), truncated: z.boolean().optional() }).strict();

function validateRemote<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new GodotMcpError("godot_error", "Godot returned an invalid introspection response.", "Check that the Godot plugin and MCP server versions are compatible.");
  return parsed.data;
}

export function registerIntrospectionTools(server: McpServer, bridge: VersionClient, docsLoader: () => Promise<DocsIndex> = loadBundledDocsIndex): void {
  let docsPromise: Promise<DocsIndex> | undefined;
  registerTool(server, { name: "godot_api_list_classes", description: "List live ClassDB classes with deterministic pagination.", inputSchema: listInput, outputSchema: listOutput, annotations,
    handler: async (input) => validateRemote(listOutput, await bridge.call("introspection.list_classes", input)) });
  registerTool(server, { name: "godot_api_describe_class", description: "Describe members declared directly on one live ClassDB class.", inputSchema: describeInput, outputSchema: describeOutput, annotations,
    handler: async (input) => validateRemote(describeOutput, await bridge.call("introspection.describe_class", input)) });
  registerTool(server, { name: "godot_api_search", description: "Search live ClassDB class names with deterministic pagination.", inputSchema: searchInput, outputSchema: searchOutput, annotations,
    handler: async (input) => validateRemote(searchOutput, await bridge.call("introspection.search", input)) });
  registerTool(server, { name: "godot_api_class_doc", description: "Read version-gated official Godot 4.6.2 class or member documentation from the verified offline index.", inputSchema: docInput, outputSchema: docOutput, annotations,
    handler: async (input) => {
      const value = input as z.infer<typeof docInput>;
      await requireDocsVersion(bridge);
      docsPromise ??= docsLoader();
      return classDocFromVerifiedVersion(await docsPromise, { class: value.class, ...(value.member ? { member: value.member } : {}) });
    } });
}
