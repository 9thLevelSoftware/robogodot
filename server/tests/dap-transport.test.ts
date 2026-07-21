import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAP_LIMITS, DapTransport } from "../src/runtime/dap-transport.js";
import { dapFrame, MockDapServer } from "./mock-dap.js";

const mocks: MockDapServer[] = [];
async function setup(options = {}) { const mock = new MockDapServer(); mocks.push(mock); await mock.start(); const socket = connect(mock.port, "127.0.0.1"); await new Promise<void>((r) => socket.once("connect", r)); const transport = new DapTransport({ ...DAP_LIMITS, ...options }); transport.attach(socket); return { mock, transport }; }
afterEach(async () => { vi.useRealTimers(); await Promise.all(mocks.splice(0).map((mock) => mock.stop())); });

describe("DapTransport", () => {
  it("uses UTF-8 byte framing, monotonic numeric seq, and correlates coalesced responses", async () => {
    const { mock, transport } = await setup(); const a = transport.request<string>("one", { text: "é" }); const b = transport.request<string>("two", {});
    await expect.poll(() => mock.messages.length).toBe(2); expect(mock.messages.map((m) => m.seq)).toEqual([1, 2]);
    mock.sendCoalesced([{ seq: 9, type: "response", request_seq: 2, success: true, command: "two", body: "b" }, { seq: 10, type: "response", request_seq: 1, success: true, command: "one", body: "a" }]);
    await expect(Promise.all([a, b])).resolves.toEqual(["a", "b"]); const framed = dapFrame(mock.messages[0]); const [header, body] = framed.toString().split("\r\n\r\n"); expect(header).toContain(`Content-Length: ${Buffer.byteLength(body!)}`);
  });
  it("handles fragmented frames, emits strict events, and isolates listeners", async () => {
    const { mock, transport } = await setup(); const events: any[] = []; transport.onEvent(() => { throw new Error("subscriber"); }); transport.onEvent((event) => events.push(event));
    const pending = transport.request("x", {}); await expect.poll(() => mock.messages.length).toBe(1); mock.sendSplit({ seq: 4, type: "response", request_seq: 1, success: true, command: "x", body: 7 }, [1, 8, 27]); await expect(pending).resolves.toBe(7);
    mock.event("stopped", { reason: "breakpoint", threadId: 1 }); await expect.poll(() => events.length).toBe(1); expect(events[0]).toMatchObject({ type: "event", event: "stopped" });
  });
  it("maps response errors, enforces pending bounds and deadlines, then admits new work", async () => {
    const { mock, transport } = await setup({ maxPending: 1, minRequestMs: 10, defaultRequestMs: 100 }); const bad = transport.request("bad", {}); await expect.poll(() => mock.messages.length).toBe(1); mock.error(mock.messages[0], "bad args"); await expect(bad).rejects.toMatchObject({ code: "godot_error", message: "bad args" });
    const held = transport.request("held", {}, 1_000); await expect.poll(() => mock.messages.length).toBe(2); await expect(transport.request("extra", {})).rejects.toMatchObject({ code: "godot_error" }); mock.respond(mock.messages[1]); await held;
    await expect(transport.request("slow", {}, 10)).rejects.toMatchObject({ code: "timeout" });
  });
  it.each(["X: 1\r\n\r\n{}", "Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}", "Content-Length: -1\r\n\r\n", "Content-Length: 1\r\n\r\n{", `Content-Length: ${1_048_577}\r\n\r\n`])("fails closed on malformed or oversized input", async (bytes) => {
    const { mock, transport } = await setup(); const closed = new Promise<Error>((resolve) => transport.onClosed(resolve)); mock.sendRaw(bytes); await expect(closed).resolves.toMatchObject({ code: "godot_error" }); expect(transport.isAttached).toBe(false);
  });
  it("bounds incomplete headers and total buffering", async () => { const { mock, transport } = await setup({ maxFrameBytes: 64, maxBufferBytes: 64 }); const closed = new Promise<Error>((resolve) => transport.onClosed(resolve)); mock.sendRaw("x".repeat(65)); await expect(closed).resolves.toMatchObject({ code: "godot_error" }); expect(transport.isAttached).toBe(false); });
  it("rejects pending work on close and never shares LSP generations or IDs", async () => { const { mock, transport } = await setup(); const p = transport.request("held", {}); await expect.poll(() => mock.messages.length).toBe(1); expect(mock.messages[0]).not.toHaveProperty("jsonrpc"); await transport.close(); await expect(p).rejects.toMatchObject({ code: "not_connected" }); });
  it("exhausts numeric sequence IDs deterministically without wrapping", async () => {
    const { mock, transport } = await setup(); (transport as any).nextSeq = Number.MAX_SAFE_INTEGER;
    const last = transport.request("last", {}); await expect.poll(() => mock.messages.length).toBe(1); expect(mock.messages[0].seq).toBe(Number.MAX_SAFE_INTEGER); mock.send({ seq: 1, type: "response", request_seq: Number.MAX_SAFE_INTEGER, success: true, command: "last", body: {} }); await last;
    await expect(transport.request("wrapped", {})).rejects.toMatchObject({ code: "godot_error" }); expect(mock.messages).toHaveLength(1);
  });
  it("ignores late and duplicate responses without settling another request", async () => {
    const { mock, transport } = await setup({ minRequestMs: 10, defaultRequestMs: 10 }); const late = transport.request("late", {}); const lateResult = late.catch((error) => error); await expect.poll(() => mock.messages.length).toBe(1); await expect(lateResult).resolves.toMatchObject({ code: "timeout" }); mock.respond(mock.messages[0], "too late");
    const current = transport.request<string>("current", {}, 1_000); await expect.poll(() => mock.messages.length).toBe(2); mock.respond(mock.messages[0], "duplicate"); mock.respond(mock.messages[1], "current"); await expect(current).resolves.toBe("current");
    mock.respond(mock.messages[1], "second duplicate"); expect(transport.isAttached).toBe(true);
  });
  it("clears transport subscribers after one-shot close notification", async () => {
    const { mock, transport } = await setup(); const closed: string[] = []; transport.onEvent(() => undefined); transport.onClosed(() => closed.push("first")); transport.onClosed(() => closed.push("second")); mock.sendRaw("invalid\r\n\r\n{}");
    await expect.poll(() => closed).toEqual(["first", "second"]); expect((transport as any).eventListeners.size).toBe(0); expect((transport as any).closedListeners.size).toBe(0); await transport.close(); expect(closed).toEqual(["first", "second"]);
  });
});
