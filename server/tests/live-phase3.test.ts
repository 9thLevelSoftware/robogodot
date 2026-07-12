import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import { JsonRpcClient } from "../src/bridge/ws-client.js";
import { createServer } from "../src/server.js";
import { createLogger } from "../src/logger.js";

const godotPath = process.env.GODOT_PATH;
const liveDescribe = godotPath ? describe : describe.skip;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const token = "0123456789abcdef0123456789abcdef";

async function freePort(): Promise<number> {
  const socket = createNetServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const address = socket.address(); if (!address || typeof address === "string") throw new Error("port allocation failed");
  await new Promise<void>(done => socket.close(() => done())); return address.port;
}
async function waitFor(predicate: () => boolean, diagnostics: () => string, timeout = 20_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error(`Godot connection timeout\n${diagnostics()}`); await new Promise(r => setTimeout(r, 50)); }
}
function launch(project: string, port: number) {
  const child = spawn(godotPath!, ["--headless", "--editor", "--path", project], { env: { ...process.env, GODOT_MCP_PORT: String(port), GODOT_MCP_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = ""; child.stdout?.on("data", chunk => output = (output + chunk).slice(-32_768)); child.stderr?.on("data", chunk => output = (output + chunk).slice(-32_768));
  return { child, diagnostics: () => output };
}
async function stop(child?: ChildProcess): Promise<void> {
  if (!child || child.exitCode !== null) return; child.kill();
  await Promise.race([once(child, "exit"), new Promise(r => setTimeout(r, 1500))]);
  if (child.exitCode === null && process.platform === "win32" && child.pid) await new Promise<void>(done => spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }).once("exit", () => done()));
}

liveDescribe("Phase 3 public MCP acceptance (set GODOT_PATH to enable)", () => {
  test("builds, persists, fully undoes, and reconnects with session handles invalidated", async () => {
    const project = await mkdtemp(join(tmpdir(), "godot-mcp-phase3-"));
    const port = await freePort(); let process: ReturnType<typeof launch> | undefined;
    const bridge = new JsonRpcClient({ url: `ws://127.0.0.1:${port}`, token, logger: createLogger("error"), heartbeatIntervalMs: 250, heartbeatTimeoutMs: 250 });
    let server: ReturnType<typeof createServer> | undefined; let client: Client | undefined;
    try {
      await mkdir(join(project, "addons"), { recursive: true });
      await cp(join(root, "addons", "godot_control_mcp"), join(project, "addons", "godot_control_mcp"), { recursive: true });
      await writeFile(join(project, "project.godot"), '[application]\nconfig/name="Phase 3 Live"\n[editor_plugins]\nenabled=PackedStringArray("res://addons/godot_control_mcp/plugin.cfg")\n');
      await writeFile(join(project, "fixture.tscn"), '[gd_scene format=3]\n\n[node name="Fixture" type="Node2D"]\n');
      bridge.start(); process = launch(project, port); await waitFor(() => bridge.getStatus().state === "connected", process.diagnostics);
      server = createServer({ bridge, mode: "full" }); client = new Client({ name: "phase3-live", version: "1" });
      const [ct, st] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(st), client.connect(ct)]);
      const call = async <T extends Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) => {
        const response = await client!.callTool({ name, arguments: args });
        if (response.isError) throw new Error(JSON.stringify(response.content)); return response.structuredContent as T;
      };
      await call("godot_scene_new", { rootType: "Node2D", rootName: "Acceptance", discardUnsaved: true });
      const rootPath = "/root/Acceptance";
      const first = await call<{ path: string }>("godot_node_add", { parent: rootPath, type: "Button", name: "Emitter", properties: { text: '"before"' } });
      const second = await call<{ path: string }>("godot_node_add", { parent: rootPath, type: "Node", name: "Receiver", properties: {} });
      await call("godot_node_set_property", { path: first.path, property: "text", value: '"configured"' });
      const instance = await call<{ path: string }>("godot_scene_instance", { parent: rootPath, scenePath: "res://fixture.tscn", name: "FixtureInstance" });
      const historyVersion = async () => (await call<{ ok: boolean; returnValue: number }>("godot_script_run", { allowDangerous: true, args: {}, source: "func __run(_args):\n\tvar root := EditorInterface.get_edited_scene_root()\n\tvar manager := EditorInterface.get_editor_undo_redo()\n\treturn manager.get_history_undo_redo(manager.get_object_history_id(root)).get_version()" })).returnValue;
      const beforeRejectedFlags = await historyVersion();
      await expect(bridge.call("edit.signal_connect", { source: first.path, signal: "pressed", callable: { target: second.path, method: "queue_free" }, flags: 1.000001 })).rejects.toMatchObject({ code: "godot_error" });
      expect(await historyVersion()).toBe(beforeRejectedFlags);
      expect((await call<{ signals: Array<{ name: string; connectionCount: number }> }>("godot_signal_list", { path: first.path })).signals.find(signal => signal.name === "pressed")?.connectionCount).toBe(0);
      await call("godot_signal_connect", { source: first.path, signal: "pressed", callable: { target: second.path, method: "queue_free" }, flags: 0 });
      const resource = await call<{ handle: string }>("godot_resource_create", { class: "Gradient", properties: {} });
      await call("godot_resource_save", { handle: resource.handle, path: "res://acceptance.tres" });
      await call("godot_resource_load", { path: "res://acceptance.tres" });
      const settingKey = "mcp_acceptance/exact_restore";
      expect(await call("godot_project_setting_get", { key: settingKey })).toMatchObject({ exists: false });
      await call("godot_project_setting_set", { key: settingKey, value: '"temporary"' });
      const seed = await call<{ path: string }>("godot_node_add", { parent: rootPath, type: "Node", name: "FifoSeed", properties: {} });
      const renamePromise = call<{ path: string }>("godot_node_rename", { path: seed.path, name: "FifoRenamed" });
      const dependentPromise = call<{ path: string }>("godot_node_add", { parent: `${rootPath}/FifoRenamed`, type: "Node", name: "Dependent", properties: {} });
      const [renamed, dependent] = await Promise.all([renamePromise, dependentPromise]);
      expect(renamed.path).toBe(`${rootPath}/FifoRenamed`);
      expect(dependent.path).toBe(`${rootPath}/FifoRenamed/Dependent`);
      expect(await call("godot_node_get", { path: dependent.path })).toMatchObject({ path: dependent.path, name: "Dependent" });
      await call("godot_scene_save", { path: "res://acceptance.tscn" });
      await call("godot_scene_open", { path: "res://acceptance.tscn", discardUnsaved: true });
      expect(await call("godot_node_get", { path: first.path })).toMatchObject({ properties: { text: "configured" } });
      expect(await call("godot_node_get", { path: instance.path })).toMatchObject({ path: instance.path, name: "FixtureInstance" });
      expect((await call<{ signals: Array<{ name: string; connectionCount: number }> }>("godot_signal_list", { path: first.path })).signals.find(signal => signal.name === "pressed")?.connectionCount).toBe(1);

      // Headless stand-in for human Ctrl-Z. Authoring above and verification below use curated tools only.
      for (let index = 0; index < 9; index++) await call("godot_script_run", { allowDangerous: true, args: { project: index === 0 }, source: "func __run(args):\n\tvar target: Object = ProjectSettings if args.project else EditorInterface.get_edited_scene_root()\n\tvar manager := EditorInterface.get_editor_undo_redo()\n\tvar history := manager.get_history_undo_redo(manager.get_object_history_id(target))\n\tif history.has_undo(): history.undo()\n\treturn history.has_undo()" });
      expect((await call<{ nodes: unknown[] }>("godot_scene_tree", { limit: 100, maxDepth: 8 })).nodes).toHaveLength(1);
      expect(await call("godot_project_setting_get", { key: settingKey })).toMatchObject({ exists: false });

      await stop(process.child); process = undefined; await waitFor(() => bridge.getStatus().state !== "connected", () => "editor did not disconnect");
      process = launch(project, port); await waitFor(() => bridge.getStatus().state === "connected", process.diagnostics);
      await expect(call("godot_resource_save", { handle: resource.handle, path: "res://stale.tres" })).rejects.toThrow(/live resource handle/i);
      await expect(call("godot_ping")).resolves.toMatchObject({ pong: true });
    } finally {
      await client?.close(); await server?.close(); bridge.stop(); await stop(process?.child);
      await rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 90_000);
});
