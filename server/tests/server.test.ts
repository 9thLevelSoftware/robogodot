import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import { runServer } from "../src/index.js";

describe("createServer", () => {
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
    const stop = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    return {
      signals, stop, close,
      run: () => runServer({
        bridge: { start, stop, getStatus: vi.fn() as never, call: vi.fn() as never },
        server: { connect, close }, transport: {} as never, signals,
      }),
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
});
