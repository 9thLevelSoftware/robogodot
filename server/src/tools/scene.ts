import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CoreBridge } from "./core.js";
import { registerTool } from "../registry.js";
import { callCurated } from "./curated-shared.js";

const projectPath = z.string().min(7).refine(path => Buffer.byteLength(path, "utf8") <= 1024, "Path exceeds 1024 UTF-8 bytes.").refine(path => {
  if (!path.startsWith("res://") || path.includes("\\")) return false;
  const relative = path.slice(6);
  return relative.length > 0 && !relative.startsWith("/") && relative.split("/").every(part => part !== "" && part !== "." && part !== "..");
}, "Path must be a canonical project-relative res:// path without traversal.");
const nodePath = z.string().min(1).max(1024);
const currentResponse = z.object({ path: z.union([projectPath, z.literal("")]), unsaved: z.boolean(), state: z.enum(["clean", "dirty", "unknown"]), reason: z.string() }).strict();
const treeNode = z.object({ name: z.string(), class: z.string(), path: nodePath, parent: nodePath.optional(), depth: z.number().int().nonnegative(), children: z.array(nodePath) }).strict();
const treeResponse = z.object({ nodes: z.array(treeNode), truncated: z.boolean(), nextCursor: z.string().optional() }).strict();
const lifecycle = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const persistence = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export function registerSceneTools(server: McpServer, bridge: CoreBridge): void {
  registerTool(server, { name: "godot_scene_open", description: "Open a project scene; lifecycle operation, not UndoRedo.", inputSchema: z.object({ path: projectPath, discardUnsaved: z.boolean().optional() }).strict(), outputSchema: currentResponse, annotations: lifecycle, handler: input => callCurated(bridge, "edit.scene_open", input, currentResponse) });
  registerTool(server, { name: "godot_scene_new", description: "Create a new edited scene; lifecycle operation, not UndoRedo.", inputSchema: z.object({ rootType: z.string().min(1).max(255).default("Node"), rootName: z.string().min(1).max(255).default("Root"), discardUnsaved: z.boolean().optional() }).strict(), outputSchema: currentResponse, annotations: lifecycle, handler: input => callCurated(bridge, "edit.scene_new", input, currentResponse) });
  registerTool(server, { name: "godot_scene_save", description: "Persist the edited scene. Saving is non-undoable and requires overwrite confirmation for an existing different path.", inputSchema: z.object({ path: projectPath.optional(), overwrite: z.boolean().optional() }).strict(), outputSchema: currentResponse, annotations: persistence, handler: input => callCurated(bridge, "edit.scene_save", input, currentResponse) });
  registerTool(server, { name: "godot_scene_tree", description: "Read a deterministic bounded page of the edited scene tree.", inputSchema: z.object({ root: nodePath.optional(), maxDepth: z.number().int().min(1).max(32).default(8), cursor: z.string().regex(/^(0|[1-9][0-9]*)$/).max(10).optional(), limit: z.number().int().min(1).max(500).default(100) }).strict(), outputSchema: treeResponse, annotations: read, handler: input => callCurated(bridge, "edit.scene_tree", input, treeResponse) });
  registerTool(server, { name: "godot_scene_current", description: "Read the current edited scene and unsaved state.", inputSchema: z.object({}).strict(), outputSchema: currentResponse, annotations: read, handler: input => callCurated(bridge, "edit.scene_current", input, currentResponse) });
}
