import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it, vi } from "vitest";

const execute = promisify(execFile);
const artifact = path.resolve("dist/index.js");
let buildStartedAt = 0;

beforeAll(async () => {
  buildStartedAt = Date.now();
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("npm_execpath is required to build the stdio fixture");
  await execute(process.execPath, [npmCli, "run", "build"], { cwd: process.cwd() });
  expect((await stat(artifact)).mtimeMs).toBeGreaterThanOrEqual(buildStartedAt - 1000);
}, 30_000);

describe("freshly built stdio server", () => {
  const childEnv = { ...process.env, GODOT_MCP_TOKEN: "0123456789abcdef0123456789abcdef" };
  it("emits only complete MCP JSON frames and lists Phase 1 through Phase 3 node tools while Godot is absent", async () => {
    const child = spawn(process.execPath, [artifact], { cwd: process.cwd(), env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    const messages: Array<Record<string, any>> = [];
    let buffer = "";
    let parseFailure: Error | undefined;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const frame = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (frame.length === 0) continue;
        try { messages.push(JSON.parse(frame)); }
        catch (error) { parseFailure = error instanceof Error ? error : new Error(String(error)); }
      }
    });
    const waitForId = async (id: number): Promise<void> => {
      await vi.waitFor(() => {
        if (parseFailure) throw parseFailure;
        expect(messages.some((message) => message.id === id)).toBe(true);
      }, { timeout: 10_000 });
    };
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "stdio-test", version: "1" } } }) + "\n");
    await waitForId(1);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    await waitForId(2);
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    expect(parseFailure).toBeUndefined();
    expect(buffer).toBe("");
    expect(messages.find((message) => message.id === 2)?.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "godot_connection_status", "godot_get_version", "godot_ping", "godot_script_run",
      "godot_api_list_classes", "godot_api_describe_class", "godot_api_search", "godot_api_class_doc",
      "godot_node_add", "godot_node_delete", "godot_node_reparent", "godot_node_rename",
      "godot_node_duplicate", "godot_node_get", "godot_node_set_property", "godot_node_call_method", "godot_scene_instance",
      "godot_scene_open", "godot_scene_new", "godot_scene_save", "godot_scene_tree", "godot_scene_current",
      "godot_signal_list", "godot_signal_connect", "godot_signal_disconnect",
      "godot_resource_load", "godot_resource_create", "godot_resource_save",
      "godot_project_setting_get", "godot_project_setting_set", "godot_project_setting_list",
      "godot_lsp_diagnostics", "godot_lsp_completion", "godot_lsp_hover", "godot_lsp_signature_help",
      "godot_lsp_document_symbols", "godot_lsp_workspace_symbols", "godot_lsp_native_symbol",
      "godot_run_project", "godot_stop_project", "godot_run_output",
      "godot_runtime_scene_tree", "godot_runtime_get_node", "godot_runtime_input", "godot_runtime_screenshot",
      "godot_debug_launch", "godot_debug_set_breakpoints", "godot_debug_continue", "godot_debug_step", "godot_debug_stack", "godot_debug_inspect",
      "godot_fs_read", "godot_fs_write", "godot_fs_list", "godot_headless_run", "godot_export_project", "godot_uid_list", "godot_asset_generate",
    ]);
  });

  it("exits promptly and successfully when its stdio host closes stdin", async () => {
    const child = spawn(process.execPath, [artifact], { cwd: process.cwd(), env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end();
    const result = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stdio server did not exit after stdin EOF")), 10_000)),
    ]);
    expect(result).toEqual({ code: 0, signal: null });
  });
});
