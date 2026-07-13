import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GodotMcpError } from "../errors.js";
import { registerTool } from "../registry.js";
import type { RuntimeMode, RuntimeOutput, RuntimeSessionSnapshot, RuntimeStopResult } from "../runtime/session.js";

export interface RuntimeLaunchOptions { scene?: string; args?: string[] }
export interface RuntimeToolService {
  launch(mode: RuntimeMode, options: RuntimeLaunchOptions): Promise<RuntimeSessionSnapshot>;
  stop(sessionId: string): Promise<RuntimeStopResult>;
  output(sessionId: string, since: number, limit: number): Promise<RuntimeOutput>;
}

const utf8 = (maximum: number) => z.string().refine(value => Buffer.byteLength(value, "utf8") <= maximum, `Must be at most ${maximum} UTF-8 bytes.`);
const scene = utf8(4096).refine(value => value.startsWith("res://") && !value.slice(6).split("/").some(part => part === ".." || part === ""), "Must be a contained res:// path.");
const argument = utf8(1024);
const argumentsList = z.array(argument).max(32).refine(values => Buffer.byteLength(values.join(""), "utf8") <= 8192, "Arguments must total at most 8192 UTF-8 bytes.");
const sessionId = z.string().regex(/^[a-f0-9]{32}$/);
const runInput = z.object({ scene: scene.optional(), arguments: argumentsList.optional() }).strict();
const stopInput = z.object({ sessionId }).strict();
const outputInput = z.object({ sessionId, since: z.number().int().safe().min(0).default(0), limit: z.number().int().min(1).max(500).default(100) }).strict();
const runOutput = z.object({}).passthrough();
const stopOutput = z.object({}).passthrough();
const pageOutput = z.object({}).passthrough();

const unavailable = (): never => { throw new GodotMcpError("not_connected", "The runtime process service is not configured.", "Configure Godot and the runtime session coordinator before using process tools."); };
export const disconnectedRuntime: RuntimeToolService = { launch: async () => unavailable(), stop: async () => unavailable(), output: async () => unavailable() };

export function registerRuntimeTools(server: McpServer, service: RuntimeToolService): void {
  registerTool(server, { name: "godot_run_project", description: "Launch one managed Godot project runtime session.", inputSchema: runInput, outputSchema: runOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: async (input: { scene?: string; arguments?: string[] }) => {
      validateArguments(input.arguments);
      const value = await service.launch("normal", { ...(input.scene ? { scene: input.scene } : {}), ...(input.arguments ? { args: input.arguments } : {}) });
      return { sessionId: value.id, mode: "normal", pid: value.pid!, startedAt: value.startedAt!, ...("bridgeTransport" in value ? { bridgeTransport: (value as any).bridgeTransport } : {}) };
    } });
  registerTool(server, { name: "godot_stop_project", description: "Stop the exact managed runtime session and all attached runtime channels.", inputSchema: stopInput, outputSchema: stopOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }, handler: async (input: { sessionId: string }) => ({ ...await service.stop(input.sessionId) }) });
  registerTool(server, { name: "godot_run_output", description: "Read a bounded cursor page of normalized managed-process output.", inputSchema: outputInput, outputSchema: pageOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }, handler: async (input: { sessionId: string; since: number; limit: number }) => ({ ...await service.output(input.sessionId, input.since, input.limit) }) });
}

function validateArguments(values: string[] | undefined): void {
  if (values && Buffer.byteLength(values.join(""), "utf8") > 8192) throw new GodotMcpError("invalid_args", "Runtime arguments exceed 8192 total UTF-8 bytes.", "Reduce the number or size of runtime arguments.");
}
