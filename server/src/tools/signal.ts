import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CoreBridge } from "./core.js";
import { registerTool } from "../registry.js";
import { callCurated } from "./curated-shared.js";
import { MutationLane } from "../mutation/lane.js";

const utf8 = (label: string, max: number) => z.string().min(1).refine(v => Buffer.byteLength(v, "utf8") <= max, `${label} exceeds ${max} UTF-8 bytes`);
const nodePath = utf8("NodePath", 1024), signalName = utf8("signal name", 256), methodName = utf8("callable method", 256);
const callable = z.object({ target: nodePath, method: methodName }).strict();
const connection = z.object({ callable, flags: z.number().int().nonnegative() }).strict();
const signal = z.object({ name: signalName, arguments: z.array(z.object({ name: z.string(), type: z.number().int() }).strict()).max(64), connections: z.array(connection).max(256) }).strict();
const listOutput = z.object({ signals: z.array(signal).max(500), truncated: z.boolean(), nextCursor: z.string().optional() }).strict();
const mutationOutput = z.object({ source: nodePath, signal: signalName, callable, flags: z.number().int().nonnegative() }).strict();
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const mutate = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

export function registerSignalTools(server: McpServer, bridge: CoreBridge, lane: MutationLane): void {
  registerTool(server, { name: "godot_signal_list", description: "List a deterministic bounded page of live signals and connections.", inputSchema: z.object({ path: nodePath, cursor: z.string().regex(/^(0|[1-9][0-9]*)$/).max(10).optional(), limit: z.number().int().min(1).max(500).default(100) }).strict(), outputSchema: listOutput, annotations: read, handler: i => callCurated(bridge, "edit.signal_list", i, listOutput) });
  for (const [name, method] of [["godot_signal_connect", "edit.signal_connect"], ["godot_signal_disconnect", "edit.signal_disconnect"]] as const)
    registerTool(server, { name, description: "Undoable signal connection mutation.", inputSchema: z.object({ source: nodePath, signal: signalName, callable, flags: z.number().int().nonnegative().default(0) }).strict(), outputSchema: mutationOutput, annotations: mutate, handler: (i: any) => lane.run(["signals", `node:${i.source}`, `node:${i.callable.target}`], () => callCurated(bridge, method, i, mutationOutput)) });
}
