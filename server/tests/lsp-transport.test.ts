import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { LspTransport } from "../src/lsp/transport.js";
import { LSP_LIMITS } from "../src/lsp/protocol.js";
import { MockLspServer, frame } from "./mock-lsp.js";

const mocks: MockLspServer[] = [];
async function setup(options = {}) {
  const mock = new MockLspServer(); mocks.push(mock); await mock.start();
  const socket = connect(mock.port, "127.0.0.1"); await new Promise<void>((r) => socket.once("connect", r));
  const transport = new LspTransport({ ...LSP_LIMITS, ...options }); transport.attach(socket, 7);
  return { mock, transport };
}
afterEach(async () => { await Promise.all(mocks.splice(0).map((m) => m.stop())); });

describe("LspTransport", () => {
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
    const { mock, transport } = await setup({ minRequestMs: 10 });
    const failed = transport.request("bad", {}, 1_000); await expect.poll(() => mock.messages.length).toBe(1);
    mock.error(mock.messages[0].id, -32602, "bad args", { field: "x" });
    await expect(failed).rejects.toMatchObject({ code: "godot_error", message: "bad args", data: { code: -32602, data: { field: "x" } } });
    await expect(transport.request("slow", {}, 10)).rejects.toMatchObject({ code: "timeout" });
    await expect(transport.request("after-timeout", {}, 10)).rejects.toMatchObject({ code: "timeout" });
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
    const { mock, transport } = await setup({ maxPending: 1, maxBufferBytes: 16 });
    void transport.request("held", {}, 1_000).catch(() => undefined); await expect.poll(() => mock.messages.length).toBe(1);
    await expect(transport.request("extra", {}, 1_000)).rejects.toMatchObject({ code: "godot_error" });
    const closed = new Promise<Error>((resolve) => transport.onClosed(resolve)); mock.sendRaw("x".repeat(17));
    await expect(closed).resolves.toMatchObject({ code: "godot_error" });
  });
});
