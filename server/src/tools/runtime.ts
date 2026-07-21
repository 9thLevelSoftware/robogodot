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
  sceneTree?(sessionId: string, maxDepth: number): Promise<unknown>;
  getNode?(sessionId: string, path: string, properties: string[]): Promise<unknown>;
  input?(sessionId: string, input: RuntimeInput): Promise<unknown>;
  screenshot?(sessionId: string, name?: string): Promise<unknown>;
}
export type RuntimeInput = { kind: "action"; action: string; mode: "press" | "release" | "press_release"; holdMs: number } | { kind: "key"; keycode: number; pressed: boolean; holdMs: number } | { kind: "mouse_button"; button: number; pressed: boolean; holdMs: number };

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
const bridgeSessionId = utf8(128).min(1);
const nodePath = utf8(1024).min(1);
const propertyName = utf8(256).min(1);
const actionName = utf8(256).min(1);
const bridgeBase = { sessionId: bridgeSessionId };
const sceneTreeInput = z.object({ ...bridgeBase, maxDepth: z.number().int().min(1).max(32).default(8) }).strict();
const nodeInput = z.object({ ...bridgeBase, path: nodePath, properties: z.array(propertyName).max(64).default([]) }).strict();
const inputSchema = z.object({ ...bridgeBase, kind: z.enum(["action", "key", "mouse_button"]), action: actionName.optional(), mode: z.enum(["press", "release", "press_release"]).optional(), keycode: z.number().int().min(0).max(0x7fffffff).optional(), button: z.number().int().min(1).max(5).optional(), pressed: z.boolean().optional(), holdMs: z.number().int().min(0).max(2000).default(0) }).strict().superRefine((value, context) => {
  const present = (key: string) => Object.prototype.hasOwnProperty.call(value, key);
  const exact = value.kind === "action" ? present("action") && present("mode") && !present("keycode") && !present("button") && !present("pressed") : value.kind === "key" ? present("keycode") && present("pressed") && !present("action") && !present("mode") && !present("button") : present("button") && present("pressed") && !present("action") && !present("mode") && !present("keycode");
  if (!exact) context.addIssue({ code: "custom", message: "Provide exactly one action, key, or mouse-button input." });
});
const screenshotInput = z.object({ ...bridgeBase, name: utf8(256).regex(/^(?!.*\.\.)(?!.*[\\/])[^\\/]+\.png$/).optional() }).strict();
const nodeRecord = z.object({ path: nodePath, name: utf8(256), type: utf8(256), depth: z.number().int().min(0).max(32) }).strict();
const treeOutput = z.object({ sessionId: bridgeSessionId, nodes: z.array(nodeRecord).max(1000), truncated: z.object({ nodes: z.boolean(), depth: z.boolean() }).strict() }).strict();
const nodeOutput = z.object({ sessionId: bridgeSessionId, path: nodePath, type: utf8(256), properties: z.record(z.string(), z.json()), omittedProperties: z.array(propertyName).max(64) }).strict();
const inputOutput = z.object({ sessionId: bridgeSessionId, accepted: z.literal(true) }).strict();
const screenshotOutput = z.object({ sessionId: bridgeSessionId, path: utf8(4096), absolutePath: utf8(4096), width: z.number().int().positive(), height: z.number().int().positive(), bytes: z.number().int().positive().max(16 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/), format: z.literal("png") }).strict();

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
  registerTool(server, { name: "godot_runtime_scene_tree", description: "Read a bounded live runtime scene hierarchy.", inputSchema: sceneTreeInput, outputSchema: treeOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }, handler: async (input: { sessionId: string; maxDepth: number }) => normalizeTree(await bridgeOperation(service, service.sceneTree)(input.sessionId, input.maxDepth)) });
  registerTool(server, { name: "godot_runtime_get_node", description: "Read allowlisted properties from one live runtime node.", inputSchema: nodeInput, outputSchema: nodeOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }, handler: async (input: { sessionId: string; path: string; properties: string[] }) => normalizeNode(await bridgeOperation(service, service.getNode)(input.sessionId, input.path, input.properties)) });
  registerTool(server, { name: "godot_runtime_input", description: "Inject one bounded named action, key, or mouse-button operation.", inputSchema, outputSchema: inputOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, handler: async (value: any) => { const input = value.kind === "action" ? { kind: value.kind, action: value.action, mode: value.mode, holdMs: value.holdMs } : value.kind === "key" ? { kind: value.kind, keycode: value.keycode, pressed: value.pressed, holdMs: value.holdMs } : { kind: value.kind, button: value.button, pressed: value.pressed, holdMs: value.holdMs }; return normalizeInput(await bridgeOperation(service, service.input)(value.sessionId, input)); } });
  registerTool(server, { name: "godot_runtime_screenshot", description: "Capture and verify one contained runtime viewport PNG.", inputSchema: screenshotInput, outputSchema: screenshotOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, handler: async (input: { sessionId: string; name?: string }) => normalizeScreenshot(await bridgeOperation(service, service.screenshot)(input.sessionId, input.name)) });
}

function own(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) throw malformed();
  let descriptor: PropertyDescriptor | undefined; try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { throw malformed(); }
  if (!descriptor || !("value" in descriptor)) throw malformed();
  return descriptor.value;
}
function parsed<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw malformed(); return result.data; }
function normalizeExit(value: unknown) { return parsed(exitSchema, { code: own(value, "code"), signal: own(value, "signal"), at: own(value, "at"), ...(Object.getOwnPropertyDescriptor(value as object, "error")?.value !== undefined ? { error: own(value, "error") } : {}) }); }
function normalizeLaunch(value: unknown) { const bridgeTransport = optionalOwn(value, "bridgeTransport"); return parsed(runOutput, { sessionId: own(value, "id"), mode: own(value, "mode"), pid: own(value, "pid"), ...(bridgeTransport === undefined ? {} : { bridgeTransport }), startedAt: own(value, "startedAt") }); }
function normalizeStop(value: unknown) { const exit = optionalOwn(value, "exit"); return parsed(stopOutput, { sessionId: own(value, "sessionId"), alreadyStopped: own(value, "alreadyStopped"), graceful: own(value, "graceful"), forced: own(value, "forced"), ...(exit === undefined ? {} : { exit: normalizeExit(exit) }) }); }
function normalizePage(value: unknown) { const records = own(value, "records"); if (!Array.isArray(records)) throw malformed(); const exit = optionalOwn(value, "exit"); return parsed(pageOutput, { sessionId: own(value, "sessionId"), running: own(value, "running"), ...(exit === undefined ? {} : { exit: normalizeExit(exit) }), records: records.map(item => parsed(recordSchema, { cursor: own(item, "cursor"), stream: own(item, "stream"), at: own(item, "at"), text: own(item, "text"), truncated: own(item, "truncated") })), next: own(value, "next"), lost: own(value, "lost"), truncated: own(value, "truncated") }); }
function normalizeTree(value: unknown) { const nodes = dataArray(own(value, "nodes"), 1000); const truncation = own(value, "truncated"); return parsed(treeOutput, { sessionId: own(value, "sessionId"), nodes: nodes.map(item => ({ path: own(item, "path"), name: own(item, "name"), type: own(item, "type"), depth: own(item, "depth") })), truncated: { nodes: own(truncation, "nodes"), depth: own(truncation, "depth") } }); }
function normalizeNode(value: unknown) { const properties = own(value, "properties"); const omitted = dataArray(own(value, "omittedProperties"), 64); return parsed(nodeOutput, { sessionId: own(value, "sessionId"), path: own(value, "path"), type: own(value, "type"), properties: copyJsonObject(properties, new Set(), 0), omittedProperties: omitted }); }
function normalizeInput(value: unknown) { return parsed(inputOutput, { sessionId: own(value, "sessionId"), accepted: own(value, "accepted") }); }
function normalizeScreenshot(value: unknown) { return parsed(screenshotOutput, { sessionId: own(value, "sessionId"), path: own(value, "path"), absolutePath: own(value, "absolutePath"), width: own(value, "width"), height: own(value, "height"), bytes: own(value, "bytes"), sha256: own(value, "sha256"), format: own(value, "format") }); }
function optionalOwn(value: unknown, key: string): unknown { let descriptor: PropertyDescriptor | undefined; try { descriptor = (typeof value === "object" && value !== null) ? Object.getOwnPropertyDescriptor(value, key) : undefined; } catch { throw malformed(); } if (!descriptor) return undefined; if (!("value" in descriptor)) throw malformed(); return descriptor.value; }
function malformed() { return new GodotMcpError("godot_error", "Runtime service returned an invalid response.", "Check that the runtime coordinator and MCP server versions are compatible."); }
function bridgeOperation<T extends (...args: any[]) => Promise<unknown>>(owner: RuntimeToolService, operation: T | undefined): T { if (!operation) throw new GodotMcpError("not_connected", "The runtime bridge is not configured.", "Launch a runtime session with an attached bridge before using runtime bridge tools."); return operation.bind(owner) as T; }
function copyJsonObject(value: unknown, seen: Set<object>, depth: number): Record<string, z.infer<ReturnType<typeof z.json>>> { if (!value || typeof value !== "object") throw malformed(); let descriptors: PropertyDescriptorMap; try { if (Array.isArray(value)) throw malformed(); descriptors = Object.getOwnPropertyDescriptors(value); } catch { throw malformed(); } if (seen.has(value)) throw malformed(); seen.add(value); try { const output: Record<string, any> = Object.create(null); for (const [key, descriptor] of Object.entries(descriptors)) { if (descriptor.enumerable) { if (!("value" in descriptor)) throw malformed(); output[key] = copyJson(descriptor.value, seen, depth + 1); } } return output; } finally { seen.delete(value); } }
function copyJson(value: unknown, seen: Set<object>, depth: number): any { if (depth > 32) throw malformed(); if (value === null || typeof value === "boolean" || typeof value === "string") return value; if (typeof value === "number" && Number.isFinite(value)) return value; if (typeof value !== "object") throw malformed(); let array = false; try { array = Array.isArray(value); } catch { throw malformed(); } if (array) { if (seen.has(value)) throw malformed(); seen.add(value); try { return dataArray(value, 500).map(item => copyJson(item, seen, depth + 1)); } finally { seen.delete(value); } } return copyJsonObject(value, seen, depth); }
function dataArray(value: unknown, maximum: number): unknown[] { let descriptors: Record<string, PropertyDescriptor>; try { if (!Array.isArray(value)) throw malformed(); descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>; } catch { throw malformed(); } const length = descriptors.length; if (!length || !("value" in length) || !Number.isInteger(length.value) || length.value < 0 || length.value > maximum) throw malformed(); const output: unknown[] = []; for (let index = 0; index < length.value; index++) { const descriptor = descriptors[String(index)]; if (!descriptor || !("value" in descriptor)) throw malformed(); output.push(descriptor.value); } return output; }

function validateArguments(values: string[] | undefined): void {
  if (values && Buffer.byteLength(values.join(""), "utf8") > 8192) throw new GodotMcpError("invalid_args", "Runtime arguments exceed 8192 total UTF-8 bytes.", "Reduce the number or size of runtime arguments.");
}
