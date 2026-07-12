import { connect } from "node:net";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { LspTransport } from "../src/lsp/transport.js";
import { LSP_LIMITS } from "../src/lsp/protocol.js";
import { MOCK_LSP_LIMITS, MockLspServer, frame } from "./mock-lsp.js";

const mocks: MockLspServer[] = [];
async function setup(options = {}) {
  const mock = new MockLspServer(); mocks.push(mock); await mock.start();
  const socket = connect(mock.port, "127.0.0.1"); await new Promise<void>((r) => socket.once("connect", r));
  const transport = new LspTransport({ ...LSP_LIMITS, ...options }); transport.attach(socket, 7);
  return { mock, transport };
}
afterEach(async () => { await Promise.all(mocks.splice(0).map((m) => m.stop())); });

describe("LspTransport", () => {
  it("fails closed when notification write completion stalls", async () => {
    class StalledDuplex extends Duplex {
      _read(): void {}
      _write(_chunk: Buffer, _encoding: BufferEncoding, _callback: (error?: Error | null) => void): void {}
    }
    const transport = new LspTransport({ ...LSP_LIMITS, minRequestMs: 10, defaultRequestMs: 20, writeCompletionMs: 10 });
    transport.attach(new StalledDuplex(), 1);
    await expect(transport.notify("initialized", {})).rejects.toMatchObject({ code: "timeout" });
    expect(transport.isAttached).toBe(false);
    await expect(transport.close()).resolves.toBeUndefined();
  });
  it("uses UTF-8 byte length and correlates out-of-order responses", async () => {
    const { mock, transport } = await setup();
    const first = transport.request<string>("alpha", { text: "é" }, 1_000);
    const second = transport.request<string>("beta", {}, 1_000);
    await expect.poll(() => mock.messages.length).toBe(2);
    const [a, b] = mock.messages;
    mock.sendCoalesced([{ jsonrpc: "2.0", id: b.id, result: "second" }, { jsonrpc: "2.0", id: a.id, result: "first" }]);
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    const encoded = frame({ jsonrpc: "2.0", id: 1, method: "alpha", params: { text: "é" } });
    const [header, body] = encoded.toString("utf8").split("\r\n\r\n");
    expect(header).toContain(`Content-Length: ${Buffer.byteLength(body!)}`);
  });

  it("decodes split responses and routes coalesced notifications", async () => {
    const { mock, transport } = await setup(); const events: any[] = [];
    transport.onNotification((event) => events.push(event));
    const result = transport.request<string>("split", {}, 1_000);
    await expect.poll(() => mock.messages.length).toBe(1);
    mock.sendSplit({ jsonrpc: "2.0", id: mock.messages[0].id, result: "ok" }, [1, 7, 19]);
    mock.sendCoalesced([{ jsonrpc: "2.0", method: "one", params: 1 }, { jsonrpc: "2.0", method: "two" }]);
    await expect(result).resolves.toBe("ok"); await expect.poll(() => events.length).toBe(2);
    expect(events).toEqual([{ generation: 7, method: "one", params: 1 }, { generation: 7, method: "two" }]);
  });

  it("maps LSP errors and removes timed-out pending requests", async () => {
    const { mock, transport } = await setup({ minRequestMs: 10, maxPending: 1 });
    const failed = transport.request("bad", {}, 1_000); await expect.poll(() => mock.messages.length).toBe(1);
    mock.error(mock.messages[0].id, -32602, "bad args", { field: "x" });
    await expect(failed).rejects.toMatchObject({ code: "godot_error", message: "bad args", data: { code: -32602, data: { field: "x" } } });
    await expect(transport.request("slow", {}, 10)).rejects.toMatchObject({ code: "timeout" });
    const admitted = transport.request<string>("after-timeout", {}, 1_000);
    await expect.poll(() => mock.messages.length).toBe(3);
    mock.result(mock.messages[2].id, "admitted");
    await expect(admitted).resolves.toBe("admitted");
  });

  it.each([
    { maxFrameBytes: Number.NaN }, { maxBufferBytes: Number.POSITIVE_INFINITY },
    { maxPending: -1 }, { maxPending: 1.5 }, { maxFrameBytes: 20, maxBufferBytes: 10 },
  ])("rejects invalid transport options: %j", (invalid) => {
    expect(() => new LspTransport({ ...LSP_LIMITS, ...invalid })).toThrowError(expect.objectContaining({ code: "godot_error" }));
  });

  it("isolates notification subscriber exceptions", async () => {
    const { mock, transport } = await setup(); const events: string[] = [];
    transport.onNotification(() => { throw new Error("listener failed"); });
    transport.onNotification((event) => events.push(event.method));
    mock.notify("still/healthy");
    await expect.poll(() => events).toEqual(["still/healthy"]);
    expect(transport.isAttached).toBe(true);
  });

  it("isolates closed subscriber exceptions and completes cleanup", async () => {
    const { transport } = await setup(); const calls: string[] = [];
    transport.onClosed(() => { calls.push("first"); throw new Error("listener failed"); });
    transport.onClosed(() => calls.push("second"));
    await expect(transport.close()).resolves.toBeUndefined();
    expect(calls).toEqual(["first", "second"]); expect(transport.isAttached).toBe(false);
  });

  it("rejects oversized requests without writing or consuming a pending slot", async () => {
    const { mock, transport } = await setup({ maxFrameBytes: 80, maxPending: 1 });
    await expect(transport.request("huge", { text: "x".repeat(200) }, 1_000)).rejects.toMatchObject({ code: "godot_error" });
    expect(mock.messages).toHaveLength(0);
    const valid = transport.request<string>("ok", {}, 1_000);
    await expect.poll(() => mock.messages.length).toBe(1);
    mock.result(mock.messages[0].id, "accepted");
    await expect(valid).resolves.toBe("accepted");
  });

  it("rejects oversized notifications without writing bytes", async () => {
    const { mock, transport } = await setup({ maxFrameBytes: 80 });
    await expect(transport.notify("huge", { text: "é".repeat(100) })).rejects.toMatchObject({ code: "godot_error" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mock.messages).toHaveLength(0);
  });

  it("copies validated options so caller mutation cannot change limits", async () => {
    const mock = new MockLspServer(); mocks.push(mock); await mock.start();
    const socket = connect(mock.port, "127.0.0.1"); await new Promise<void>((r) => socket.once("connect", r));
    const options = { ...LSP_LIMITS, maxFrameBytes: 80 };
    const transport = new LspTransport(options); transport.attach(socket, 1);
    options.maxFrameBytes = 10_000;
    await expect(transport.notify("huge", { text: "x".repeat(200) })).rejects.toMatchObject({ code: "godot_error" });
    expect(mock.messages).toHaveLength(0);
  });

  it("bounds the mock receive buffer and rejects oversized frames", async () => {
    const mock = new MockLspServer(); mocks.push(mock); await mock.start();
    const socket = connect(mock.port, "127.0.0.1"); await new Promise<void>((r) => socket.once("connect", r));
    socket.write("x".repeat(MOCK_LSP_LIMITS.maxBufferBytes + 1));
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    expect(mock.messages).toHaveLength(0);

    const second = connect(mock.port, "127.0.0.1"); await new Promise<void>((r) => second.once("connect", r));
    second.write(`Content-Length: ${MOCK_LSP_LIMITS.maxFrameBytes + 1}\r\n\r\n`);
    await new Promise<void>((resolve) => second.once("close", () => resolve()));
    expect(mock.messages).toHaveLength(0);
  });

  it("caps messages recorded by the mock", async () => {
    const mock = new MockLspServer(); mocks.push(mock); await mock.start();
    const socket = connect(mock.port, "127.0.0.1"); await new Promise<void>((r) => socket.once("connect", r));
    socket.write(Buffer.concat(Array.from({ length: MOCK_LSP_LIMITS.maxRecordedMessages + 1 }, (_, id) => frame({ jsonrpc: "2.0", id, method: "x" }))));
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    expect(mock.messages).toHaveLength(MOCK_LSP_LIMITS.maxRecordedMessages);
  });

  it("rejects pending requests and emits closed once", async () => {
    const { mock, transport } = await setup(); const closed: Error[] = [];
    transport.onClosed((error) => closed.push(error));
    const pending = transport.request("pending", {}, 1_000); await expect.poll(() => mock.messages.length).toBe(1);
    await transport.close();
    await expect(pending).rejects.toMatchObject({ code: "not_connected" });
    expect(closed).toHaveLength(1); expect(transport.isAttached).toBe(false);
  });

  it.each([
    ["missing length", "X: 1\r\n\r\n{}"],
    ["duplicate length", "Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}"],
    ["negative length", "Content-Length: -1\r\n\r\n"],
    ["invalid JSON", "Content-Length: 1\r\n\r\n{"],
    ["oversized body", `Content-Length: ${1_048_577}\r\n\r\n`],
  ])("fails closed for %s", async (_fixture, bytes) => {
    const { mock, transport } = await setup();
    const closed = new Promise<Error>((resolve) => transport.onClosed(resolve)); mock.sendRaw(bytes);
    await expect(closed).resolves.toMatchObject({ code: "godot_error" }); expect(transport.isAttached).toBe(false);
  });

  it("enforces pending and buffer bounds", async () => {
    const { mock, transport } = await setup({ maxPending: 1, maxFrameBytes: 80, maxBufferBytes: 80 });
    void transport.request("held", {}, 1_000).catch(() => undefined); await expect.poll(() => mock.messages.length).toBe(1);
    await expect(transport.request("extra", {}, 1_000)).rejects.toMatchObject({ code: "godot_error" });
    const closed = new Promise<Error>((resolve) => transport.onClosed(resolve)); mock.sendRaw("x".repeat(81));
    await expect(closed).resolves.toMatchObject({ code: "godot_error" });
  });
});
