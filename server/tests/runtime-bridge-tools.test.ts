import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { link, lstat, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RuntimeSessionCoordinator } from "../src/runtime/session.js";

const SESSION = "a".repeat(32);
async function harness(runtime: any) {
  const server = createServer({ runtime }); const client = new Client({ name: "runtime-bridge", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const base = () => ({ launch: vi.fn(), stop: vi.fn(), output: vi.fn() });
const makePng = (width = 8, height = 6, bytes = 24) => { const png = Buffer.alloc(bytes); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.write("IHDR", 12, "ascii"); png.writeUInt32BE(width, 16); png.writeUInt32BE(height, 20); return png; };
async function coordinatorHarness(root: string, request: (session: string, method: string, params: unknown) => Promise<unknown>, dependencies: Record<string, unknown> = {}) {
  const managed = { childId: "child", pid: 42, startedAt: 100, running: true, output: vi.fn() };
  const runner = { start: vi.fn().mockResolvedValue(managed), stop: vi.fn().mockResolvedValue({ childId: "child", alreadyStopped: false, graceful: true, forced: false }), stopCurrent: vi.fn() };
  const coordinator = new RuntimeSessionCoordinator({ runner: runner as any, sessionId: () => SESSION, ...dependencies } as any); const session = await coordinator.launch("normal", { godotPath: "godot", projectPath: "game" });
  const bridge = { close: vi.fn(), request: vi.fn(request) }; coordinator.attachBridge(session.id, bridge, root); const h = await harness(coordinator);
  return { ...h, coordinator, bridge, runner, dispose: async () => { await h.close(); await coordinator.stop(SESSION); } };
}
function errorPayload(result: any) { expect(result.isError).toBe(true); expect(result.structuredContent).toBeUndefined(); return JSON.parse(result.content[0].text); }

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

  it("accepts exactly 256 UTF-8 bytes and rejects byte 257 for bridge names", async () => {
    const runtime = { ...base(), getNode: vi.fn().mockResolvedValue({ sessionId: SESSION, path: ".", type: "Node", properties: {}, omittedProperties: [] }), input: vi.fn().mockResolvedValue({ sessionId: SESSION, accepted: true }), screenshot: vi.fn().mockResolvedValue({ sessionId: SESSION, path: "shots/a.png", absolutePath: "C:/safe/a.png", width: 1, height: 1, bytes: 24, sha256: "b".repeat(64), format: "png" }) };
    const h = await harness(runtime); try {
      const property256 = "é".repeat(128), action256 = "é".repeat(128), screenshot256 = `${"é".repeat(126)}.png`;
      for (const [name, args] of [["godot_runtime_get_node", { sessionId: SESSION, path: ".", properties: [property256] }], ["godot_runtime_input", { sessionId: SESSION, kind: "action", action: action256, mode: "press" }], ["godot_runtime_screenshot", { sessionId: SESSION, name: screenshot256 }]] as const) expect((await h.client.callTool({ name, arguments: args as any })).isError).not.toBe(true);
      for (const [name, args] of [["godot_runtime_get_node", { sessionId: SESSION, path: ".", properties: [`${property256}a`] }], ["godot_runtime_input", { sessionId: SESSION, kind: "action", action: `${action256}a`, mode: "press" }], ["godot_runtime_screenshot", { sessionId: SESSION, name: `${"é".repeat(127)}.png` }]] as const) expect((await h.client.callTool({ name, arguments: args as any })).isError).toBe(true);
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
    const png = makePng(); const shot = join(shots, "a.png"); await writeFile(shot, png);
    const h = await coordinatorHarness(root, async (_session, method) => method === "runtime.scene_tree" ? { nodes: [{ path: ".", name: "Root", type: "Node", depth: 0 }], truncated: false } : method === "runtime.get_node" ? { path: ".", type: "Node", properties: { name: "Root" } } : method === "runtime.input" ? { ok: true } : { path: shot, format: "png", width: 8, height: 6, bytes: png.length });
    try {
      const result = await h.client.callTool({ name: "godot_runtime_screenshot", arguments: { sessionId: SESSION, name: "a.png" } });
      expect(result).toMatchObject({ structuredContent: { sessionId: SESSION, path: "shots/a.png", absolutePath: shot, width: 8, height: 6, bytes: 24, format: "png" } });
      expect((result.structuredContent as any).sha256).toMatch(/^[a-f0-9]{64}$/);
      const stale = await h.client.callTool({ name: "godot_runtime_scene_tree", arguments: { sessionId: "b".repeat(32) } }); expect(stale.isError).toBe(true); expect(JSON.parse((stale.content as any)[0].text).code).toBe("invalid_args");
    } finally { await h.dispose(); await rm(root, { recursive: true, force: true }); }
    expect(h.bridge.close.mock.invocationCallOrder[0]).toBeLessThan(h.runner.stop.mock.invocationCallOrder[0]!);
  });

  it("declares coordinator-backed node/depth truncation and every property omission", async () => {
    const root = await mkdtemp(join(tmpdir(), "robogodot-data-")); const h = await coordinatorHarness(root, async (_session, method) => method === "runtime.scene_tree" ? { nodes: [{ path: ".", name: "Root", type: "Node", depth: 0 }, { path: "Child", name: "Child", type: "Node", depth: 2 }], truncated: true } : { path: ".", type: "Node", properties: { name: "Root", invalid: Number.NaN } });
    try {
      const tree = await h.client.callTool({ name: "godot_runtime_scene_tree", arguments: { sessionId: SESSION, maxDepth: 2 } }); expect(tree.structuredContent).toMatchObject({ truncated: { nodes: true, depth: true } });
      const node = await h.client.callTool({ name: "godot_runtime_get_node", arguments: { sessionId: SESSION, path: ".", properties: ["name", "missing", "invalid"] } }); expect(node.structuredContent).toEqual({ sessionId: SESSION, path: ".", type: "Node", properties: { name: "Root" }, omittedProperties: ["missing", "invalid"] });
    } finally { await h.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it("maps malformed accessor/proxy data, deadlines, and bridge errors without leaking payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "robogodot-errors-")); let mode = "accessor"; let getterReads = 0;
    const h = await coordinatorHarness(root, async () => { if (mode === "accessor") { const raw = { truncated: false }; Object.defineProperty(raw, "nodes", { get() { getterReads++; return []; } }); return raw; } if (mode === "proxy") { const revoked = Proxy.revocable({}, {}); revoked.revoke(); return revoked.proxy; } if (mode === "timeout") throw new Error("request deadline exceeded token-secret"); return { error: "token-secret" }; });
    try {
      let result = await h.client.callTool({ name: "godot_runtime_scene_tree", arguments: { sessionId: SESSION } }); expect(errorPayload(result)).toMatchObject({ code: "godot_error", message: "Runtime bridge returned an invalid response." }); expect(getterReads).toBe(0);
      mode = "proxy"; result = await h.client.callTool({ name: "godot_runtime_scene_tree", arguments: { sessionId: SESSION } }); expect(errorPayload(result).code).toBe("godot_error");
      mode = "timeout"; result = await h.client.callTool({ name: "godot_runtime_scene_tree", arguments: { sessionId: SESSION } }); expect(errorPayload(result)).toMatchObject({ code: "timeout", message: "The runtime bridge request failed." });
      mode = "bridge"; result = await h.client.callTool({ name: "godot_runtime_scene_tree", arguments: { sessionId: SESSION } }); const bridgeError = errorPayload(result); expect(bridgeError).toMatchObject({ code: "godot_error", message: "The runtime bridge operation failed." }); expect(JSON.stringify(bridgeError)).not.toContain("token-secret");
    } finally { await h.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it("rejects escaped, linked, non-regular, malformed, mismatched, and oversized screenshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "robogodot-shot-bad-")); const shots = join(root, "shots"); await mkdir(shots); const outsideRoot = await mkdtemp(join(tmpdir(), "robogodot-outside-"));
    const valid = makePng(); const outside = join(outsideRoot, "outside.png"); await writeFile(outside, valid); const hardlink = join(shots, "hard.png"); await link(outside, hardlink);
    const badSignature = join(shots, "signature.png"); await writeFile(badSignature, Buffer.alloc(24)); const badDimensions = join(shots, "dimensions.png"); await writeFile(badDimensions, valid);
    const sizeMismatch = join(shots, "size.png"); await writeFile(sizeMismatch, valid); const directory = join(shots, "directory.png"); await mkdir(directory); const oversized = join(shots, "oversized.png"); await writeFile(oversized, makePng(8, 6, 16 * 1024 * 1024 + 1));
    let response = { path: outside, format: "png", width: 8, height: 6, bytes: valid.length }; const h = await coordinatorHarness(root, async () => response);
    try {
      const rejected = async () => { const result = await h.client.callTool({ name: "godot_runtime_screenshot", arguments: { sessionId: SESSION } }); expect(errorPayload(result).code).toBe("godot_error"); };
      await rejected(); response = { path: hardlink, format: "png", width: 8, height: 6, bytes: valid.length }; await rejected();
      response = { path: directory, format: "png", width: 8, height: 6, bytes: valid.length }; await rejected(); response = { path: badSignature, format: "png", width: 8, height: 6, bytes: 24 }; await rejected();
      response = { path: badDimensions, format: "png", width: 9, height: 6, bytes: 24 }; await rejected(); response = { path: sizeMismatch, format: "png", width: 8, height: 6, bytes: 23 }; await rejected();
      response = { path: oversized, format: "png", width: 8, height: 6, bytes: 16 * 1024 * 1024 + 1 }; await rejected();
      const symbolic = join(shots, "symbolic.png"); try { await symlink(sizeMismatch, symbolic, "file"); response = { path: symbolic, format: "png", width: 8, height: 6, bytes: valid.length }; await rejected(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error; }
    } finally { await h.dispose(); await rm(root, { recursive: true, force: true }); await rm(outsideRoot, { recursive: true, force: true }); }
  });

  it("rejects a same-handle screenshot mutation detected after the bounded read", async () => {
    const root = await mkdtemp(join(tmpdir(), "robogodot-shot-race-")); const shot = join(root, "race.png"); const png = makePng(); await writeFile(shot, png); const identity = await lstat(shot); let statCalls = 0;
    const fakeHandle = { stat: vi.fn(async () => ({ dev: identity.dev, ino: identity.ino, nlink: ++statCalls === 1 ? 1 : 2, size: png.length, mtimeMs: identity.mtimeMs })), read: vi.fn(async (target: Buffer) => { png.copy(target); return { bytesRead: png.length, buffer: target }; }), close: vi.fn() };
    const h = await coordinatorHarness(root, async () => ({ path: shot, format: "png", width: 8, height: 6, bytes: png.length }), { screenshotOpen: vi.fn().mockResolvedValue(fakeHandle) });
    try { const result = await h.client.callTool({ name: "godot_runtime_screenshot", arguments: { sessionId: SESSION } }); expect(errorPayload(result)).toMatchObject({ code: "godot_error", message: "Runtime screenshot verification failed." }); expect(fakeHandle.read).toHaveBeenCalledOnce(); }
    finally { await h.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it("lstats and rejects the lexical raw screenshot candidate before realpath resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "robogodot-shot-raw-link-")); const raw = join(root, "raw-link.png");
    const screenshotLstat = vi.fn(async (path: string) => path === resolve(raw)
      ? { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => true, nlink: 1, size: 24 }
      : { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, nlink: 1, size: 0 });
    const h = await coordinatorHarness(root, async () => ({ path: "raw-link.png", format: "png", width: 8, height: 6, bytes: 24 }), { screenshotLstat });
    try {
      const result = await h.client.callTool({ name: "godot_runtime_screenshot", arguments: { sessionId: SESSION } }); expect(errorPayload(result)).toMatchObject({ code: "godot_error", message: "Runtime screenshot verification failed." });
      expect(screenshotLstat).toHaveBeenCalledWith(resolve(raw));
    } finally { await h.dispose(); await rm(root, { recursive: true, force: true }); }
  });
});
