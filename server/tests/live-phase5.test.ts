import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { JsonRpcClient } from "../src/bridge/ws-client.js";
import { resolveConfig } from "../src/config.js";
import { createRuntimeService } from "../src/index.js";
import { createLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";
import { terminateWindowsProcessTree } from "../src/lsp/host.js";
import { acquireWithCleanup, allocateLoopbackPort, captureBoundedOutput, createIsolatedGodotProject, runCleanupSteps, waitForPidExit, waitForProcessExit } from "./live-support.js";

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
    return acquireWithCleanup(async owner => {
      const hadRuntime = Object.hasOwn(process.env, "GODOT_RUNTIME_PORT"), oldRuntime = process.env.GODOT_RUNTIME_PORT;
      const hadDebug = Object.hasOwn(process.env, "GODOT_REMOTE_DEBUG_PORT"), oldDebug = process.env.GODOT_REMOTE_DEBUG_PORT;
      owner.defer(async () => { hadDebug ? process.env.GODOT_REMOTE_DEBUG_PORT = oldDebug! : delete process.env.GODOT_REMOTE_DEBUG_PORT; hadRuntime ? process.env.GODOT_RUNTIME_PORT = oldRuntime! : delete process.env.GODOT_RUNTIME_PORT; });
      process.env.GODOT_RUNTIME_PORT = String(runtimePort); process.env.GODOT_REMOTE_DEBUG_PORT = String(remoteDebugPort);
      const bridge = new JsonRpcClient({ url: `ws://127.0.0.1:${editorPort}`, token, logger: createLogger("error"), reconnectBaseMs: 20, reconnectMaxMs: 100 });
      owner.defer(async () => { await bridge.stop(); }); bridge.start();
      await expect.poll(() => bridge.getStatus().state, { timeout: 20_000, interval: 50 }).toBe("connected");
      const config = resolveConfig({ ...process.env, GODOT_MCP_TOKEN: token, GODOT_PATH: godotPath, GODOT_PROJECT_PATH: projectPath, GODOT_MCP_PORT: String(editorPort), GODOT_DAP_PORT: String(dapPort) }, projectPath, process.platform);
      const runtime = createRuntimeService(config, bridge); owner.defer(() => runtime.close());
      const server = createServer({ bridge, runtime, debug: runtime }); owner.defer(() => server.close());
      const client = new Client({ name: "phase5-live", version: "1" }); owner.defer(() => client.close());
      const [ct, st] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(st), client.connect(ct)]);
      return { client, close: () => owner.close() };
    });
  }
  async function call<T = any>(client: Client, name: string, args: Record<string, unknown>): Promise<T> { const result = await client.callTool({ name, arguments: args }); if (result.isError) throw new Error((result.content[0] as any).text); return result.structuredContent as T; }
  async function waitCall<T = any>(client: Client, name: string, args: Record<string, unknown>, timeout = 10_000): Promise<T> { const deadline = Date.now() + timeout; let last: unknown; while (Date.now() < deadline) { try { return await call<T>(client, name, args); } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 50)); } } throw last; }
  async function verifyScreenshotArtifact(shot: any, sessionId: string): Promise<string> {
    expect(typeof shot.path).toBe("string"); expect(isAbsolute(shot.path)).toBe(false); expect(isAbsolute(shot.absolutePath)).toBe(true);
    const segments = shot.path.split("/"); expect(segments.every((part: string) => part && part !== "." && part !== "..")).toBe(true);
    const expectedRoot = resolve(shot.absolutePath, ...segments.map(() => ".."));
    const root = await realpath(expectedRoot); const absolute = await realpath(shot.absolutePath); const relativeCandidate = await realpath(resolve(root, ...segments));
    expect(basename(root)).toBe(sessionId); expect(basename(dirname(root))).toBe(".mcp"); expect(relativeCandidate).toBe(absolute);
    const contained = relative(root, absolute); expect(contained && contained !== ".." && !contained.startsWith(`..${sep}`) && !isAbsolute(contained)).toBe(true);
    expect(contained.split(sep).join("/")).toBe(shot.path);
    const bytes = await readFile(absolute); expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); expect(bytes.toString("ascii", 12, 16)).toBe("IHDR");
    expect(bytes.readUInt32BE(16)).toBe(shot.width); expect(bytes.readUInt32BE(20)).toBe(shot.height); expect(bytes.length).toBe(shot.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(shot.sha256);
    return root;
  }

  test("normal run proves output, tree, property, input, screenshot, and exact cleanup", async () => {
    const h = await harness(); let sessionId: string | undefined, pid: number | undefined, artifactRoot: string | undefined, primary: unknown;
    try {
      const launch = await call<any>(h.client, "godot_run_project", { scene: "res://phase5/main.tscn" }); sessionId = launch.sessionId; pid = launch.pid;
      await expect.poll(async () => JSON.stringify(await call(h.client, "godot_run_output", { sessionId, since: 0, limit: 500 })), { timeout: 10_000 }).toContain("PHASE5_READY");
      expect(JSON.stringify(await call(h.client, "godot_runtime_scene_tree", { sessionId, maxDepth: 8 }))).toContain("RuntimeTarget");
      expect(await call<any>(h.client, "godot_runtime_get_node", { sessionId, path: ".", properties: ["position"] })).toMatchObject({ properties: { position: { type: "Vector2", x: 0, y: 0 } } });
      await call(h.client, "godot_runtime_input", { sessionId, kind: "action", action: "phase5_jump", mode: "press_release", holdMs: 100 });
      await expect.poll(async () => JSON.stringify(await call(h.client, "godot_run_output", { sessionId, since: 0, limit: 500 })), { timeout: 5000 }).toContain("PHASE5_JUMP:1:42");
      const shot = await call<any>(h.client, "godot_runtime_screenshot", { sessionId, name: "phase5.png" }); expect(shot).toMatchObject({ width: 320, height: 180, format: "png" }); artifactRoot = await verifyScreenshotArtifact(shot, sessionId);
      await call(h.client, "godot_stop_project", { sessionId }); sessionId = undefined; await waitForPidExit(pid!, 7000); await expect(stat(artifactRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } catch (error) { primary = error; if (error instanceof Error) { if (sessionId) try { error.message += `\nruntime: ${JSON.stringify(await call(h.client, "godot_run_output", { sessionId, since: 0, limit: 500 }))}`; } catch { /* preserve primary failure */ } error.message += `\n${capture?.diagnostics()}`; } throw error; } finally { await runCleanupSteps(primary, [async () => { if (sessionId) await call(h.client, "godot_stop_project", { sessionId }); }, () => h.close(), async () => { if (pid) await waitForPidExit(pid, 7000); }]); }
  }, 45_000);

  test("debug run attaches, breaks, inspects local 42, steps, continues, and stops", async () => {
    const h = await harness(); let sessionId: string | undefined, pid: number | undefined, primary: unknown;
    try {
      await call(h.client, "godot_scene_open", { path: "res://phase5/main.tscn", discardUnsaved: true });
      const launch = await call<any>(h.client, "godot_debug_launch", { scene: "res://phase5/main.tscn", timeoutMs: 20_000 }); sessionId = launch.sessionId; pid = launch.pid; expect(launch.state).toBe("debug_ready");
      const set = await call<any>(h.client, "godot_debug_set_breakpoints", { sessionId, path: "phase5/runtime_fixture.gd", lines: [14] }); expect(set.breakpoints).toEqual([expect.objectContaining({ verified: true, line: 14 })]);
      await expect.poll(async () => JSON.stringify(await call(h.client, "godot_run_output", { sessionId, since: 0, limit: 500 })), { timeout: 10_000 }).toContain("PHASE5_READY");
      await call(h.client, "godot_runtime_input", { sessionId, kind: "action", action: "phase5_jump", mode: "press_release", holdMs: 100 });
      let stack: any; let lastStackError: unknown; const stackDeadline = Date.now() + 15_000;
      while (Date.now() < stackDeadline && !stack) { try { stack = await call<any>(h.client, "godot_debug_stack", { sessionId, startFrame: 0 }); } catch (error) { lastStackError = error; await new Promise(resolve => setTimeout(resolve, 50)); } }
      if (!stack) throw new Error(`Verified breakpoint never produced a stopped DAP state; last stack error: ${lastStackError instanceof Error ? lastStackError.message : String(lastStackError)}`); expect(JSON.stringify(stack.frames)).toContain("runtime_fixture.gd"); const frame = stack.frames[0].ref, thread = stack.threads[0].ref;
      const scopes = await call<any>(h.client, "godot_debug_inspect", { sessionId, frame, start: 0 }); let found = false; for (const scope of scopes.scopes) { const values = await call<any>(h.client, "godot_debug_inspect", { sessionId, frame, variables: scope.ref, start: 0 }); if (values.variables.some((value: any) => value.name === "phase5_value" && value.value === "42")) found = true; } expect(found).toBe(true);
      await call(h.client, "godot_debug_step", { sessionId, thread, kind: "over" }); const stepped = await waitCall<any>(h.client, "godot_debug_stack", { sessionId, startFrame: 0 }); await call(h.client, "godot_debug_continue", { sessionId, thread: stepped.threads[0].ref });
      await call(h.client, "godot_stop_project", { sessionId }); sessionId = undefined; await waitForPidExit(pid!, 7000);
    } catch (error) { primary = error; if (error instanceof Error) error.message += `\n${capture?.diagnostics()}`; throw error; } finally { await runCleanupSteps(primary, [async () => { if (sessionId) await call(h.client, "godot_stop_project", { sessionId }); }, () => h.close(), async () => { if (pid) await waitForPidExit(pid, 7000); }]); }
  }, 60_000);
});
