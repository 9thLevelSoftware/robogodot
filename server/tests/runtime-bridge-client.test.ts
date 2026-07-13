import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeBridgeClient } from "../src/runtime/bridge-client.js";
import { encodeFrame, FrameDecoder } from "../src/runtime/bridge-protocol.js";
import { MockRuntimeBridge } from "./mock-runtime-bridge.js";

const roots: string[] = [];
const SESSION = "0123456789abcdef0123456789abcdef";
const TOKEN = "t".repeat(64);

async function fixture(port: number) {
  const userRoot = await mkdtemp(join(tmpdir(), "robogodot-runtime-")); roots.push(userRoot);
  const sessionRoot = join(userRoot, ".mcp", SESSION); await mkdir(sessionRoot, { recursive: true });
  const configPath = join(sessionRoot, "bridge-config-v1.json");
  await writeFile(configPath, JSON.stringify({ version: 1, protocolVersion: 1, sessionId: SESSION, token: TOKEN, preferredPort: port }));
  return { sessionId: SESSION, userRoot, sessionRoot, manifestVersion: 1, launcherResource: "res://addons/godot_control_mcp/runtime/runtime_launcher.gd", bridgeResource: "res://addons/godot_control_mcp/runtime/bridge_manifest.gd", args: ["--script", "x", "--", "--mcp-runtime-config", configPath] } as const;
}

afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

describe("runtime bridge protocol", () => {
  it("decodes partial and coalesced bounded frames", () => {
    const decoder = new FrameDecoder(); const a = encodeFrame({ a: 1 }); const b = encodeFrame({ b: 2 });
    expect(decoder.push(a.subarray(0, 3))).toEqual([]);
    expect(decoder.push(Buffer.concat([a.subarray(3), b]))).toEqual([{ a: 1 }, { b: 2 }]);
    expect(() => new FrameDecoder().push(Buffer.from([0, 16, 0, 1]))).toThrow(/frame/i);
  });
});

describe("RuntimeBridgeClient", () => {
  it("authenticates a versioned socket and ignores stale, duplicate, and wrong-session replies", async () => {
    const bridge = await MockRuntimeBridge.socket({ sessionId: SESSION, token: TOKEN });
    const client = new RuntimeBridgeClient(); expect(await client.connect(await fixture(bridge.port))).toBe("socket");
    bridge.beforeResponse = request => [{ ...request, type: "response", id: request.id - 1, result: "stale" }, { ...request, type: "response", sessionId: "f".repeat(32), result: "wrong" }];
    await expect(client.request(SESSION, "runtime.scene_tree", {}, 1000)).resolves.toEqual({ ok: true });
    await client.close(); await bridge.close();
  });

  it("falls back only before publication and never replays a published request", async () => {
    const config = await fixture(65534); const bridge = await MockRuntimeBridge.file({ sessionId: SESSION, token: TOKEN, sessionRoot: config.sessionRoot });
    const client = new RuntimeBridgeClient(); expect(await client.connect(config)).toBe("file");
    await expect(client.request(SESSION, "runtime.get_node", {}, 1000)).resolves.toEqual({ ok: true });
    expect(bridge.requests).toHaveLength(1); await client.close(); await bridge.close();
  });

  it("bounds pending requests, uses monotonic IDs, normalizes output, and cancels on close", async () => {
    const bridge = await MockRuntimeBridge.socket({ sessionId: SESSION, token: TOKEN, hold: true });
    const client = new RuntimeBridgeClient(); await client.connect(await fixture(bridge.port));
    const pending = Array.from({ length: 32 }, () => client.request(SESSION, "runtime.scene_tree", {}, 5000));
    await expect(client.request(SESSION, "runtime.scene_tree", {}, 5000)).rejects.toThrow(/pending/i);
    for (let i = 0; i < 50 && bridge.ids.length < 32; i++) await new Promise(resolve => setTimeout(resolve, 2));
    await client.close(); await expect(Promise.all(pending)).rejects.toThrow(/closed/i);
    expect(bridge.ids).toEqual(Array.from({ length: 32 }, (_, i) => i + 1)); await bridge.close();
  });
});
