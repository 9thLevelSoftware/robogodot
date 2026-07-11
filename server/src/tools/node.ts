import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CoreBridge } from "./core.js";
import { registerTool } from "../registry.js";
import { callCurated } from "./curated-shared.js";
import { MutationLane } from "../mutation/lane.js";
import { GodotMcpError } from "../errors.js";

const utf8 = (label: string, max: number) => z.string().min(1).refine(v => Buffer.byteLength(v, "utf8") <= max, `${label} exceeds ${max} UTF-8 bytes`);
const nodePath = utf8("NodePath", 1024);
const nodeName = utf8("node name", 255);
const propertyName = utf8("property name", 255);
const className = utf8("class name", 255);
const variant = z.unknown();
const response = z.object({ ok: z.boolean() }).passthrough();
const getResponse = z.object({ ok: z.boolean(), path: nodePath, class: z.string(), name: z.string(), childCount: z.number().int().nonnegative(), properties: z.record(z.string(), z.unknown()) }).strict();
const readonlyMethods = new Set(["get_path", "get_child_count", "is_inside_tree"]);
const mutationAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export function registerNodeTools(server: McpServer, bridge: CoreBridge, lane: MutationLane): void {
  const mutation = (name: string, method: string, schema: z.ZodObject, tags: (input: any) => string[]) => registerTool(server, {
    name, description: `Undoable Godot node operation: ${name}.`, inputSchema: schema, outputSchema: response, annotations: mutationAnnotations,
    handler: async (input: any) => lane.run(tags(input) as any, () => callCurated(bridge, method, input, response)),
  });
  mutation("godot_node_add", "edit.node_add", z.object({ parent: nodePath, type: className, name: nodeName, properties: z.record(propertyName, variant).default({}) }).strict(), i => ["scene", `node:${i.parent}`]);
  mutation("godot_node_delete", "edit.node_delete", z.object({ path: nodePath }).strict(), i => ["scene", `node:${i.path}`]);
  mutation("godot_node_reparent", "edit.node_reparent", z.object({ path: nodePath, parent: nodePath, index: z.number().int().nonnegative().optional() }).strict(), i => ["scene", `node:${i.path}`, `node:${i.parent}`]);
  mutation("godot_node_rename", "edit.node_rename", z.object({ path: nodePath, name: nodeName }).strict(), i => ["scene", `node:${i.path}`]);
  mutation("godot_node_duplicate", "edit.node_duplicate", z.object({ path: nodePath, parent: nodePath.optional(), name: nodeName.optional(), flags: z.number().int().nonnegative().default(15) }).strict(), i => ["scene", `node:${i.path}`]);
  registerTool(server, { name: "godot_node_get", description: "Inspect a node.", inputSchema: z.object({ path: nodePath }).strict(), outputSchema: getResponse, annotations: readAnnotations, handler: input => callCurated(bridge, "edit.node_get", input, getResponse) });
  mutation("godot_node_set_property", "edit.node_set_property", z.object({ path: nodePath, property: propertyName, value: variant }).strict(), i => ["scene", `node:${i.path}`]);
  registerTool(server, {
    name: "godot_node_call_method", description: "Call an allowlisted zero-argument read-only Node method.",
    inputSchema: z.object({ path: nodePath, method: utf8("method name", 255), args: z.tuple([]) }).strict(), outputSchema: response, annotations: readAnnotations,
    handler: async input => {
      if (typeof input.method !== "string" || !readonlyMethods.has(input.method)) throw new GodotMcpError("invalid_args", `Method '${String(input.method)}' is not allowlisted.`, "Use get_path, get_child_count, or is_inside_tree with zero arguments.");
      return callCurated(bridge, "edit.node_call_readonly", input, response);
    },
  });
}
