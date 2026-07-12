import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import { LspClient } from "../src/lsp/client.js";
import { LspHost, terminateWindowsProcessTree } from "../src/lsp/host.js";
import { LspSession } from "../src/lsp/session.js";
import { createServer } from "../src/server.js";
import { allocateLoopbackPort, captureBoundedOutput, launchWithPortRetry, runCleanupSteps, waitForPidExit, waitForProcessConnection, waitForProcessExit } from "./live-support.js";

const godotPath = process.env.GODOT_PATH;
const liveDescribe = godotPath ? describe : describe.skip;
const projectPath = resolve(process.env.GODOT_PROJECT_PATH ?? "../tests/fixtures/godot_project");

type Launched = { child: ChildProcess; capture: ReturnType<typeof captureBoundedOutput>; port: number };

function launchEditor(port: number): Launched {
  const child = spawn(godotPath!, ["--editor", "--headless", "--lsp-port", String(port), "--path", projectPath], {
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  if (!child.stdout || !child.stderr) throw new Error("Godot output pipes were not created.");
  return { child, capture: captureBoundedOutput(child.stdout, child.stderr), port };
}

async function terminateEditor(process: Launched): Promise<void> {
  try {
    if (process.child.exitCode === null) process.child.kill("SIGTERM");
    try { await waitForProcessExit(process.child, process.platform === "win32" ? 2_000 : 7_000); }
    catch (signalError) {
      if (process.platform !== "win32" || process.child.pid === undefined) throw signalError;
      await terminateWindowsProcessTree(process.child.pid);
      await waitForPidExit(process.child.pid, 5_000);
    }
  } finally { process.capture.dispose(); }
}

function positionAt(source: string, unique: string, offset = 0): { line: number; character: number } {
  const first = source.indexOf(unique);
  if (first < 0 || source.indexOf(unique, first + 1) >= 0) throw new Error(`Expected one fixture occurrence of ${JSON.stringify(unique)}.`);
  const prefix = source.slice(0, first + offset);
  const lines = prefix.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)!.length };
}

function flattenSymbols(symbols: Array<{ name: string; children?: Array<{ name: string; children?: any[] }> }>): Array<{ name: string }> {
  return symbols.flatMap((symbol) => [symbol, ...flattenSymbols(symbol.children ?? [])]);
}

async function mcpHarness(port: number, autoStart: boolean, spawnObserver?: (child: ChildProcess) => void) {
  const host = new LspHost({ lspPort: port, lspAutoStart: autoStart, godotPath, projectPath }, spawnObserver ? {
    spawn: (command, args, options) => { const child = spawn(command, args, options); spawnObserver(child); return child; },
  } : {});
  const session = new LspSession({
    host: "127.0.0.1", port, projectRootUri: pathToFileURL(projectPath).href,
    beforeConnect: () => host.ensureAvailable().then(() => undefined), connectTimeoutMs: 15_000,
  });
  const lsp = new LspClient(projectPath, session);
  const server = createServer({ lsp });
  const client = new Client({ name: "phase4-live", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { host, lsp, server, client, close: async () => { await client.close(); await server.close(); await lsp.close(); await host.close(); } };
}

async function call<T extends Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw Object.assign(new Error(JSON.stringify(response.structuredContent)), response.structuredContent);
  return response.structuredContent as T;
}

liveDescribe("Phase 4 live Godot 4.6 LSP acceptance (set GODOT_PATH to enable)", () => {
  test("attaches through public MCP and exposes honest editor intelligence", async () => {
    let editor: Launched | undefined; let harness: Awaited<ReturnType<typeof mcpHarness>> | undefined; let primaryFailure: unknown;
    const diagnosticPath = resolve(projectPath, "phase4/diagnostic_error.gd");
    const diagnosticSource = await readFile(diagnosticPath, "utf8");
    try {
      await writeFile(diagnosticPath, "extends Node\n\nfunc phase4_broken() -> void:\n\tpass\n", "utf8");
      editor = await launchWithPortRetry({
        attempts: 3, allocatePort: allocateLoopbackPort, launch: launchEditor,
        waitUntilConnected: async (process) => {
          const readiness = new LspHost({ lspPort: process.port, lspAutoStart: false });
          await waitForProcessConnection({ child: process.child, isConnected: () => readiness.ensureAvailable().then(() => true, () => false), diagnostics: process.capture.diagnostics, timeoutMs: 15_000 });
          await readiness.close();
        },
        terminate: terminateEditor, diagnostics: (process) => process.capture.diagnostics(),
        shouldRetry: (_error, process) => /address already in use|bind.*failed|could not listen/i.test(process.capture.diagnostics()),
      });
      // A successful TCP probe, not elapsed time, determines readiness.
      const attachedHost = new LspHost({ lspPort: editor.port, lspAutoStart: false });
      await attachedHost.ensureAvailable(); await attachedHost.close();
      harness = await mcpHarness(editor.port, false);
      const diagnosticUri = "res://phase4/diagnostic_error.gd";
      const intelligenceUri = "res://phase4/intelligence_fixture.gd";
      await call(harness.client, "godot_lsp_document_symbols", { uri: diagnosticUri });
      await writeFile(diagnosticPath, diagnosticSource, "utf8");

      const source = await readFile(resolve(projectPath, "phase4/intelligence_fixture.gd"), "utf8");
      const diagnostics = await call<{ diagnostics: Array<{ message: string }> }>(harness.client, "godot_lsp_diagnostics", { uri: diagnosticUri, waitMs: 15_000 });
      expect(diagnostics.diagnostics.some((d) => d.message.includes("phase4_missing_identifier"))).toBe(true);
      const completion = await call<{ items: Array<{ label: string }> }>(harness.client, "godot_lsp_completion", { uri: intelligenceUri, position: positionAt(source, "phase4_sprite.queue_free", "phase4_sprite.".length), limit: 500 });
      expect(completion.items.some((item) => item.label === "queue_free"), JSON.stringify(completion)).toBe(true);
      const hover = await call<{ found: boolean }>(harness.client, "godot_lsp_hover", { uri: intelligenceUri, position: positionAt(source, "Sprite2D", 2) });
      expect(hover.found).toBe(true);
      const signatures = await call<{ signatures: Array<{ label: string }> }>(harness.client, "godot_lsp_signature_help", { uri: intelligenceUri, position: positionAt(source, "phase4_sum(1, 2)", "phase4_sum(1,".length) });
      expect(signatures.signatures.some((item) => item.label.includes("phase4_sum"))).toBe(true);
      const rawDocumentSymbols = await call<{ symbols: Array<{ name: string; children?: any[] }> }>(harness.client, "godot_lsp_document_symbols", { uri: intelligenceUri });
      const documentSymbols = { symbols: flattenSymbols(rawDocumentSymbols.symbols) };
      expect(documentSymbols.symbols.some((item) => item.name === "phase4_sum")).toBe(true);
      const nativeSymbol = await call<{ found: boolean }>(harness.client, "godot_lsp_native_symbol", { nativeClass: "Sprite2D" });
      expect(nativeSymbol.found).toBe(true);
      expect(JSON.stringify(nativeSymbol)).toContain("Sprite2D");
      const workspace = await harness.client.callTool({ name: "godot_lsp_workspace_symbols", arguments: { query: "phase4", limit: 50 } });
      expect(workspace.structuredContent).toMatchObject({ code: "feature_disabled" });
    } catch (error) { primaryFailure = error;
      if (editor && error instanceof Error && !error.message.includes(editor.capture.diagnostics())) error.message += `\n${editor.capture.diagnostics()}`;
      throw error;
    } finally {
      await runCleanupSteps(primaryFailure, [
        () => writeFile(diagnosticPath, diagnosticSource, "utf8"),
        () => harness?.close() ?? Promise.resolve(),
        () => editor ? terminateEditor(editor) : Promise.resolve(),
      ]);
    }
  }, 75_000);

  test("fails closed when unavailable and tears down the exact auto-started PID", async () => {
    const unavailablePort = await allocateLoopbackPort();
    const unavailable = await mcpHarness(unavailablePort, false);
    try {
      const result = await unavailable.client.callTool({ name: "godot_lsp_native_symbol", arguments: { nativeClass: "Sprite2D" } });
      expect(result.structuredContent).toMatchObject({ code: "not_connected" });
      const hint = String((result.structuredContent as { hint?: unknown }).hint);
      expect(hint).toContain("--lsp-port"); expect(hint).toContain(String(unavailablePort));
      expect(hint).toContain("--path"); expect(hint).toContain(projectPath);
    } finally { await unavailable.close(); }

    const ownedPort = await allocateLoopbackPort(); let ownedChild: ChildProcess | undefined; let primaryFailure: unknown;
    const owned = await mcpHarness(ownedPort, true, (child) => { ownedChild = child; });
    try {
      await call(owned.client, "godot_lsp_native_symbol", { nativeClass: "Sprite2D" });
      expect(owned.host.ownership).toBe("owned");
      expect(ownedChild?.pid).toBeTypeOf("number");
    } catch (error) { primaryFailure = error; throw error; }
    finally { await runCleanupSteps(primaryFailure, [() => owned.close(), () => ownedChild?.pid === undefined ? Promise.resolve() : waitForPidExit(ownedChild.pid, 7_000)]); }
  }, 45_000);
});
