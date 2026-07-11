import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../src/logger.js";
import { GodotMcpError } from "../src/errors.js";
import { JsonRpcClient } from "../src/bridge/ws-client.js";
import { serializeJsonRpcRequest } from "../src/bridge/json-rpc.js";

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  readyState = 0;
  send(data: string) { this.sent.push(data); }
  open() { this.readyState = 1; this.emit("open"); }
  message(value: string | Buffer) { this.emit("message", value, typeof value !== "string"); }
  rawText(value: string) { this.emit("message", Buffer.from(value), false); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
  fail(error = new Error("refused")) { this.emit("error", error); this.close(); }
}

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
function harness(options: Record<string, unknown> = {}) {
  const sockets: FakeSocket[] = [];
  const log = logger();
  const client = new JsonRpcClient({
    url: "ws://127.0.0.1:9080", token: "0123456789abcdef0123456789abcdef", logger: log,
    webSocketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 5_000, ...options,
  });
  return { client, sockets, log };
}
function request(socket: FakeSocket, index = -1) { return JSON.parse(socket.sent.at(index)!); }
function authenticate(socket: FakeSocket) {
  socket.open();
  socket.message(JSON.stringify({ jsonrpc: "2.0", id: 0, result: { authenticated: true } }));
}

afterEach(() => { vi.useRealTimers(); });

describe("JsonRpcClient", () => {
  it("authenticates before becoming connected or allowing command calls", async () => {
    const { client, sockets } = harness();
    client.start(); sockets[0]!.open();
    expect(client.getStatus().state).toBe("connecting");
    expect(request(sockets[0]!)).toEqual({
      jsonrpc: "2.0", id: 0, method: "auth.authenticate",
      params: { token: "0123456789abcdef0123456789abcdef" },
    });
    await expect(client.call("core.ping")).rejects.toMatchObject({ code: "not_connected" });
    sockets[0]!.message(JSON.stringify({ jsonrpc: "2.0", id: 0, result: { authenticated: true } }));
    expect(client.getStatus().state).toBe("connected");
    client.stop();
  });

  it("closes and reconnects when authentication is rejected", async () => {
    const { client, sockets } = harness();
    client.start(); sockets[0]!.open();
    sockets[0]!.message(JSON.stringify({ jsonrpc: "2.0", id: 0, error: { code: -32001, message: "Authentication failed" } }));
    expect(sockets[0]!.readyState).toBe(3);
    expect(client.getStatus()).toMatchObject({ state: "reconnecting" });
    client.stop();
  });

  it("advances capped reconnect backoff across repeated authentication rejection", async () => {
    vi.useFakeTimers();
    const { client, sockets } = harness();
    client.start();
    for (const [delay, attempt] of [[1000, 1], [2000, 2], [4000, 3]] as const) {
      sockets.at(-1)!.open();
      sockets.at(-1)!.message(JSON.stringify({ jsonrpc: "2.0", id: 0, error: { code: -32001, message: "Authentication failed" } }));
      const count = sockets.length;
      expect(client.getStatus()).toMatchObject({ state: "reconnecting", reconnectAttempt: attempt });
      await vi.advanceTimersByTimeAsync(delay - 1); expect(sockets).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1); expect(sockets).toHaveLength(count + 1);
    }
    client.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(4);
  });

  it("closes and reconnects when authentication receives no response", async () => {
    vi.useFakeTimers();
    const { client, sockets } = harness({ heartbeatTimeoutMs: 50 });
    client.start(); sockets[0]!.open();
    await vi.advanceTimersByTimeAsync(50);
    expect(sockets[0]!.readyState).toBe(3);
    expect(client.getStatus()).toMatchObject({ state: "reconnecting", lastError: "Editor authentication timed out" });
    client.stop();
  });

  it("advances reconnect backoff across repeated authentication timeouts", async () => {
    vi.useFakeTimers();
    const { client, sockets } = harness({ heartbeatTimeoutMs: 50 });
    client.start();
    for (const delay of [1000, 2000, 4000]) {
      sockets.at(-1)!.open();
      await vi.advanceTimersByTimeAsync(50);
      const count = sockets.length;
      await vi.advanceTimersByTimeAsync(delay - 1); expect(sockets).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1); expect(sockets).toHaveLength(count + 1);
    }
    client.stop();
  });
  it("unrefs call, heartbeat, heartbeat-call, and reconnect timers when supported", async () => {
    const timeoutCallbacks: Array<() => void> = [];
    const intervalCallbacks: Array<() => void> = [];
    const timeoutUnrefs: ReturnType<typeof vi.fn>[] = [];
    const intervalUnrefs: ReturnType<typeof vi.fn>[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      timeoutCallbacks.push(callback); const unref = vi.fn(); timeoutUnrefs.push(unref); return { unref };
    }) as typeof setTimeout);
    vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
      intervalCallbacks.push(callback); const unref = vi.fn(); intervalUnrefs.push(unref); return { unref };
    }) as typeof setInterval);
    const { client, sockets } = harness(); client.start(); authenticate(sockets[0]!);
    const userCall = client.call("work");
    expect(intervalUnrefs[0]).toHaveBeenCalledOnce();
    expect(timeoutUnrefs[0]).toHaveBeenCalledOnce();
    intervalCallbacks[0]!();
    expect(timeoutUnrefs[1]).toHaveBeenCalledOnce();
    const userAssertion = expect(userCall).rejects.toMatchObject({ code: "not_connected" });
    sockets[0]!.close(); await userAssertion;
    expect(timeoutUnrefs[2]).toHaveBeenCalledOnce();
    client.stop();
  });

  it("uses strict requests with increasing IDs and correlates out of order", async () => {
    const { client, sockets } = harness(); client.start(); authenticate(sockets[0]!);
    const first = client.call<string>("first", { x: 1 });
    const second = client.call<string>("second");
    expect(sockets[0]!.sent.slice(1).map(JSON.parse)).toEqual([
      { jsonrpc: "2.0", id: 1, method: "first", params: { x: 1 } },
      { jsonrpc: "2.0", id: 2, method: "second" },
    ]);
    sockets[0]!.message(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "B" }));
    sockets[0]!.message(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "A" }));
    await expect(first).resolves.toBe("A"); await expect(second).resolves.toBe("B"); client.stop();
  });

  it("checks the exact serialized frame cap before socket send", async () => {
    const { client, sockets } = harness(); client.start(); authenticate(sockets[0]!);
    const base = { value: "" };
    const overhead = Buffer.byteLength(serializeJsonRpcRequest(1, "exec.run", base), "utf8");
    const exact = client.call("exec.run", { value: "x".repeat(32768 - overhead) }, { maxRequestBytes: 32768 });
    expect(Buffer.byteLength(sockets[0]!.sent.at(-1)!, "utf8")).toBe(32768);
    sockets[0]!.message(JSON.stringify({ jsonrpc: "2.0", id: 1, result: true }));
    await expect(exact).resolves.toBe(true);
    await expect(client.call("exec.run", { value: "x".repeat(32768 - overhead + 1) }, { maxRequestBytes: 32768 })).rejects.toMatchObject({ code: "invalid_args" });
    expect(sockets[0]!.sent).toHaveLength(2);
    expect(client.getStatus().state).toBe("connected");
    client.stop();
  });

  it("decodes ws text frames delivered as buffers", async () => {
    const { client, sockets } = harness(); client.start(); authenticate(sockets[0]!);
    const pending = client.call<string>("buffered");
    sockets[0]!.rawText(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }));
    await expect(pending).resolves.toBe("ok"); client.stop();
  });

  it("ignores malformed, binary, notifications and unknown IDs with warnings", async () => {
    const { client, sockets, log } = harness(); client.start(); authenticate(sockets[0]!);
    const pending = client.call("work");
    sockets[0]!.message("garbage"); sockets[0]!.message(Buffer.from("{}"));
    sockets[0]!.message(JSON.stringify({ jsonrpc: "2.0", method: "notice" }));
    sockets[0]!.message(JSON.stringify({ jsonrpc: "2.0", id: 99, result: true }));
    expect(log.warn).toHaveBeenCalledTimes(4);
    sockets[0]!.message(JSON.stringify({ jsonrpc: "2.0", id: 1, result: true }));
    await expect(pending).resolves.toBe(true); client.stop();
  });

  it("maps JSON-RPC errors and call timeouts to stable errors with cleanup", async () => {
    vi.useFakeTimers(); const { client, sockets } = harness(); client.start(); authenticate(sockets[0]!);
    const remote = client.call("bad");
    sockets[0]!.message(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad args", data: { hint: "fix it" } } }));
    await expect(remote).rejects.toMatchObject({ name: "GodotMcpError", code: "godot_error", message: "bad args", hint: "fix it" });
    const late = client.call("slow", undefined, { timeoutMs: 50 });
    const assertion = expect(late).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(50); await assertion;
    sockets[0]!.message(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "late" }));
    expect(vi.getTimerCount()).toBe(1); client.stop(); expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects calls when disconnected and every pending call once on close", async () => {
    const { client, sockets } = harness();
    await expect(client.call("nope")).rejects.toBeInstanceOf(GodotMcpError);
    client.start(); authenticate(sockets[0]!); const a = client.call("a"); const b = client.call("b");
    const aa = expect(a).rejects.toMatchObject({ code: "not_connected" });
    const bb = expect(b).rejects.toMatchObject({ code: "not_connected" });
    sockets[0]!.close(); await aa; await bb; client.stop();
  });

  it("settles once when response, timeout, and duplicate close compete", async () => {
    vi.useFakeTimers(); const { client, sockets } = harness(); client.start(); authenticate(sockets[0]!);
    let settlements = 0;
    const call = client.call<string>("race", undefined, { timeoutMs: 20 }).then(
      (value) => { settlements++; return value; },
      (error: unknown) => { settlements++; throw error; },
    );
    sockets[0]!.message(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "winner" }));
    sockets[0]!.message(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "duplicate" }));
    sockets[0]!.close(); sockets[0]!.close();
    await vi.advanceTimersByTimeAsync(20);
    await expect(call).resolves.toBe("winner"); expect(settlements).toBe(1); client.stop();
  });

  it("ignores error and close events from a stale replaced socket", async () => {
    vi.useFakeTimers(); const { client, sockets } = harness(); client.start(); sockets[0]!.fail();
    await vi.advanceTimersByTimeAsync(1000); authenticate(sockets[1]!);
    const call = client.call<string>("current");
    sockets[0]!.emit("error", new Error("stale")); sockets[0]!.emit("close");
    expect(client.getStatus()).toMatchObject({ state: "connected", lastError: undefined });
    sockets[1]!.message(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }));
    await expect(call).resolves.toBe("ok"); client.stop();
  });

  it("emits lifecycle order and exact capped reconnect delays without duplicates", async () => {
    vi.useFakeTimers(); const { client, sockets } = harness(); const states: string[] = [];
    client.on("status", (status) => states.push(status.state)); client.start();
    expect(states).toEqual(["connecting"]);
    for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
      sockets.at(-1)!.fail(); sockets.at(-1)!.close();
      expect(states.at(-1)).toBe("reconnecting"); expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(delay - 1); const count = sockets.length;
      await vi.advanceTimersByTimeAsync(1); expect(sockets).toHaveLength(count + 1); expect(states.at(-1)).toBe("connecting");
    }
    client.stop(); expect(states.at(-1)).toBe("disconnected"); expect(vi.getTimerCount()).toBe(0);
  });

  it("resets reconnect attempts after open and reports status snapshots", async () => {
    vi.useFakeTimers(); const { client, sockets } = harness(); client.start(); sockets[0]!.fail();
    expect(client.getStatus()).toMatchObject({ state: "reconnecting", reconnectAttempt: 1, url: "ws://127.0.0.1:9080" });
    await vi.advanceTimersByTimeAsync(1000); authenticate(sockets[1]!);
    expect(client.getStatus()).toMatchObject({ state: "connected", reconnectAttempt: 0, lastError: undefined });
    expect(client.getStatus().connectedSince).toEqual(expect.any(String));
    sockets[1]!.close(); await vi.advanceTimersByTimeAsync(999); expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); expect(sockets).toHaveLength(3); client.stop();
  });

  it("uses non-overlapping core.ping calls for heartbeat and accepts success", async () => {
    vi.useFakeTimers(); const { client, sockets } = harness({ heartbeatIntervalMs: 100, heartbeatTimeoutMs: 40 });
    client.start(); authenticate(sockets[0]!); await vi.advanceTimersByTimeAsync(100);
    expect(request(sockets[0]!).method).toBe("core.ping");
    await vi.advanceTimersByTimeAsync(20); expect(sockets[0]!.sent).toHaveLength(2);
    sockets[0]!.message(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { pong: true } }));
    await vi.advanceTimersByTimeAsync(80); expect(sockets[0]!.sent).toHaveLength(3); client.stop();
  });

  it("closes and reconnects after a missed heartbeat, while stop prevents reconnect", async () => {
    vi.useFakeTimers(); const { client, sockets } = harness({ heartbeatIntervalMs: 100, heartbeatTimeoutMs: 40 });
    client.start(); authenticate(sockets[0]!); await vi.advanceTimersByTimeAsync(140);
    expect(sockets[0]!.readyState).toBe(3); expect(client.getStatus().state).toBe("reconnecting");
    client.stop(); await vi.advanceTimersByTimeAsync(60_000); expect(sockets).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });
});
