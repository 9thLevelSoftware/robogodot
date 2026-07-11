import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SafetyMode } from "../config.js";
import { executeEditorScript, type RpcCaller } from "../exec/guard.js";
import { registerTool } from "../registry.js";

const inputSchema = z.object({
  source: z.string().min(1).max(24_000),
  args: z.unknown().optional(),
  allowDangerous: z.boolean().optional(),
  outputCapBytes: z.number().int().min(0).max(262_144).optional(),
}).strict();

const outputSchema = z.object({
  ok: z.boolean(), returnValue: z.unknown(), stdout: z.string(), errors: z.array(z.string()),
  elapsedMs: z.number().nonnegative(), truncated: z.boolean(),
}).strict();

export function registerScriptTool(server: McpServer, bridge: RpcCaller, mode: SafetyMode): void {
  registerTool(server, {
    name: "godot_script_run",
    description: "Run reviewed transient @tool GDScript in the connected editor. Requires full mode and allowDangerous true; the 15-second deadline does not cancel blocked editor code.",
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    handler: async (input) => {
      const value = input as z.infer<typeof inputSchema>;
      return { ...await executeEditorScript(bridge, {
        source: value.source, mode,
        ...(value.allowDangerous !== undefined ? { allowDangerous: value.allowDangerous } : {}),
        ...(value.args !== undefined ? { args: value.args } : {}),
        ...(value.outputCapBytes !== undefined ? { outputCapBytes: value.outputCapBytes } : {}),
      }) };
    },
  });
}
