import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";

const SESSION = "a".repeat(32);
async function harness(debug?: any) {
  const server = createServer({ debug });
  const client = new Client({ name: "debug-tools", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

describe("public debug tools", () => {
  it("registers exactly six reviewed tools, strict schemas, and annotations", async () => {
    const h = await harness();
    try {
      const tools = (await h.client.listTools()).tools.filter(tool => tool.name.startsWith("godot_debug_"));
      expect(tools.map(tool => tool.name)).toEqual([
        "godot_debug_launch", "godot_debug_set_breakpoints", "godot_debug_continue",
        "godot_debug_step", "godot_debug_stack", "godot_debug_inspect",
      ]);
      expect(tools.map(tool => tool.annotations)).toEqual([
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      ]);
      for (const tool of tools) expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      for (const tool of tools) expect(tool.outputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tools.map(tool => Object.keys((tool.outputSchema as any).properties))).toEqual([
        ["sessionId", "mode", "state", "pid", "startedAt", "bridgeTransport", "capabilities"],
        ["sessionId", "path", "breakpoints"],
        ["sessionId", "resumed"],
        ["sessionId", "kind", "resumed"],
        ["sessionId", "stoppedGeneration", "threads", "frames", "totalFrames", "truncated"],
        ["sessionId", "stoppedGeneration", "scopes", "variables", "next", "truncated"],
      ]);
      expect((tools[3].inputSchema as any).properties.kind.enum).toEqual(["over", "into"]);
      const unavailable = await h.client.callTool({ name: "godot_debug_launch", arguments: {} });
      expect(unavailable.isError).toBe(true); expect(unavailable.structuredContent).toBeUndefined();
      expect(JSON.parse((unavailable.content[0] as any).text)).toMatchObject({ code: "not_connected" });
    } finally { await h.close(); }
  });

  it("maps all operations and emits only own normalized data", async () => {
    const ref = { runtimeSessionId: SESSION, stoppedGeneration: 2, id: 7 };
    const debug = {
      debugLaunch: vi.fn().mockResolvedValue({ id: SESSION, mode: "debug", state: "debug_ready", pid: 3, startedAt: 4, capabilities: { supportsConfigurationDoneRequest: true, supportsTerminateRequest: false, supportsVariablePaging: true, secretCapability: "drop" } }),
      debugSetBreakpoints: vi.fn().mockResolvedValue({ sessionId: SESSION, path: "phase5/runtime_fixture.gd", breakpoints: [{ line: 12, verified: true }] }),
      debugContinue: vi.fn().mockResolvedValue({ sessionId: SESSION, resumed: true }),
      debugStep: vi.fn().mockResolvedValue({ sessionId: SESSION, kind: "over", resumed: true }),
      debugStack: vi.fn().mockResolvedValue({ sessionId: SESSION, stoppedGeneration: 2, threads: [{ id: 1, name: "Main", ref }], frames: [{ id: 7, name: "jump", line: 12, column: 0, ref, source: { path: "res://phase5/runtime_fixture.gd" } }], truncated: false }),
      debugInspect: vi.fn().mockResolvedValue({ sessionId: SESSION, stoppedGeneration: 2, variables: [{ name: "phase5_value", value: "42", type: "int", ref: { ...ref, id: 0 } }], truncated: false }),
    };
    const h = await harness(debug);
    try {
      expect((await h.client.callTool({ name: "godot_debug_launch", arguments: { scene: "res://phase5/main.tscn", initialBreakpoints: [{ path: "phase5/runtime_fixture.gd", lines: [12] }], timeoutMs: 5000 } })).structuredContent).toMatchObject({ sessionId: SESSION, state: "debug_ready", pid: 3, capabilities: { supportsConfigurationDoneRequest: true, supportsTerminateRequest: false, supportsVariablePaging: true } });
      expect(debug.debugLaunch).toHaveBeenCalledWith(expect.objectContaining({ initialBreakpoints: [{ path: "phase5/runtime_fixture.gd", lines: [12] }] }));
      await h.client.callTool({ name: "godot_debug_set_breakpoints", arguments: { sessionId: SESSION, path: "phase5/runtime_fixture.gd", lines: [12] } });
      await h.client.callTool({ name: "godot_debug_continue", arguments: { sessionId: SESSION, thread: ref } });
      await h.client.callTool({ name: "godot_debug_step", arguments: { sessionId: SESSION, thread: ref, kind: "over" } });
      const stack = await h.client.callTool({ name: "godot_debug_stack", arguments: { sessionId: SESSION, thread: ref, startFrame: 0 } });
      const inspect = await h.client.callTool({ name: "godot_debug_inspect", arguments: { sessionId: SESSION, frame: ref, variables: ref, start: 0 } });
      expect(debug.debugSetBreakpoints).toHaveBeenCalledWith(SESSION, "phase5/runtime_fixture.gd", [12]);
      expect(stack.structuredContent).not.toHaveProperty("secret"); expect(inspect.structuredContent).not.toHaveProperty("secret");
      expect(JSON.stringify(inspect.structuredContent)).toContain("42");
    } finally { await h.close(); }
  });

  it("rejects traversal, duplicate lines, invalid references, and unsupported step kinds", async () => {
    const h = await harness({ debugLaunch: vi.fn(), debugSetBreakpoints: vi.fn(), debugContinue: vi.fn(), debugStep: vi.fn(), debugStack: vi.fn(), debugInspect: vi.fn() });
    try {
      const cases = [
        ["godot_debug_set_breakpoints", { sessionId: SESSION, path: "../escape.gd", lines: [1] }],
        ["godot_debug_set_breakpoints", { sessionId: SESSION, path: "a.gd", lines: [1, 1] }],
        ["godot_debug_continue", { sessionId: SESSION, thread: { runtimeSessionId: SESSION, stoppedGeneration: -1, id: 1 } }],
        ["godot_debug_step", { sessionId: SESSION, thread: 1, kind: "out" }],
      ] as const;
      for (const [name, args] of cases) { const result = await h.client.callTool({ name, arguments: args as any }); expect(result.isError).toBe(true); expect(result.structuredContent).toBeUndefined(); }
    } finally { await h.close(); }
  });

  it("rejects debug-service output outside the reviewed strict contract", async () => {
    const h = await harness({ debugLaunch: vi.fn(), debugSetBreakpoints: vi.fn(), debugContinue: vi.fn().mockResolvedValue({ sessionId: SESSION, resumed: true, secret: "leak" }), debugStep: vi.fn(), debugStack: vi.fn(), debugInspect: vi.fn() });
    try {
      const result = await h.client.callTool({ name: "godot_debug_continue", arguments: { sessionId: SESSION, thread: { runtimeSessionId: SESSION, stoppedGeneration: 1, id: 1 } } });
      expect(result.isError).toBe(true); expect(result.structuredContent).toBeUndefined(); expect(JSON.stringify(result.content)).not.toContain("leak");
    } finally { await h.close(); }
  });
});
