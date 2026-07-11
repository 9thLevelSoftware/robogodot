import { once } from "node:events";
import { mkdtemp, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { JsonRpcClient } from "../src/bridge/ws-client.js";
import { GodotMcpError } from "../src/errors.js";
import { createLogger } from "../src/logger.js";
import { captureBoundedOutput, launchWithPortRetry, type OutputCapture } from "./live-support.js";

const godotPath = process.env.GODOT_PATH;
const liveDescribe = godotPath ? describe : describe.skip;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function freePort(): Promise<number> {
  const server = createServer();
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

interface GodotProcess { child: ChildProcess; capture: OutputCapture; port: number }

function launchGodot(projectPath: string, port: number): GodotProcess {
  const child = spawn(godotPath!, ["--headless", "--editor", "--path", projectPath], {
    env: { ...process.env, GODOT_MCP_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!child.stdout || !child.stderr) throw new Error("Godot diagnostic pipes were not created");
  const capture = captureBoundedOutput(child.stdout, child.stderr);
  child.once("exit", () => capture.dispose());
  return { child, capture, port };
}

async function terminate(process: GodotProcess | undefined): Promise<void> {
  if (!process) return;
  const { child } = process;
  if (child.exitCode !== null) { process.capture.dispose(); return; }
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill();
  await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
  if (child.exitCode === null) {
    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      await once(killer, "exit");
    } else child.kill("SIGKILL");
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("Godot did not terminate")), 5_000))]);
  }
  process.capture.dispose();
}

liveDescribe("live Godot editor round trip (set GODOT_PATH to enable)", () => {
  test("round trips ping/version and reconnects after an actual editor restart", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "godot-control-mcp-live-"));
    let client: JsonRpcClient | undefined;
    let process: GodotProcess | undefined;
    try {
      await mkdir(join(projectPath, "addons"), { recursive: true });
      await cp(join(repositoryRoot, "addons", "godot_control_mcp"), join(projectPath, "addons", "godot_control_mcp"), { recursive: true });
      await writeFile(join(projectPath, "project.godot"), '[application]\nconfig/name="Godot Control MCP Live"\n[editor_plugins]\nenabled=PackedStringArray("res://addons/godot_control_mcp/plugin.cfg")\n');

      process = await launchWithPortRetry({
        attempts: 3,
        allocatePort: freePort,
        launch: (port) => {
          client = new JsonRpcClient({ url: `ws://127.0.0.1:${port}`, logger: createLogger("error"), heartbeatIntervalMs: 250, heartbeatTimeoutMs: 250 });
          client.start();
          return launchGodot(projectPath, port);
        },
        waitUntilConnected: async () => waitFor(() => client!.getStatus().state === "connected", "plugin connection window expired (possible bind collision)", 5_000),
        terminate: async (failed) => { client?.stop(); client = undefined; await terminate(failed); },
        diagnostics: (failed) => failed.capture.diagnostics(),
      });
      const port = process.port;
      const connectedClient = client!;
      expect(await connectedClient.call("core.ping")).toEqual({ pong: true });
      const version = await connectedClient.call<Record<string, unknown>>("core.get_version");
      expect(version).toMatchObject({ plugin: "0.1.0", connected: true });
      expect(version.projectPath).toBe(`${projectPath.replaceAll("\\", "/")}/`);

      await terminate(process);
      process = undefined;
      await waitFor(() => connectedClient.getStatus().state !== "connected", "Client did not observe editor termination");
      await expect(connectedClient.call("core.ping")).rejects.toMatchObject<Partial<GodotMcpError>>({ code: "not_connected" });

      process = launchGodot(projectPath, port);
      await waitFor(() => connectedClient.getStatus().state === "connected", () => `Client did not reconnect after editor restart\n${process!.capture.diagnostics()}`, 20_000);
      await expect(connectedClient.call("core.ping")).resolves.toEqual({ pong: true });
    } finally {
      client?.stop();
      await terminate(process);
      await rm(projectPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 60_000);
});
