import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CoreBridge } from "./core.js";
import { registerTool } from "../registry.js";
import { callCurated } from "./curated-shared.js";
import { MutationLane } from "../mutation/lane.js";
import { variantLiteralSchema } from "../util/type-parser.js";

const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const key = z.string().min(1).max(512).refine(value => Buffer.byteLength(value, "utf8") <= 1024 && !forbidden.has(value) && !value.includes("//") && !value.startsWith("/") && !value.endsWith("/"), "Setting key must be a bounded own-property path.");
const cursor = z.string().regex(/^(0|[1-9][0-9]*)$/).max(10);
const entry = z.object({ key, value: variantLiteralSchema }).strict();
const getResult = z.object({ key, exists: z.boolean(), value: variantLiteralSchema.optional() }).strict();
const setResult = z.object({ key, beforeExists: z.boolean(), before: variantLiteralSchema.optional(), after: variantLiteralSchema }).strict();
const listResult = z.object({ settings: z.array(entry).max(500), truncated: z.boolean(), nextCursor: cursor.optional() }).strict();
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const mutate = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

export function registerProjectTools(server: McpServer, bridge: CoreBridge, lane: MutationLane): void {
  registerTool(server, { name: "godot_project_setting_get", description: "Read one project setting and whether it exists.", inputSchema: z.object({ key }).strict(), outputSchema: getResult, annotations: read, handler: input => callCurated(bridge, "edit.project_setting_get", input, getResult) });
  registerTool(server, { name: "godot_project_setting_set", description: "Set and persist a project setting through one exactly restorable UndoRedo action.", inputSchema: z.object({ key, value: variantLiteralSchema }).strict(), outputSchema: setResult, annotations: mutate, handler: input => lane.run(["project-settings"], () => callCurated(bridge, "edit.project_setting_set", input, setResult)) });
  registerTool(server, { name: "godot_project_setting_list", description: "Read a stable sorted bounded page of project settings.", inputSchema: z.object({ prefix: z.string().max(512).optional(), cursor: cursor.optional(), limit: z.number().int().min(1).max(500).default(100) }).strict(), outputSchema: listResult, annotations: read, handler: input => callCurated(bridge, "edit.project_setting_list", input, listResult) });
}
