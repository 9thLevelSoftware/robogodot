import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { toToolError } from "./errors.js";

export interface ToolDefinition<Input extends Record<string, unknown>, Output extends Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: z.ZodObject;
  outputSchema: z.ZodObject;
  errorCompatibleOutput?: boolean;
  annotations: Required<Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint">>;
  handler(input: Input): Promise<Output>;
}

type ToolRegistrar = Pick<McpServer, "registerTool">;
const registeredNames = new WeakMap<object, Set<string>>();

export function registerTool<Input extends Record<string, unknown>, Output extends Record<string, unknown>>(
  server: ToolRegistrar,
  definition: ToolDefinition<Input, Output>,
): void {
  let names = registeredNames.get(server);
  if (!names) {
    names = new Set();
    registeredNames.set(server, names);
  }
  if (names.has(definition.name)) throw new Error(`Tool "${definition.name}" is already registered`);
  server.registerTool(definition.name, {
    description: definition.description,
    inputSchema: definition.inputSchema,
    outputSchema: definition.errorCompatibleOutput ? compatibleOutputSchema(definition.outputSchema) : definition.outputSchema,
    annotations: definition.annotations,
  }, async (input) => {
    try {
      const output = await definition.handler(input as Input);
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output };
    } catch (error) {
      return toToolError(error) as unknown as CallToolResult;
    }
  });
  names.add(definition.name);
}

const errorOutputSchema = z.object({ code: z.enum(["not_connected", "editor_required", "invalid_args", "godot_error", "timeout", "blocked_by_policy", "feature_disabled"]), message: z.string(), hint: z.string(), data: z.unknown().optional() }).strict();
function compatibleOutputSchema(success: z.ZodObject): z.ZodObject {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, schema] of Object.entries({ ...success.shape, ...errorOutputSchema.shape })) shape[key] = schema.optional();
  return z.object(shape).strict().superRefine((value, context) => {
    if (!success.safeParse(value).success && !errorOutputSchema.safeParse(value).success) context.addIssue({ code: "custom", message: "Output must match the success or standard error schema." });
  }) as z.ZodObject;
}
