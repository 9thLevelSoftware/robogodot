import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GodotMcpError } from "../errors.js";
import type { DapReference } from "../runtime/dap-client.js";
import { registerTool } from "../registry.js";

export interface DebugToolService {
  debugLaunch(options: { scene?: string; args?: string[]; timeoutMs: number; initialBreakpoints?: { path: string; lines: number[] }[] }): Promise<unknown>;
  debugSetBreakpoints(sessionId: string, path: string, lines: number[]): Promise<unknown>;
  debugContinue(sessionId: string, thread: DapReference): Promise<unknown>;
  debugStep(sessionId: string, thread: DapReference, kind: "over" | "into"): Promise<unknown>;
  debugStack(sessionId: string, thread?: DapReference, startFrame?: number): Promise<unknown>;
  debugInspect(sessionId: string, frame: DapReference, variables?: DapReference, start?: number): Promise<unknown>;
}

const utf8 = (maximum: number) => z.string().refine(value => Buffer.byteLength(value, "utf8") <= maximum, `Must be at most ${maximum} UTF-8 bytes.`);
const sessionId = z.string().regex(/^[a-f0-9]{32}$/);
const scene = utf8(4096).refine(value => value.startsWith("res://") && !value.slice(6).split("/").some(part => part === ".." || part === ""), "Must be a contained res:// path.");
const argument = utf8(1024);
const args = z.array(argument).max(32).refine(values => Buffer.byteLength(values.join(""), "utf8") <= 8192, "Arguments must total at most 8192 UTF-8 bytes.");
const reference = z.object({ runtimeSessionId: sessionId, stoppedGeneration: z.number().int().safe().min(1), id: z.number().int().safe().min(0) }).strict();
const relativeSource = utf8(4096).refine(value => !value.startsWith("/") && !/^[A-Za-z]:/.test(value) && !value.includes("\\") && value.endsWith(".gd") && !value.split("/").some(part => part === "" || part === "." || part === ".."), "Must be a contained project-relative GDScript path.");
const lines = z.array(z.number().int().min(1).max(0x7fffffff)).max(500).refine(value => new Set(value).size === value.length, "Breakpoint lines must be unique.");
const initialBreakpoint = z.object({ path: relativeSource, lines }).strict();
const initialBreakpoints = z.array(initialBreakpoint).max(32).refine(groups => groups.reduce((total, group) => total + group.lines.length, 0) <= 500, "Initial breakpoints must total at most 500 lines.").refine(groups => new Set(groups.map(group => group.path)).size === groups.length, "Initial breakpoint paths must be unique.");
const launchInput = z.object({ scene: scene.optional(), arguments: args.optional(), initialBreakpoints: initialBreakpoints.optional(), timeoutMs: z.number().int().min(100).max(60_000).default(15_000) }).strict();
const breakpointsInput = z.object({ sessionId, path: relativeSource, lines }).strict();
const continueInput = z.object({ sessionId, thread: reference }).strict();
const stepInput = z.object({ sessionId, thread: reference, kind: z.enum(["over", "into"]) }).strict();
const stackInput = z.object({ sessionId, thread: reference.optional(), startFrame: z.number().int().safe().min(0).default(0) }).strict();
const inspectInput = z.object({ sessionId, frame: reference, variables: reference.optional(), start: z.number().int().safe().min(0).default(0) }).strict();
const boundedText = utf8(8192);
const sourceOutput = z.object({ name: boundedText.optional(), path: boundedText.optional() }).strict();
const breakpointOutput = z.object({ id: z.number().int().safe().min(0).optional(), verified: z.boolean(), message: boundedText.optional(), line: z.number().int().min(1).max(0x7fffffff).optional(), column: z.number().int().min(1).max(0x7fffffff).optional(), endLine: z.number().int().min(1).max(0x7fffffff).optional(), endColumn: z.number().int().min(1).max(0x7fffffff).optional(), instructionReference: boundedText.optional(), offset: z.number().int().safe().optional() }).strict();
const capabilitiesOutput = z.object({ supportsConfigurationDoneRequest: z.boolean(), supportsTerminateRequest: z.boolean(), supportsVariablePaging: z.boolean() }).strict();
const launchOutput = z.object({ sessionId, mode: z.literal("debug"), state: z.literal("debug_ready"), pid: z.number().int().positive(), startedAt: z.number(), bridgeTransport: z.enum(["socket", "file"]).optional(), capabilities: capabilitiesOutput }).strict();
const breakpointsOutput = z.object({ sessionId, path: relativeSource, breakpoints: z.array(breakpointOutput).max(500) }).strict();
const continueOutput = z.object({ sessionId, resumed: z.literal(true) }).strict();
const stepOutput = z.object({ sessionId, kind: z.enum(["over", "into"]), resumed: z.literal(true) }).strict();
const threadOutput = z.object({ id: z.number().int().safe().min(0), ref: reference, name: boundedText }).strict();
const frameOutput = z.object({ id: z.number().int().safe().min(0), ref: reference, name: boundedText, line: z.number().int().min(0).max(0x7fffffff), column: z.number().int().min(0).max(0x7fffffff), source: sourceOutput.optional() }).strict();
const stackOutput = z.object({ sessionId, stoppedGeneration: z.number().int().safe().min(1), threads: z.array(threadOutput).max(64), frames: z.array(frameOutput).max(256), totalFrames: z.number().int().safe().min(0).optional(), truncated: z.boolean() }).strict();
const scopeOutput = z.object({ name: boundedText, ref: reference, expensive: z.boolean().optional() }).strict();
const variableOutput = z.object({ name: boundedText, value: boundedText, type: boundedText.optional(), ref: reference }).strict();
const inspectOutput = z.object({ sessionId, stoppedGeneration: z.number().int().safe().min(1), scopes: z.array(scopeOutput).max(64).optional(), variables: z.array(variableOutput).max(500).optional(), next: z.number().int().safe().min(0).optional(), truncated: z.boolean() }).strict().superRefine((value, context) => { if ((value.scopes === undefined) === (value.variables === undefined)) context.addIssue({ code: "custom", message: "Provide exactly one scopes or variables page." }); });

const unavailable = (): never => { throw new GodotMcpError("not_connected", "The Godot debug service is not configured.", "Configure Godot, the runtime coordinator, and the attach-only DAP client before using debug tools."); };
export const disconnectedDebug: DebugToolService = { debugLaunch: async () => unavailable(), debugSetBreakpoints: async () => unavailable(), debugContinue: async () => unavailable(), debugStep: async () => unavailable(), debugStack: async () => unavailable(), debugInspect: async () => unavailable() };

export function registerDebugTools(server: McpServer, service: DebugToolService): void {
  registerTool(server, { name: "godot_debug_launch", description: "Launch one coordinator-owned runtime, apply bounded initial breakpoints, and attach to Godot's existing DAP server.", inputSchema: launchInput, outputSchema: launchOutput, annotations: rw(false, false), handler: async (input: any) => normalizeLaunch(await service.debugLaunch({ ...(input.scene ? { scene: input.scene } : {}), ...(input.arguments ? { args: input.arguments } : {}), ...(input.initialBreakpoints ? { initialBreakpoints: input.initialBreakpoints } : {}), timeoutMs: input.timeoutMs })) });
  registerTool(server, { name: "godot_debug_set_breakpoints", description: "Replace all breakpoints for one contained GDScript source file.", inputSchema: breakpointsInput, outputSchema: breakpointsOutput, annotations: rw(false, true), handler: async (input: any) => normalize(await service.debugSetBreakpoints(input.sessionId, input.path, input.lines)) });
  registerTool(server, { name: "godot_debug_continue", description: "Continue one current stopped thread and invalidate its stopped references.", inputSchema: continueInput, outputSchema: continueOutput, annotations: rw(false, false), handler: async (input: any) => normalize(await service.debugContinue(input.sessionId, input.thread)) });
  registerTool(server, { name: "godot_debug_step", description: "Step over or into on one current stopped thread.", inputSchema: stepInput, outputSchema: stepOutput, annotations: rw(false, false), handler: async (input: any) => normalize(await service.debugStep(input.sessionId, input.thread, input.kind)) });
  registerTool(server, { name: "godot_debug_stack", description: "Read a bounded stopped thread and stack-frame page.", inputSchema: stackInput, outputSchema: stackOutput, annotations: rw(true, false), handler: async (input: any) => normalize(await service.debugStack(input.sessionId, input.thread, input.startFrame)) });
  registerTool(server, { name: "godot_debug_inspect", description: "Inspect bounded stopped scopes or variables without expression evaluation.", inputSchema: inspectInput, outputSchema: inspectOutput, annotations: rw(true, false), handler: async (input: any) => normalize(await service.debugInspect(input.sessionId, input.frame, input.variables, input.start)) });
}

function rw(readOnlyHint: boolean, idempotentHint: boolean) { return { readOnlyHint, destructiveHint: false, idempotentHint, openWorldHint: true }; }
function normalize(value: unknown): Record<string, unknown> { return copy(value, new Set(), 0) as Record<string, unknown>; }
function normalizeLaunch(value: unknown): Record<string, unknown> {
  const sessionId = data(value, "sessionId") ?? data(value, "id"); const capabilities = data(value, "capabilities");
  const output: Record<string, unknown> = { sessionId, mode: data(value, "mode"), state: data(value, "state"), pid: data(value, "pid"), startedAt: data(value, "startedAt"), capabilities: { supportsConfigurationDoneRequest: data(capabilities, "supportsConfigurationDoneRequest") === true, supportsTerminateRequest: data(capabilities, "supportsTerminateRequest") === true, supportsVariablePaging: data(capabilities, "supportsVariablePaging") === true } };
  const bridgeTransport = data(value, "bridgeTransport"); if (bridgeTransport !== undefined) output.bridgeTransport = bridgeTransport; return output;
}
function data(value: unknown, key: string): unknown { if (!value || typeof value !== "object") return undefined; let descriptor: PropertyDescriptor | undefined; try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { throw malformed(); } if (!descriptor) return undefined; if (!("value" in descriptor)) throw malformed(); return descriptor.value; }
function copy(value: unknown, seen: Set<object>, depth: number): unknown {
  if (depth > 16) throw malformed();
  if (value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (!value || typeof value !== "object" || seen.has(value)) throw malformed();
  seen.add(value);
  try {
    let descriptors: PropertyDescriptorMap; try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { throw malformed(); }
    if (Array.isArray(value)) {
      const length = descriptors.length; if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > 1000) throw malformed();
      const output: unknown[] = []; for (let index = 0; index < length.value; index++) { const descriptor = descriptors[String(index)]; if (!descriptor || !("value" in descriptor)) throw malformed(); output.push(copy(descriptor.value, seen, depth + 1)); } return output;
    }
    const output: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(descriptors)) { if (!descriptor.enumerable) continue; if (!("value" in descriptor)) throw malformed(); output[key] = copy(descriptor.value, seen, depth + 1); }
    return output;
  } finally { seen.delete(value); }
}
function malformed() { return new GodotMcpError("godot_error", "Debug service returned an invalid response.", "Restart the managed debug session with a compatible Godot debug adapter."); }
