import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { toToolError } from "./errors.js";

export interface ToolDefinition<Input extends Record<string, unknown>, Output extends Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: z.ZodObject;
  outputSchema: z.ZodObject;
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
    outputSchema: definition.outputSchema,
    annotations: definition.annotations,
  }, async (input) => {
    try {
      const output = definition.outputSchema.parse(await definition.handler(input as Input)) as Output;
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output };
    } catch (error) {
      return toToolError(error) as unknown as CallToolResult;
    }
  });
  names.add(definition.name);
}
