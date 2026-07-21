import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GodotMcpError, toToolError } from "./errors.js";
import type { PolicyBundle } from "./policy.js";
import { cacheKey } from "./mw/cache.js";
import { cacheTagsFor, enforceModePolicy, isMutating } from "./mw/safety.js";
import { summarizeArguments, type AuditOutcome } from "./obs/audit.js";

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
const policies = new WeakMap<object, PolicyBundle>();

export function bindPolicy(server: ToolRegistrar, policy: PolicyBundle): void {
  policies.set(server, policy);
}

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

  const inputSchema = (definition.inputSchema as z.ZodObject).extend({
    confirmed: z.boolean().optional(),
  }).strict();

  server.registerTool(definition.name, {
    description: definition.description,
    inputSchema,
    outputSchema: definition.outputSchema,
    annotations: definition.annotations,
  }, async (input) => {
    const policy = policies.get(server);
    const startedMs = Date.now();
    let outcome: AuditOutcome = "success";
    let code: string | undefined;
    const raw = (input ?? {}) as Record<string, unknown>;
    const confirmed = raw.confirmed === true;
    const { confirmed: _confirmed, ...handlerInput } = raw;

    try {
      if (policy) {
        enforceModePolicy(policy.mode, definition.annotations, { confirmed, toolName: definition.name });
      }

      const runHandler = async (): Promise<Output> => {
        const output = definition.outputSchema.parse(await definition.handler(handlerInput as Input)) as Output;
        return output;
      };

      if (!policy) {
        const output = await runHandler();
        return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output };
      }

      const tags = cacheTagsFor(definition.name, definition.annotations);

      if (!isMutating(definition.annotations)) {
        const key = cacheKey(definition.name, handlerInput);
        const hit = policy.cache.get<Output>(key);
        if (hit !== undefined) {
          outcome = "cache_hit";
          return { content: [{ type: "text" as const, text: JSON.stringify(hit) }], structuredContent: hit };
        }
        const generation = policy.cache.currentGeneration;
        const output = await runHandler();
        policy.cache.set(key, output, tags, generation);
        return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output };
      }

      const output = await policy.mutationLane.run(tags as never, async () => {
        const fence = policy.cache.beginMutation(tags);
        try {
          return await runHandler();
        } finally {
          policy.cache.endMutation(fence, tags);
        }
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output };
    } catch (error) {
      if (error instanceof GodotMcpError && error.code === "blocked_by_policy") outcome = "blocked";
      else outcome = "error";
      if (error instanceof GodotMcpError) code = error.code;
      return toToolError(error) as unknown as CallToolResult;
    } finally {
      if (policy) {
        policy.audit.record({
          tool: definition.name,
          mode: policy.mode,
          outcome,
          ...(code ? { code } : {}),
          elapsedMs: Math.max(0, Date.now() - startedMs),
          mutating: isMutating(definition.annotations),
          argumentSummary: summarizeArguments(handlerInput),
        });
      }
    }
  });
  names.add(definition.name);
}
