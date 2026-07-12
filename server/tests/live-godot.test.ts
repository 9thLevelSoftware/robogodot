import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { JsonRpcClient } from "../src/bridge/ws-client.js";
import { createServer as createMcpServer } from "../src/server.js";
import { GodotMcpError } from "../src/errors.js";
import { createLogger } from "../src/logger.js";
import { captureBoundedOutput, launchWithPortRetry, liveTimeoutBudget, waitForProcessConnection, type OutputCapture } from "./live-support.js";

const godotPath = process.env.GODOT_PATH;
const liveDescribe = godotPath ? describe : describe.skip;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LAUNCH_ATTEMPTS = 3;
// Multiple live suites launch Godot in parallel; readiness remains condition-driven,
// but a cold concurrent editor scan can exceed ten seconds on Windows CI/dev hosts.
const CONNECT_TIMEOUT_MS = 20_000;
const TERMINATE_TIMEOUT_MS = 5_000;
const RECONNECT_TIMEOUT_MS = 20_000;
const LIVE_TEST_TIMEOUT_MS = liveTimeoutBudget({ attempts: LAUNCH_ATTEMPTS, connectMs: CONNECT_TIMEOUT_MS, terminateMs: TERMINATE_TIMEOUT_MS, reconnectMs: RECONNECT_TIMEOUT_MS, marginMs: 5_000 });
const TOKEN = "0123456789abcdef0123456789abcdef";

async function freePort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a localhost port");
  const port = address.port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

async function waitFor(predicate: () => boolean, message: string | (() => string), timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(typeof message === "function" ? message() : message);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

interface GodotProcess { child: ChildProcess; capture: OutputCapture; port: number; disposeCapture(): void }

function launchGodot(projectPath: string, port: number): GodotProcess {
  const child = spawn(godotPath!, ["--headless", "--editor", "--path", projectPath], {
    env: { ...process.env, GODOT_MCP_PORT: String(port), GODOT_MCP_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!child.stdout || !child.stderr) throw new Error("Godot diagnostic pipes were not created");
  const capture = captureBoundedOutput(child.stdout, child.stderr);
  const onExit = () => capture.dispose();
  child.once("exit", onExit);
  return { child, capture, port, disposeCapture: () => { child.off("exit", onExit); capture.dispose(); } };
}

async function terminate(managed: GodotProcess | undefined): Promise<void> {
  if (!managed) return;
  const { child } = managed;
  if (child.exitCode !== null || child.pid === undefined) { managed.disposeCapture(); return; }
  try {
    const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    child.kill();
    await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 1_500))]);
    if (child.exitCode === null) {
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
        await Promise.race([once(killer, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 1_500))]);
      } else child.kill("SIGKILL");
      await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("Godot did not terminate")), 2_000))]);
    }
  } finally {
    managed.disposeCapture();
  }
}

liveDescribe("live Godot editor round trip (set GODOT_PATH to enable)", () => {
  test("round trips ping/version and reconnects after an actual editor restart", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "godot-control-mcp-live-"));
    let client: JsonRpcClient | undefined;
    let mcpClient: Client | undefined;
    let mcpServer: ReturnType<typeof createMcpServer> | undefined;
    let godotProcess: GodotProcess | undefined;
    try {
      await mkdir(join(projectPath, "addons"), { recursive: true });
      await cp(join(repositoryRoot, "addons", "godot_control_mcp"), join(projectPath, "addons", "godot_control_mcp"), { recursive: true });
      await writeFile(join(projectPath, "project.godot"), '[application]\nconfig/name="Godot Control MCP Live"\n[editor_plugins]\nenabled=PackedStringArray("res://addons/godot_control_mcp/plugin.cfg")\n');

      godotProcess = await launchWithPortRetry({
        attempts: LAUNCH_ATTEMPTS,
        allocatePort: freePort,
        launch: (port) => {
          client = new JsonRpcClient({ url: `ws://127.0.0.1:${port}`, token: TOKEN, logger: createLogger("error"), heartbeatIntervalMs: 250, heartbeatTimeoutMs: 250 });
          client.start();
          return launchGodot(projectPath, port);
        },
        waitUntilConnected: async (launch) => waitForProcessConnection({ child: launch.child, isConnected: () => client!.getStatus().state === "connected", diagnostics: () => launch.capture.diagnostics(), timeoutMs: CONNECT_TIMEOUT_MS }),
        terminate: async (failed) => { client?.stop(); client = undefined; await terminate(failed); },
        diagnostics: (failed) => failed.capture.diagnostics(),
        shouldRetry: (_error, failed) => /address already in use|ERR_ALREADY_IN_USE|could not listen[^\n]*error 22/i.test(failed.capture.diagnostics()),
      });
      const port = godotProcess.port;
      const connectedClient = client!;
      expect(await connectedClient.call("core.ping")).toEqual({ pong: true });
      const version = await connectedClient.call<Record<string, unknown>>("core.get_version");
      expect(version).toMatchObject({ plugin: "0.1.0", connected: true });
      expect(version.projectPath).toBe(`${projectPath.replaceAll("\\", "/")}/`);
      const execResult = await connectedClient.call<Record<string, unknown>>("exec.run", {
        source: "func __run(args):\n\treturn Color(args.r, 0.5, 0.25, 1.0)",
        args: { r: 1 }, outputCapBytes: 262_144,
      });
      expect(execResult.errors).toEqual([]);
      expect(execResult).toMatchObject({ ok: true, returnValue: { $type: "Color", r: 1, g: 0.5, b: 0.25, a: 1 } });
      mcpServer = createMcpServer({ bridge: connectedClient, mode: "full" });
      mcpClient = new Client({ name: "live-authoring", version: "1" });
      const [mcpClientTransport, mcpServerTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([mcpServer.connect(mcpServerTransport), mcpClient.connect(mcpClientTransport)]);
      const runPublic = (source: string, args: unknown) => mcpClient!.callTool({ name: "godot_script_run", arguments: { source, args, allowDangerous: true } });
      const created = await runPublic("func __run(args):\n\tvar node := Node.new()\n\tnode.name = args.name\n\tvar result := {\"class\": node.get_class(), \"name\": str(node.name)}\n\tnode.free()\n\treturn result", { name: "McpAuthoredNode" });
      expect(created.structuredContent).toMatchObject({ ok: true, returnValue: { class: "Node", name: "McpAuthoredNode" }, errors: [] });
      const propertySet = await runPublic("func __run(args):\n\tvar node := Node2D.new()\n\tnode.position = Vector2(args.x, args.y)\n\tvar result := node.position\n\tnode.free()\n\treturn result", { x: 12.5, y: -3 });
      expect(propertySet.structuredContent).toMatchObject({ ok: true, returnValue: { $type: "Vector2", x: 12.5, y: -3 }, errors: [] });
      const settingRead = await runPublic("func __run(args):\n\treturn ProjectSettings.get_setting(args.key)", { key: "application/config/name" });
      expect(settingRead.structuredContent).toMatchObject({ ok: true, returnValue: "Godot Control MCP Live", errors: [] });
      const classes = await connectedClient.call<{ classes: string[]; total: number; hasMore: boolean }>("introspection.list_classes", { offset: 0, limit: 10 });
      expect(classes.classes).toHaveLength(10);
      expect(classes.total).toBeGreaterThan(10);
      expect(classes.hasMore).toBe(true);
      const node = await connectedClient.call<Record<string, unknown>>("introspection.describe_class", { class: "Node" });
      expect(node).toMatchObject({ class: "Node", inherits: "Object" });
      expect(node).toHaveProperty("methods");
      const mesh = await connectedClient.call<{ results: Array<{ class: string }> }>("introspection.search", { query: "mesh", limit: 20 });
      expect(mesh.results.some((result) => result.class.toLowerCase().includes("mesh"))).toBe(true);
      await expect(connectedClient.call("introspection.describe_class", { class: "DefinitelyNotAGodotClass" })).rejects.toMatchObject({ code: "godot_error" });

      await terminate(godotProcess);
      godotProcess = undefined;
      await waitFor(() => connectedClient.getStatus().state !== "connected", "Client did not observe editor termination");
      await expect(connectedClient.call("core.ping")).rejects.toMatchObject<Partial<GodotMcpError>>({ code: "not_connected" });

      godotProcess = launchGodot(projectPath, port);
      await waitForProcessConnection({ child: godotProcess.child, isConnected: () => connectedClient.getStatus().state === "connected", diagnostics: () => godotProcess!.capture.diagnostics(), timeoutMs: RECONNECT_TIMEOUT_MS });
      await expect(connectedClient.call("core.ping")).resolves.toEqual({ pong: true });
    } finally {
      await mcpClient?.close();
      await mcpServer?.close();
      client?.stop();
      await terminate(godotProcess);
      await rm(projectPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, LIVE_TEST_TIMEOUT_MS);
});
