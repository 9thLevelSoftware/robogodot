import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { JsonRpcClient } from "../src/bridge/ws-client.js";
import { resolveConfig } from "../src/config.js";
import { createRuntimeService } from "../src/index.js";
import { createLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";
import { terminateWindowsProcessTree } from "../src/lsp/host.js";
import { allocateLoopbackPort, captureBoundedOutput, createIsolatedGodotProject, runCleanupSteps, waitForPidExit, waitForProcessExit } from "./live-support.js";

const godotPath = process.env.GODOT_PATH;
const sourceProject = resolve(process.env.GODOT_PROJECT_PATH ?? "../tests/fixtures/godot_project");
const repository = resolve("..");
const token = "phase5-live-token-0123456789abcdef";
const liveDescribe = godotPath ? describe : describe.skip;
let projectPath = sourceProject, isolated: string | undefined, editor: ChildProcess | undefined, capture: ReturnType<typeof captureBoundedOutput> | undefined;
let editorPort = 0, runtimePort = 0, dapPort = 0, remoteDebugPort = 0;

liveDescribe("Phase 5 public MCP runtime and attach-only DAP acceptance", () => {
  beforeAll(async () => {
    isolated = await createIsolatedGodotProject(sourceProject); projectPath = resolve(isolated);
    await mkdir(join(projectPath, "addons"), { recursive: true });
    await cp(join(repository, "addons", "godot_control_mcp"), join(projectPath, "addons", "godot_control_mcp"), { recursive: true });
    [editorPort, runtimePort, dapPort, remoteDebugPort] = await Promise.all([allocateLoopbackPort(), allocateLoopbackPort(), allocateLoopbackPort(), allocateLoopbackPort()]);
    editor = spawn(godotPath!, ["--editor", "--headless", "--path", projectPath, "--dap-port", String(dapPort), "--debug-server", `tcp://127.0.0.1:${remoteDebugPort}`], { env: { ...process.env, GODOT_MCP_TOKEN: token, GODOT_MCP_PORT: String(editorPort) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    capture = captureBoundedOutput(editor.stdout!, editor.stderr!);
  }, 30_000);
  afterAll(async () => {
    let failure: unknown;
    await runCleanupSteps(failure, [
      async () => { if (!editor) return; if (process.platform === "win32" && editor.pid) await terminateWindowsProcessTree(editor.pid, 7_000).catch(() => editor!.kill("SIGTERM")); else if (editor.exitCode === null) editor.kill("SIGTERM"); await waitForProcessExit(editor, 7_000); if (editor.pid) await waitForPidExit(editor.pid, 7_000); },
      async () => { capture?.dispose(); }, async () => { if (isolated) await rm(isolated, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); },
    ]);
  });

  async function harness() {
    const oldRuntime = process.env.GODOT_RUNTIME_PORT, oldDebug = process.env.GODOT_REMOTE_DEBUG_PORT;
    process.env.GODOT_RUNTIME_PORT = String(runtimePort); process.env.GODOT_REMOTE_DEBUG_PORT = String(remoteDebugPort);
    const bridge = new JsonRpcClient({ url: `ws://127.0.0.1:${editorPort}`, token, logger: createLogger("error"), reconnectBaseMs: 20, reconnectMaxMs: 100 }); bridge.start();
    await expect.poll(() => bridge.getStatus().state, { timeout: 20_000, interval: 50 }).toBe("connected");
    const config = resolveConfig({ ...process.env, GODOT_MCP_TOKEN: token, GODOT_PATH: godotPath, GODOT_PROJECT_PATH: projectPath, GODOT_MCP_PORT: String(editorPort), GODOT_DAP_PORT: String(dapPort) }, projectPath, process.platform);
    const runtime = createRuntimeService(config, bridge); const server = createServer({ bridge, runtime, debug: runtime }); const client = new Client({ name: "phase5-live", version: "1" }); const [ct, st] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(st), client.connect(ct)]);
    return { client, close: async () => { let first: unknown; for (const step of [() => client.close(), () => server.close(), () => runtime.close(), async () => bridge.stop()]) try { await step(); } catch (error) { first ??= error; } oldRuntime === undefined ? delete process.env.GODOT_RUNTIME_PORT : process.env.GODOT_RUNTIME_PORT = oldRuntime; oldDebug === undefined ? delete process.env.GODOT_REMOTE_DEBUG_PORT : process.env.GODOT_REMOTE_DEBUG_PORT = oldDebug; if (first) throw first; } };
  }
  async function call<T = any>(client: Client, name: string, args: Record<string, unknown>): Promise<T> { const result = await client.callTool({ name, arguments: args }); if (result.isError) throw new Error((result.content[0] as any).text); return result.structuredContent as T; }
  async function waitCall<T = any>(client: Client, name: string, args: Record<string, unknown>, timeout = 10_000): Promise<T> { const deadline = Date.now() + timeout; let last: unknown; while (Date.now() < deadline) { try { return await call<T>(client, name, args); } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 50)); } } throw last; }

  test("normal run proves output, tree, property, input, screenshot, and exact cleanup", async () => {
    const h = await harness(); let sessionId: string | undefined, pid: number | undefined, artifactRoot: string | undefined, primary: unknown;
    try {
      const launch = await call<any>(h.client, "godot_run_project", { scene: "res://phase5/main.tscn" }); sessionId = launch.sessionId; pid = launch.pid;
      await expect.poll(async () => JSON.stringify(await call(h.client, "godot_run_output", { sessionId, since: 0, limit: 500 })), { timeout: 10_000 }).toContain("PHASE5_READY");
      expect(JSON.stringify(await call(h.client, "godot_runtime_scene_tree", { sessionId, maxDepth: 8 }))).toContain("RuntimeTarget");
      expect(await call<any>(h.client, "godot_runtime_get_node", { sessionId, path: ".", properties: ["position"] })).toMatchObject({ properties: { position: { type: "Vector2", x: 0, y: 0 } } });
      await call(h.client, "godot_runtime_input", { sessionId, kind: "action", action: "phase5_jump", mode: "press_release", holdMs: 100 });
      await expect.poll(async () => JSON.stringify(await call(h.client, "godot_run_output", { sessionId, since: 0, limit: 500 })), { timeout: 5000 }).toContain("PHASE5_JUMP:1:42");
      const shot = await call<any>(h.client, "godot_runtime_screenshot", { sessionId, name: "phase5.png" }); expect(shot).toMatchObject({ width: 320, height: 180, format: "png" }); expect(shot.sha256).toMatch(/^[a-f0-9]{64}$/); artifactRoot = dirname(shot.absolutePath);
      await call(h.client, "godot_stop_project", { sessionId }); sessionId = undefined; await waitForPidExit(pid!, 7000); await expect(stat(artifactRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } catch (error) { primary = error; if (error instanceof Error) error.message += `\n${capture?.diagnostics()}`; throw error; } finally { await runCleanupSteps(primary, [async () => { if (sessionId) await call(h.client, "godot_stop_project", { sessionId }); }, () => h.close(), async () => { if (pid) await waitForPidExit(pid, 7000); }]); }
  }, 45_000);

  test("debug run attaches, breaks, inspects local 42, steps, continues, and stops", async () => {
    const h = await harness(); let sessionId: string | undefined, pid: number | undefined, primary: unknown;
    try {
      await call(h.client, "godot_scene_open", { path: "res://phase5/main.tscn", discardUnsaved: true });
      const launch = await call<any>(h.client, "godot_debug_launch", { scene: "res://phase5/main.tscn", timeoutMs: 20_000 }); sessionId = launch.sessionId; pid = launch.pid; expect(launch.state).toBe("debug_ready");
      const set = await call<any>(h.client, "godot_debug_set_breakpoints", { sessionId, path: "phase5/runtime_fixture.gd", lines: [14] }); expect(set.breakpoints).toEqual([expect.objectContaining({ verified: true, line: 14 })]);
      let stack: any;
      for (let attempt = 0; attempt < 3 && !stack; attempt++) { await call(h.client, "godot_runtime_input", { sessionId, kind: "action", action: "phase5_jump", mode: "press_release", holdMs: 100 }); try { stack = await waitCall<any>(h.client, "godot_debug_stack", { sessionId, startFrame: 0 }, 3_000); } catch { /* retry only while DAP has not reported a stopped state */ } }
      if (!stack) throw new Error("Godot DAP did not report a stopped breakpoint after three condition-driven input attempts."); expect(JSON.stringify(stack.frames)).toContain("runtime_fixture.gd"); const frame = stack.frames[0].ref, thread = stack.threads[0].ref;
      const scopes = await call<any>(h.client, "godot_debug_inspect", { sessionId, frame, start: 0 }); let found = false; for (const scope of scopes.scopes) { const values = await call<any>(h.client, "godot_debug_inspect", { sessionId, frame, variables: scope.ref, start: 0 }); if (values.variables.some((value: any) => value.name === "phase5_value" && value.value === "42")) found = true; } expect(found).toBe(true);
      await call(h.client, "godot_debug_step", { sessionId, thread, kind: "over" }); const stepped = await waitCall<any>(h.client, "godot_debug_stack", { sessionId, startFrame: 0 }); await call(h.client, "godot_debug_continue", { sessionId, thread: stepped.threads[0].ref });
      await call(h.client, "godot_stop_project", { sessionId }); sessionId = undefined; await waitForPidExit(pid!, 7000);
    } catch (error) { primary = error; if (error instanceof Error) error.message += `\n${capture?.diagnostics()}`; throw error; } finally { await runCleanupSteps(primary, [async () => { if (sessionId) await call(h.client, "godot_stop_project", { sessionId }); }, () => h.close(), async () => { if (pid) await waitForPidExit(pid, 7000); }]); }
  }, 60_000);
});
