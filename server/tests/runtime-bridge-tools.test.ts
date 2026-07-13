import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeSessionCoordinator } from "../src/runtime/session.js";

const SESSION = "a".repeat(32);
async function harness(runtime: any) {
  const server = createServer({ runtime }); const client = new Client({ name: "runtime-bridge", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const base = () => ({ launch: vi.fn(), stop: vi.fn(), output: vi.fn() });

describe("public runtime bridge tools", () => {
  it("registers four reviewed tools after process tools with exact annotations", async () => {
    const h = await harness(base()); try {
      const tools = (await h.client.listTools()).tools.filter(t => t.name.startsWith("godot_runtime_"));
      expect(tools.map(t => t.name)).toEqual(["godot_runtime_scene_tree", "godot_runtime_get_node", "godot_runtime_input", "godot_runtime_screenshot"]);
      expect(tools.map(t => t.annotations)).toEqual([
        { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      ]);
    } finally { await h.close(); }
  });

  it("dispatches bounded inputs and publishes exact normalized own-data outputs", async () => {
    const inherited = Object.create({ token: "leak" }); Object.assign(inherited, { sessionId: SESSION, nodes: [{ path: ".", name: "Root", type: "Node", depth: 0, extra: true }], truncated: { nodes: false, depth: true }, extra: true });
    const runtime = { ...base(), sceneTree: vi.fn().mockResolvedValue(inherited), getNode: vi.fn().mockResolvedValue({ sessionId: SESSION, path: ".", type: "Node", properties: { name: "Root" }, omittedProperties: ["script"], secret: "leak" }), input: vi.fn().mockResolvedValue({ sessionId: SESSION, accepted: true }), screenshot: vi.fn().mockResolvedValue({ sessionId: SESSION, path: "shots/a.png", absolutePath: "C:/safe/a.png", width: 8, height: 6, bytes: 80, sha256: "b".repeat(64), format: "png" }) };
    const h = await harness(runtime); try {
      for (const [name, arguments_] of [
        ["godot_runtime_scene_tree", { sessionId: SESSION, maxDepth: 4 }],
        ["godot_runtime_get_node", { sessionId: SESSION, path: ".", properties: ["name", "script"] }],
        ["godot_runtime_input", { sessionId: SESSION, kind: "action", action: "jump", mode: "press_release", holdMs: 20 }],
        ["godot_runtime_screenshot", { sessionId: SESSION, name: "a.png" }],
      ] as const) {
        const result = await h.client.callTool({ name, arguments: arguments_ }); expect(result.isError).not.toBe(true);
        expect(JSON.parse((result.content as any)[0].text)).toEqual(result.structuredContent); expect(JSON.stringify(result.structuredContent)).not.toMatch(/secret|token|extra/);
      }
      expect(runtime.sceneTree).toHaveBeenCalledWith(SESSION, 4); expect(runtime.getNode).toHaveBeenCalledWith(SESSION, ".", ["name", "script"]);
    } finally { await h.close(); }
  });

  it("rejects byte bounds, union overlap, and invalid ranges before dispatch", async () => {
    const runtime = { ...base(), sceneTree: vi.fn(), getNode: vi.fn(), input: vi.fn(), screenshot: vi.fn() }; const h = await harness(runtime);
    try {
      const bad: Array<[string, any]> = [
        ["godot_runtime_scene_tree", { sessionId: "é".repeat(65), maxDepth: 1 }],
        ["godot_runtime_scene_tree", { sessionId: SESSION, maxDepth: 33 }],
        ["godot_runtime_get_node", { sessionId: SESSION, path: "é".repeat(513) }],
        ["godot_runtime_get_node", { sessionId: SESSION, path: ".", properties: ["é".repeat(129)] }],
        ["godot_runtime_input", { sessionId: SESSION, kind: "action", action: "jump", mode: "press", keycode: 1 }],
        ["godot_runtime_input", { sessionId: SESSION, kind: "key", keycode: 1, pressed: true, holdMs: 2001 }],
        ["godot_runtime_input", { sessionId: SESSION, kind: "mouse_button", button: 6, pressed: true }],
      ];
      for (const [name, arguments_] of bad) { const result = await h.client.callTool({ name, arguments: arguments_ }); expect(result).toMatchObject({ isError: true }); expect(result.structuredContent).toBeUndefined(); }
      expect(runtime.sceneTree).not.toHaveBeenCalled(); expect(runtime.getNode).not.toHaveBeenCalled(); expect(runtime.input).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it("returns stable bridge-unavailable errors without structured content", async () => {
    const h = await harness(base()); try {
      const result = await h.client.callTool({ name: "godot_runtime_scene_tree", arguments: { sessionId: SESSION } });
      expect(result).toMatchObject({ isError: true }); expect(result.structuredContent).toBeUndefined();
      expect(JSON.parse((result.content as any)[0].text)).toEqual({ code: "not_connected", message: "The runtime bridge is not configured.", hint: "Launch a runtime session with an attached bridge before using runtime bridge tools." });
    } finally { await h.close(); }
  });

  it("binds bridge operations to the active session and verifies a contained PNG", async () => {
    const root = await mkdtemp(join(tmpdir(), "robogodot-shot-")); const shots = join(root, "shots"); await mkdir(shots);
    const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.write("IHDR", 12, "ascii"); png.writeUInt32BE(8, 16); png.writeUInt32BE(6, 20); const shot = join(shots, "a.png"); await writeFile(shot, png);
    const managed = { childId: "child", pid: 42, startedAt: 100, running: true, output: vi.fn() };
    const coordinator = new RuntimeSessionCoordinator({ runner: { start: vi.fn().mockResolvedValue(managed), stop: vi.fn().mockResolvedValue({ childId: "child", alreadyStopped: false, graceful: true, forced: false }), stopCurrent: vi.fn() } as any, sessionId: () => SESSION });
    const session = await coordinator.launch("normal", { godotPath: "godot", projectPath: "game" });
    const bridge = { close: vi.fn(), request: vi.fn(async (_session: string, method: string) => method === "runtime.scene_tree" ? { nodes: [{ path: ".", name: "Root", type: "Node", depth: 0 }], truncated: false } : method === "runtime.get_node" ? { path: ".", type: "Node", properties: { name: "Root" } } : method === "runtime.input" ? { ok: true } : { path: shot, format: "png", width: 8, height: 6, bytes: png.length }) };
    coordinator.attachBridge(session.id, bridge, root); const h = await harness(coordinator);
    try {
      const result = await h.client.callTool({ name: "godot_runtime_screenshot", arguments: { sessionId: SESSION, name: "a.png" } });
      expect(result).toMatchObject({ structuredContent: { sessionId: SESSION, path: "shots/a.png", absolutePath: shot, width: 8, height: 6, bytes: 24, format: "png" } });
      expect((result.structuredContent as any).sha256).toMatch(/^[a-f0-9]{64}$/);
      const stale = await h.client.callTool({ name: "godot_runtime_scene_tree", arguments: { sessionId: "b".repeat(32) } }); expect(stale.isError).toBe(true); expect(JSON.parse((stale.content as any)[0].text).code).toBe("invalid_args");
    } finally { await h.close(); await coordinator.stop(SESSION); await rm(root, { recursive: true, force: true }); }
    expect(bridge.close.mock.invocationCallOrder[0]).toBeLessThan((coordinator.runner.stop as any).mock.invocationCallOrder[0]);
  });
});
