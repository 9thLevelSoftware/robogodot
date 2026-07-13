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
const exitSchema = z.object({ code: z.number().int().nullable(), signal: z.string().nullable(), at: z.number(), error: z.string().optional() }).strict();
const runOutput = z.object({ sessionId, mode: z.literal("normal"), pid: z.number().int().positive(), bridgeTransport: z.enum(["socket", "file"]).optional(), startedAt: z.number() }).strict();
const stopOutput = z.object({ sessionId, alreadyStopped: z.boolean(), graceful: z.boolean(), forced: z.boolean(), exit: exitSchema.optional() }).strict();
const recordSchema = z.object({ cursor: z.number().int().safe().min(0), stream: z.enum(["stdout", "stderr"]), at: z.number(), text: z.string(), truncated: z.boolean() }).strict();
const pageOutput = z.object({ sessionId, running: z.boolean(), exit: exitSchema.optional(), records: z.array(recordSchema), next: z.number().int().safe().min(0), lost: z.number().int().safe().min(0), truncated: z.boolean() }).strict();

const unavailable = (): never => { throw new GodotMcpError("not_connected", "The runtime process service is not configured.", "Configure Godot and the runtime session coordinator before using process tools."); };
export const disconnectedRuntime: RuntimeToolService = { launch: async () => unavailable(), stop: async () => unavailable(), output: async () => unavailable() };

export function registerRuntimeTools(server: McpServer, service: RuntimeToolService): void {
  registerTool(server, { name: "godot_run_project", description: "Launch one managed Godot project runtime session.", inputSchema: runInput, outputSchema: runOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: async (input: { scene?: string; arguments?: string[] }) => {
      validateArguments(input.arguments);
      const value = await service.launch("normal", { ...(input.scene ? { scene: input.scene } : {}), ...(input.arguments ? { args: input.arguments } : {}) });
      return normalizeLaunch(value);
    } });
  registerTool(server, { name: "godot_stop_project", description: "Stop the exact managed runtime session and all attached runtime channels.", inputSchema: stopInput, outputSchema: stopOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }, handler: async (input: { sessionId: string }) => normalizeStop(await service.stop(input.sessionId)) });
  registerTool(server, { name: "godot_run_output", description: "Read a bounded cursor page of normalized managed-process output.", inputSchema: outputInput, outputSchema: pageOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }, handler: async (input: { sessionId: string; since: number; limit: number }) => normalizePage(await service.output(input.sessionId, input.since, input.limit)) });
}

function own(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) throw malformed();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) throw malformed();
  return descriptor.value;
}
function parsed<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw malformed(); return result.data; }
function normalizeExit(value: unknown) { return parsed(exitSchema, { code: own(value, "code"), signal: own(value, "signal"), at: own(value, "at"), ...(Object.getOwnPropertyDescriptor(value as object, "error")?.value !== undefined ? { error: own(value, "error") } : {}) }); }
function normalizeLaunch(value: unknown) { const bridgeTransport = optionalOwn(value, "bridgeTransport"); return parsed(runOutput, { sessionId: own(value, "id"), mode: own(value, "mode"), pid: own(value, "pid"), ...(bridgeTransport === undefined ? {} : { bridgeTransport }), startedAt: own(value, "startedAt") }); }
function normalizeStop(value: unknown) { const exit = optionalOwn(value, "exit"); return parsed(stopOutput, { sessionId: own(value, "sessionId"), alreadyStopped: own(value, "alreadyStopped"), graceful: own(value, "graceful"), forced: own(value, "forced"), ...(exit === undefined ? {} : { exit: normalizeExit(exit) }) }); }
function normalizePage(value: unknown) { const records = own(value, "records"); if (!Array.isArray(records)) throw malformed(); const exit = optionalOwn(value, "exit"); return parsed(pageOutput, { sessionId: own(value, "sessionId"), running: own(value, "running"), ...(exit === undefined ? {} : { exit: normalizeExit(exit) }), records: records.map(item => parsed(recordSchema, { cursor: own(item, "cursor"), stream: own(item, "stream"), at: own(item, "at"), text: own(item, "text"), truncated: own(item, "truncated") })), next: own(value, "next"), lost: own(value, "lost"), truncated: own(value, "truncated") }); }
function optionalOwn(value: unknown, key: string): unknown { const descriptor = (typeof value === "object" && value !== null) ? Object.getOwnPropertyDescriptor(value, key) : undefined; if (!descriptor) return undefined; if (!("value" in descriptor)) throw malformed(); return descriptor.value; }
function malformed() { return new GodotMcpError("godot_error", "Runtime service returned an invalid response.", "Check that the runtime coordinator and MCP server versions are compatible."); }

function validateArguments(values: string[] | undefined): void {
  if (values && Buffer.byteLength(values.join(""), "utf8") > 8192) throw new GodotMcpError("invalid_args", "Runtime arguments exceed 8192 total UTF-8 bytes.", "Reduce the number or size of runtime arguments.");
}
