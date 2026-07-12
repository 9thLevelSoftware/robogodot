import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CoreBridge } from "./core.js";
import { registerTool } from "../registry.js";
import { callCurated } from "./curated-shared.js";
import { variantLiteralSchema } from "../util/type-parser.js";

const handle = z.string().regex(/^res_[A-Za-z0-9_-]{22}$/);
const className = z.string().min(1).max(255);
const projectPath = z.string().min(7).refine(path => Buffer.byteLength(path, "utf8") <= 1024).refine(path => {
  if (!path.startsWith("res://") || path.includes("\\")) return false;
  const relative = path.slice(6);
  return relative.length > 0 && !relative.startsWith("/") && relative.split("/").every(part => part !== "" && part !== "." && part !== "..");
}, "Path must be a canonical project-relative res:// path without traversal.");
const propertyName = z.string().min(1).max(256).refine(key => !["__proto__", "prototype", "constructor"].includes(key));
const resourceResult = z.object({ handle, class: className, path: z.union([projectPath, z.literal("")]) }).strict();
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const create = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const persistence = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

export function registerResourceTools(server: McpServer, bridge: CoreBridge): void {
  registerTool(server, { name: "godot_resource_load", description: "Load a project Resource into an opaque session handle.", inputSchema: z.object({ path: projectPath }).strict(), outputSchema: resourceResult, annotations: read, handler: input => callCurated(bridge, "edit.resource_load", input, resourceResult) });
  registerTool(server, { name: "godot_resource_create", description: "Create an allowed Resource class in this session.", inputSchema: z.object({ class: className, properties: z.record(propertyName, variantLiteralSchema).default({}) }).strict(), outputSchema: resourceResult, annotations: create, handler: input => callCurated(bridge, "edit.resource_create", input, resourceResult) });
  registerTool(server, { name: "godot_resource_save", description: "Persist a handled Resource to a canonical res:// path. This is explicit persistence and is not Ctrl-Z reversible; overwrite must be confirmed.", inputSchema: z.object({ handle, path: projectPath, overwrite: z.boolean().optional() }).strict(), outputSchema: resourceResult, annotations: persistence, handler: input => callCurated(bridge, "edit.resource_save", input, resourceResult) });
}
