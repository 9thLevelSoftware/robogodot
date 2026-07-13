import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeBootstrap } from "../src/runtime/bootstrap.js";

const roots: string[] = [];
const SESSION = "0123456789abcdef0123456789abcdef";
const TOKEN = "t".repeat(64);
const SCENE = "res://test_scene.tscn";

async function fixture() {
  const userRoot = await mkdtemp(join(tmpdir(), "robogodot-bootstrap-")); roots.push(userRoot);
  const approvedRoot = join(userRoot, ".mcp"); const sessionRoot = join(approvedRoot, SESSION);
  await mkdir(sessionRoot, { recursive: true });
  const launcherPath = resolve("../addons/godot_control_mcp/runtime/runtime_launcher.gd");
  const bridgePath = resolve("../addons/godot_control_mcp/runtime/bridge_manifest.gd");
  const result = { userRoot, sessionRoot, manifestVersion: 1, launcherPath, bridgePath };
  const bridge = { call: vi.fn().mockResolvedValue(result) };
  return { userRoot, approvedRoot, sessionRoot, result, bridge };
}

afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("RuntimeBootstrap", () => {
  it("uses the authenticated bounded RPC and returns token-free fixed launcher arguments", async () => {
    const f = await fixture(); const bootstrap = new RuntimeBootstrap(f.bridge);
    const config = await bootstrap.prepare({ sessionId: SESSION, token: TOKEN, protocolVersion: 1, preferredPort: 9301, scene: SCENE });
    expect(f.bridge.call).toHaveBeenCalledWith("runtime.prepare", { sessionId: SESSION, token: TOKEN, protocolVersion: 1, preferredPort: 9301, scene: SCENE }, { timeoutMs: 15_000, maxRequestBytes: 32_768 });
    expect(config).toEqual(expect.objectContaining({ sessionId: SESSION, userRoot: f.userRoot, sessionRoot: f.sessionRoot, manifestVersion: 1, launcherResource: "res://addons/godot_control_mcp/runtime/runtime_launcher.gd", bridgeResource: "res://addons/godot_control_mcp/runtime/bridge_manifest.gd" }));
    expect(config.args).toEqual(["--script", "res://addons/godot_control_mcp/runtime/runtime_launcher.gd", "--", "--mcp-runtime-config", expect.any(String)]);
    expect(JSON.stringify(config)).not.toContain(TOKEN);
    expect(config.args.join(" ")).not.toContain(TOKEN);
    const stored = JSON.parse(await readFile(config.args[4]!, "utf8"));
    expect(stored).toEqual({ version: 1, sessionId: SESSION, token: TOKEN, protocolVersion: 1, preferredPort: 9301, scene: SCENE, launcherResource: config.launcherResource, bridgeResource: config.bridgeResource });
  });

  it.each([
    ["session traversal", { sessionId: "../escape", token: TOKEN }],
    ["short session", { sessionId: "short", token: TOKEN }],
    ["short token", { sessionId: SESSION, token: "short" }],
    ["oversized token", { sessionId: SESSION, token: "x".repeat(257) }],
  ])("rejects %s before RPC", async (_name, values) => {
    const f = await fixture(); const bootstrap = new RuntimeBootstrap(f.bridge);
    await expect(bootstrap.prepare({ ...values, protocolVersion: 1, preferredPort: 9301, scene: SCENE })).rejects.toThrow();
    expect(f.bridge.call).not.toHaveBeenCalled();
  });

  it("strictly parses the response and rejects a manifest mismatch", async () => {
    const f = await fixture(); const bootstrap = new RuntimeBootstrap(f.bridge);
    f.bridge.call.mockResolvedValueOnce({ ...f.result, extra: true });
    await expect(bootstrap.prepare({ sessionId: SESSION, token: TOKEN, protocolVersion: 1, preferredPort: 9301, scene: SCENE })).rejects.toThrow("response");
  });

  it("cleans the exact plugin-created session after a manifest mismatch", async () => {
    const f = await fixture(); const bootstrap = new RuntimeBootstrap(f.bridge);
    f.bridge.call.mockResolvedValueOnce({ ...f.result, manifestVersion: 2 });
    await expect(bootstrap.prepare({ sessionId: SESSION, token: TOKEN, protocolVersion: 1, preferredPort: 9301, scene: SCENE })).rejects.toThrow("manifest");
    await expect(lstat(f.sessionRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("denies returned roots outside canonical .mcp containment", async () => {
    const f = await fixture(); const bootstrap = new RuntimeBootstrap(f.bridge);
    f.bridge.call.mockResolvedValueOnce({ ...f.result, sessionRoot: f.userRoot });
    await expect(bootstrap.prepare({ sessionId: SESSION, token: TOKEN, protocolVersion: 1, preferredPort: 9301, scene: SCENE })).rejects.toThrow("containment");
  });

  it("rejects unverified launcher or bridge resource paths", async () => {
    const f = await fixture(); const bootstrap = new RuntimeBootstrap(f.bridge);
    f.bridge.call.mockResolvedValueOnce({ ...f.result, launcherPath: f.sessionRoot });
    await expect(bootstrap.prepare({ sessionId: SESSION, token: TOKEN, protocolVersion: 1, preferredPort: 9301, scene: SCENE })).rejects.toThrow(/launcher|resource/);
  });

  it("denies a symlinked session directory", async () => {
    const f = await fixture(); await rm(f.sessionRoot, { recursive: true });
    const outside = await mkdtemp(join(tmpdir(), "robogodot-outside-")); roots.push(outside);
    await symlink(outside, f.sessionRoot, process.platform === "win32" ? "junction" : "dir");
    const bootstrap = new RuntimeBootstrap(f.bridge);
    await expect(bootstrap.prepare({ sessionId: SESSION, token: TOKEN, protocolVersion: 1, preferredPort: 9301, scene: SCENE })).rejects.toThrow(/symbolic|canonical|containment/);
  });

  it("cleans a partial config write and cleanup is exact and idempotent", async () => {
    const f = await fixture(); const neighbor = join(f.approvedRoot, "fedcba9876543210fedcba9876543210"); await mkdir(neighbor);
    const bootstrap = new RuntimeBootstrap(f.bridge, { writeConfig: async path => { await writeFile(path, "partial"); throw new Error("disk full"); } });
    await expect(bootstrap.prepare({ sessionId: SESSION, token: TOKEN, protocolVersion: 1, preferredPort: 9301, scene: SCENE })).rejects.toThrow("disk full");
    await expect(lstat(f.sessionRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(neighbor)).isDirectory()).toBe(true);
    const f2 = await fixture(); const config = await new RuntimeBootstrap(f2.bridge).prepare({ sessionId: SESSION, token: TOKEN, protocolVersion: 1, preferredPort: 9301, scene: SCENE });
    await new RuntimeBootstrap(f2.bridge).cleanup(config); await new RuntimeBootstrap(f2.bridge).cleanup(config);
    await expect(lstat(f2.sessionRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("denies cleanup after the exact session is replaced by a link", async () => {
    const f = await fixture(); const bootstrap = new RuntimeBootstrap(f.bridge);
    const config = await bootstrap.prepare({ sessionId: SESSION, token: TOKEN, protocolVersion: 1, preferredPort: 9301, scene: SCENE });
    await rm(f.sessionRoot, { recursive: true });
    const outside = await mkdtemp(join(tmpdir(), "robogodot-cleanup-outside-")); roots.push(outside);
    await writeFile(join(outside, "keep"), "safe");
    await symlink(outside, f.sessionRoot, process.platform === "win32" ? "junction" : "dir");
    await expect(bootstrap.cleanup(config)).rejects.toThrow(/symbolic|canonical/);
    expect(await readFile(join(outside, "keep"), "utf8")).toBe("safe");
  });
});
