import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import type { ClientStatus } from "../src/bridge/ws-client.js";
import { GodotMcpError } from "../src/errors.js";
import { serializeJsonRpcRequest } from "../src/bridge/json-rpc.js";

const connected: ClientStatus = { state: "connected", url: "ws://127.0.0.1:9200", connectedSince: "2026-01-01T00:00:00Z", reconnectAttempt: 0, lastError: undefined };

async function harness(call = vi.fn(), mode: "full" | "read_only" | "confirm_destructive" = "full", docsLoader?: () => Promise<any>) {
  const server = createServer({ bridge: { getStatus: () => connected, call }, mode, ...(docsLoader ? { docsLoader } : {}) });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, call, close: () => Promise.all([client.close(), server.close()]) };
}
const errorPayload = (result: any) => JSON.parse(result.content[0].text);

describe("Phase 2 MCP tools", () => {
  it("lists exactly five Phase 2 tools after the three Phase 1 probes with strict schemas and accurate annotations", async () => {
    const fixture = await harness();
    try {
      const { tools } = await fixture.client.listTools();
      expect(tools.slice(0, 8).map((tool) => tool.name)).toEqual([
        "godot_connection_status", "godot_get_version", "godot_ping",
        "godot_script_run", "godot_api_list_classes", "godot_api_describe_class", "godot_api_search", "godot_api_class_doc",
      ]);
      expect(tools.some((tool) => tool.name === "run_editor_script")).toBe(false);
      for (const tool of tools.slice(3, 8)) expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tools[3]?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
      for (const tool of tools.slice(4, 8)) expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    } finally { await fixture.close(); }
  });

  it("maps script execution through the universal policy gate and applies defaults", async () => {
    const result = { ok: true, returnValue: 42, stdout: "", errors: [], elapsedMs: 1, truncated: false };
    const fixture = await harness(vi.fn().mockResolvedValue(result));
    try {
      const response = await fixture.client.callTool({ name: "godot_script_run", arguments: { source: "func __run(args):\n\treturn 42", allowDangerous: true } });
      expect(response.structuredContent).toEqual(result);
      expect(fixture.call).toHaveBeenCalledWith("exec.run", { source: "func __run(args):\n\treturn 42", args: null, outputCapBytes: 262144 }, { timeoutMs: 15000, maxRequestBytes: 32768 });
    } finally { await fixture.close(); }
  });

  it("preflights exact serialized exec frames at the 32768-byte boundary without dispatching oversized args", async () => {
    const dispatched = vi.fn();
    const call = vi.fn(async (method: string, params: unknown, options?: { maxRequestBytes?: number }) => {
      const frame = serializeJsonRpcRequest(1, method, params);
      if (options?.maxRequestBytes !== undefined && Buffer.byteLength(frame, "utf8") > options.maxRequestBytes) {
        throw new GodotMcpError("invalid_args", "Serialized editor request exceeds 32768 UTF-8 bytes.", "Reduce script source or arguments.");
      }
      dispatched();
      return { ok: true, returnValue: null, stdout: "", errors: [], elapsedMs: 0, truncated: false };
    });
    const fixture = await harness(call);
    try {
      const base = { source: "func __run(args):\n\treturn args", args: { value: "" }, outputCapBytes: 262144 };
      const emptySize = Buffer.byteLength(serializeJsonRpcRequest(1, "exec.run", base), "utf8");
      const exactArgs = { value: "x".repeat(32768 - emptySize) };
      const exact = await fixture.client.callTool({ name: "godot_script_run", arguments: { source: base.source, args: exactArgs, allowDangerous: true } });
      expect(exact.isError).not.toBe(true);
      const over = await fixture.client.callTool({ name: "godot_script_run", arguments: { source: base.source, args: { value: `${exactArgs.value}é` }, allowDangerous: true } });
      expect(over.isError).toBe(true); expect(errorPayload(over)).toMatchObject({ code: "invalid_args", hint: expect.stringMatching(/reduce script source or arguments/i) });
      expect(dispatched).toHaveBeenCalledTimes(1);
    } finally { await fixture.close(); }
  });

  it("rejects malformed six-key execution responses as a compatibility error", async () => {
    const fixture = await harness(vi.fn().mockResolvedValue({ ok: true, returnValue: null, stdout: "", errors: [], elapsedMs: 1, truncated: false, extra: true }));
    try {
      const result = await fixture.client.callTool({ name: "godot_script_run", arguments: { source: "func __run(args):\n\treturn null", allowDangerous: true } });
      expect(result.isError).toBe(true); expect(errorPayload(result)).toMatchObject({ code: "godot_error", hint: expect.stringMatching(/compatible/i) });
    } finally { await fixture.close(); }
  });

  it("returns actionable policy and strict-input errors without dispatch", async () => {
    const fixture = await harness(vi.fn(), "read_only");
    try {
      const blocked = await fixture.client.callTool({ name: "godot_script_run", arguments: { source: "func __run(args):\n\treturn 1", allowDangerous: true } });
      expect(blocked.isError).toBe(true); expect(errorPayload(blocked)).toMatchObject({ code: "blocked_by_policy", hint: expect.stringMatching(/full mode/i) });
      const invalid = await fixture.client.callTool({ name: "godot_api_list_classes", arguments: { offset: 0, limit: 10, extra: true } });
      expect(invalid).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/unrecognized key/i) }] });
      const overBytes = await fixture.client.callTool({ name: "godot_api_search", arguments: { query: "é".repeat(65) } });
      expect(overBytes).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/128 UTF-8 bytes/i) }] });
      expect(fixture.call).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  it("returns blocked_by_policy when full mode omits the per-call capability", async () => {
    const fixture = await harness();
    try {
      const blocked = await fixture.client.callTool({ name: "godot_script_run", arguments: { source: "func __run(args):\n\treturn 1" } });
      expect(blocked.isError).toBe(true); expect(errorPayload(blocked)).toMatchObject({ code: "blocked_by_policy", hint: expect.stringMatching(/allowDangerous true/i) });
      expect(fixture.call).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  it.each([
    ["godot_api_list_classes", { offset: 2, limit: 10 }, "introspection.list_classes"],
    ["godot_api_describe_class", { class: "Node", memberOffset: 1, memberLimit: 20 }, "introspection.describe_class"],
    ["godot_api_search", { query: "mesh", offset: 0, limit: 20 }, "introspection.search"],
  ] as const)("maps %s deterministically to %s", async (name, args, method) => {
    const payload = name === "godot_api_list_classes" ? { classes: ["Node"], total: 1, offset: 2, limit: 10, hasMore: false }
      : name === "godot_api_search" ? { query: "mesh", results: [{ kind: "class", class: "Mesh" }], total: 1, offset: 0, limit: 20, hasMore: false }
      : { class: "Node", inherits: "Object", includeInherited: false, memberPage: { offset: 1, limit: 20, total: 0, hasMore: false }, methods: [], properties: [], signals: [], enums: [], constants: [] };
    const fixture = await harness(vi.fn().mockResolvedValue(payload));
    try {
      const result = await fixture.client.callTool({ name, arguments: args });
      expect(result.structuredContent).toEqual(payload);
      expect(fixture.call).toHaveBeenCalledWith(method, args);
    } finally { await fixture.close(); }
  });

  it("maps class docs locally while using the live editor only for its version gate", async () => {
    const call = vi.fn().mockResolvedValue({ engine: { major: 4, minor: 6, patch: 2 } });
    const fixture = await harness(call);
    try {
      const result = await fixture.client.callTool({ name: "godot_api_class_doc", arguments: { class: "Node", member: { kind: "method", name: "add_child" } } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ class: "Node", engineVersion: "4.6.2", member: { kind: "method", name: "add_child" } });
      expect(call).toHaveBeenCalledWith("core.get_version");
    } finally { await fixture.close(); }
  });

  it.each(["constructor", "toString", "__proto__"])("rejects prototype-like class key %s consistently with and without a member selector", async (className) => {
    const call = vi.fn().mockResolvedValue({ engine: { major: 4, minor: 6, patch: 2 } });
    const fixture = await harness(call);
    try {
      for (const arguments_ of [
        { class: className },
        { class: className, member: { kind: "method", name: "toString" } },
      ]) {
        const result = await fixture.client.callTool({ name: "godot_api_class_doc", arguments: arguments_ });
        expect(result.isError).toBe(true); expect(errorPayload(result)).toMatchObject({ code: "invalid_args", message: `Unknown documented class '${className}'.` });
      }
    } finally { await fixture.close(); }
  });

  it.each([
    [new GodotMcpError("not_connected", "offline", "Open Godot"), "not_connected"],
    [{ engine: { major: 4, minor: 5, patch: 0 } }, "feature_disabled"],
  ])("gates class docs before touching a rejecting artifact loader", async (versionResult, code) => {
    const loader = vi.fn().mockRejectedValue(new Error("corrupt artifact"));
    const call = versionResult instanceof Error ? vi.fn().mockRejectedValue(versionResult) : vi.fn().mockResolvedValue(versionResult);
    const fixture = await harness(call, "full", loader);
    try {
      const result = await fixture.client.callTool({ name: "godot_api_class_doc", arguments: { class: "Node" } });
      expect(result.isError).toBe(true); expect(errorPayload(result)).toMatchObject({ code });
      expect(loader).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  it("normalizes malformed plugin payloads and propagates actionable bridge errors", async () => {
    const malformed = await harness(vi.fn().mockResolvedValue({ classes: "Node" }));
    try {
      const result = await malformed.client.callTool({ name: "godot_api_list_classes", arguments: {} });
      expect(result.isError).toBe(true); expect(errorPayload(result)).toMatchObject({ code: "godot_error", hint: expect.stringMatching(/compatible/i) });
    } finally { await malformed.close(); }
    const failure = new GodotMcpError("not_connected", "Godot editor is not connected.", "Open Godot and enable the plugin.");
    const offline = await harness(vi.fn().mockRejectedValue(failure));
    try {
      const result = await offline.client.callTool({ name: "godot_api_search", arguments: { query: "mesh" } });
      expect(result.isError).toBe(true); expect(errorPayload(result)).toMatchObject({ code: "not_connected", hint: expect.stringMatching(/open Godot/i) });
    } finally { await offline.close(); }
  });
});
