import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import { runServer } from "../src/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.GODOT_MCP_TOKEN ??= "0123456789abcdef0123456789abcdef";

describe("createServer", () => {
  it("exposes exactly the 31 reviewed public tools and no aliases", async () => {
    const server = createServer({});
    const client = new Client({ name: "inventory", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
        "godot_connection_status", "godot_get_version", "godot_ping", "godot_script_run",
        "godot_api_list_classes", "godot_api_describe_class", "godot_api_search", "godot_api_class_doc",
        "godot_node_add", "godot_node_delete", "godot_node_reparent", "godot_node_rename", "godot_node_duplicate",
        "godot_node_get", "godot_node_set_property", "godot_node_call_method", "godot_scene_instance",
        "godot_scene_open", "godot_scene_new", "godot_scene_save", "godot_scene_tree", "godot_scene_current",
        "godot_signal_list", "godot_signal_connect", "godot_signal_disconnect",
        "godot_resource_load", "godot_resource_create", "godot_resource_save",
        "godot_project_setting_get", "godot_project_setting_set", "godot_project_setting_list",
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it("identifies as godot-control-mcp version 0.1.0", () => {
    const server = createServer({});
    expect((server.server as unknown as { _serverInfo: unknown })._serverInfo).toEqual({ name: "godot-control-mcp", version: "0.1.0" });
  });

  it("writes nothing to stdout during construction", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      createServer({});
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });
});

describe("runServer lifecycle", () => {
  function runtime(start: () => void, connect: () => Promise<void>) {
    const signals = new EventEmitter();
    const input = new EventEmitter();
    const stop = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    const transport = {} as { onclose?: () => void };
    return {
      signals, input, stop, close,
      run: () => runServer({
        bridge: { start, stop, getStatus: vi.fn() as never, call: vi.fn() as never },
        server: { connect, close }, transport: transport as never, signals, input,
      }),
      transport,
    };
  }

  it("stops the bridge and removes signal listeners when bridge start throws", async () => {
    const failure = new Error("start failed");
    const fixture = runtime(() => { throw failure; }, vi.fn());
    await expect(fixture.run()).rejects.toBe(failure);
    expect(fixture.stop).toHaveBeenCalledOnce();
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.signals.listenerCount("SIGINT")).toBe(0);
    expect(fixture.signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("stops the bridge and removes signal listeners when MCP connect rejects", async () => {
    const failure = new Error("connect failed");
    const fixture = runtime(vi.fn(), vi.fn().mockRejectedValue(failure));
    await expect(fixture.run()).rejects.toBe(failure);
    expect(fixture.stop).toHaveBeenCalledOnce();
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.signals.listenerCount("SIGINT")).toBe(0);
    expect(fixture.signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("cleans up exactly once after a successful connection receives shutdown", async () => {
    const fixture = runtime(vi.fn(), vi.fn().mockResolvedValue(undefined));
    const running = fixture.run();
    await vi.waitFor(() => expect(fixture.signals.listenerCount("SIGTERM")).toBe(1));
    fixture.signals.emit("SIGTERM");
    await running;
    expect(fixture.stop).toHaveBeenCalledOnce();
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.signals.listenerCount("SIGINT")).toBe(0);
    expect(fixture.signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("treats stdin end as a normal idempotent shutdown request", async () => {
    const fixture = runtime(vi.fn(), vi.fn().mockResolvedValue(undefined));
    const running = fixture.run();
    await vi.waitFor(() => expect(fixture.input.listenerCount("end")).toBe(1));
    fixture.input.emit("end");
    fixture.input.emit("close");
    await running;
    expect(fixture.stop).toHaveBeenCalledOnce();
    expect(fixture.close).toHaveBeenCalledOnce();
  });
});
