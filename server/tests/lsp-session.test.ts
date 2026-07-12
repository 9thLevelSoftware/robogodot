import { afterEach, describe, expect, it, vi } from "vitest";
import { connect } from "node:net";
import { LspSession } from "../src/lsp/session.js";
import { MockLspServer } from "./mock-lsp.js";

const mocks: MockLspServer[] = [];
const sessions: LspSession[] = [];

async function setup(schedule?: (delayMs: number, work: () => void) => () => void) {
  const mock = new MockLspServer(); mocks.push(mock); await mock.start();
  const session = new LspSession({ host: "127.0.0.1", port: mock.port, projectRootUri: "file:///project", schedule });
  sessions.push(session); return { mock, session };
}

function initializeGodot(mock: MockLspServer, version = "4.6.2.stable") {
  mock.onRequest("initialize", ({ id }) => mock.result(id, {
    capabilities: { completionProvider: {}, hoverProvider: true, documentSymbolProvider: true },
    serverInfo: { name: "Godot", version },
  }));
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await Promise.all(mocks.splice(0).map((mock) => mock.stop()));
});

describe("LspSession", () => {
  it("does not publish a generation closed while replay is pending", async () => {
    let release!: () => void;
    const replay = new Promise<void>((resolve) => { release = resolve; });
    const schedule = (_delay: number, work: () => void) => { queueMicrotask(work); return () => undefined; };
    const { mock, session } = await setup(schedule); initializeGodot(mock); await session.ensureReady();
    session.setReplayHook(() => replay);
    mock.sendMalformed();
    await expect.poll(() => mock.messages.filter((message) => message.method === "initialize").length).toBe(2);
    await expect.poll(() => session.state).toBe("initializing");
    const closing = session.close(); release(); await closing;
    expect(session.state).toBe("exited");
    expect(session.ready).toBeUndefined();
  });

  it("does not let a stale replay failure close the newer generation", async () => {
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
    const schedule = (_delay: number, work: () => void) => { queueMicrotask(work); return () => undefined; };
    const { mock, session } = await setup(schedule); initializeGodot(mock); await session.ensureReady();
    session.setReplayHook((generation) => generation === 2 ? held : Promise.resolve());
    mock.sendMalformed();
    await expect.poll(() => session.state).toBe("initializing");
    mock.sendMalformed();
    await expect.poll(() => session.ready?.generation).toBe(3);
    release(); await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.state).toBe("ready"); expect(session.ready?.generation).toBe(3);
  });

  it("times out replay and closes that generation", async () => {
    const delays: number[] = [];
    const schedule = (delay: number, work: () => void) => { delays.push(delay); if (delays.length === 1) queueMicrotask(work); return () => undefined; };
    const mock = new MockLspServer(); mocks.push(mock); await mock.start(); initializeGodot(mock);
    const session = new LspSession({ host: "127.0.0.1", port: mock.port, projectRootUri: "file:///project", connectTimeoutMs: 10, schedule }); sessions.push(session);
    await session.ensureReady(); session.setReplayHook(() => new Promise(() => undefined)); mock.sendMalformed();
    await expect.poll(() => delays.length).toBe(2);
    expect(session.state).toBe("reconnecting"); expect(session.ready).toBeUndefined();
  });

  it("times out external hooks and settles close", async () => {
    const mock = new MockLspServer(); mocks.push(mock); await mock.start(); initializeGodot(mock);
    const session = new LspSession({ host: "127.0.0.1", port: mock.port, projectRootUri: "file:///project", connectTimeoutMs: 10, beforeConnect: () => new Promise(() => undefined) }); sessions.push(session);
    await expect(session.ensureReady()).rejects.toMatchObject({ code: "timeout" });
    await expect(session.close()).resolves.toBeUndefined();
  });

  it("cleans a failed first attempt and recovers on bounded reconnect", async () => {
    const mock = new MockLspServer(); mocks.push(mock); await mock.start(); initializeGodot(mock);
    let attempts = 0;
    const socketFactory = async () => {
      attempts++; if (attempts === 1) throw new Error("offline");
      const socket = connect(mock.port, "127.0.0.1"); await new Promise<void>((resolve) => socket.once("connect", resolve)); return socket;
    };
    const schedule = (_delay: number, work: () => void) => { queueMicrotask(work); return () => undefined; };
    const session = new LspSession({ host: "127.0.0.1", port: mock.port, projectRootUri: "file:///project", socketFactory, schedule }); sessions.push(session);
    await expect(session.ensureReady()).rejects.toThrow("offline");
    await expect.poll(() => session.state).toBe("ready");
    expect(attempts).toBe(2); expect(session.ready?.generation).toBe(1);
  });

  it("closes an invalid initialize generation and recovers", async () => {
    const schedule = (_delay: number, work: () => void) => { queueMicrotask(work); return () => undefined; };
    const { mock, session } = await setup(schedule); let calls = 0;
    mock.onRequest("initialize", ({ id }) => { calls++; mock.result(id, calls === 1 ? {} : { capabilities: {}, serverInfo: { name: "Godot", version: "4.6.2" } }); });
    await expect(session.ensureReady()).rejects.toMatchObject({ code: "godot_error" });
    await expect.poll(() => session.state).toBe("ready");
    expect(calls).toBe(2); expect(session.ready?.generation).toBe(2);
  });

  it.each(["error", "timeout"])("recovers after initialize %s", async (failure) => {
    const schedule = (_delay: number, work: () => void) => { queueMicrotask(work); return () => undefined; };
    const mock = new MockLspServer(); mocks.push(mock); await mock.start(); let calls = 0;
    mock.onRequest("initialize", ({ id }) => { calls++; if (calls === 1) { if (failure === "error") mock.error(id, -32603, "failed"); return; } mock.result(id, { capabilities: {} }); });
    const session = new LspSession({ host: "127.0.0.1", port: mock.port, projectRootUri: "file:///project", connectTimeoutMs: 10, schedule }); sessions.push(session);
    await expect(session.ensureReady()).rejects.toBeDefined();
    await expect.poll(() => session.state).toBe("ready"); expect(calls).toBe(2);
  });

  it("initializes once and captures honest capabilities", async () => {
    const { mock, session } = await setup(); initializeGodot(mock);
    const [a, b] = await Promise.all([session.ensureReady(), session.ensureReady()]);
    expect(a.generation).toBe(b.generation);
    await expect.poll(() => mock.messages.length).toBe(2);
    expect(mock.messages.map((message) => message.method)).toEqual(["initialize", "initialized"]);
    expect(mock.messages[0].params).toMatchObject({ processId: process.pid, rootUri: "file:///project", workspaceFolders: [{ uri: "file:///project", name: "project" }] });
    expect(session.supports("completion")).toBe(true);
    expect(session.supports("hover")).toBe(true);
    expect(session.supports("signatureHelp")).toBe(false);
    expect(session.supports("documentSymbols")).toBe(true);
    expect(session.supports("workspaceSymbols")).toBe(false);
    expect(session.supports("nativeSymbol")).toBe(true);
  });

  it("prevents application requests before initialization completes", async () => {
    const { mock, session } = await setup(); initializeGodot(mock);
    const result = session.request<string>("textDocument/hover", {});
    await expect.poll(() => mock.messages.map((message) => message.method)).toEqual(["initialize", "initialized", "textDocument/hover"]);
    mock.result(mock.messages[2].id, "hover");
    await expect(result).resolves.toBe("hover");
  });

  it("rejects disconnected generation work and replays before becoming ready", async () => {
    const delays: number[] = [];
    const schedule = (delay: number, work: () => void) => { delays.push(delay); queueMicrotask(work); return () => undefined; };
    const { mock, session } = await setup(schedule); initializeGodot(mock);
    const replayStates: string[] = [];
    session.setReplayHook(async (generation) => { expect(generation).toBe(2); replayStates.push(session.state); });
    await session.ensureReady();
    const pending = session.request("held", {}, 1_000);
    await expect.poll(() => mock.messages.some((message) => message.method === "held")).toBe(true);
    mock.sendMalformed();
    await expect(pending).rejects.toMatchObject({ code: "godot_error" });
    await expect.poll(() => session.state).toBe("ready");
    expect(delays).toEqual([1_000]);
    expect(replayStates).toEqual(["initializing"]);
    expect(session.ready?.generation).toBe(2);
  });

  it("uses bounded exponential reconnect delays", async () => {
    const delays: number[] = [];
    const mock = new MockLspServer(); mocks.push(mock); await mock.start(); initializeGodot(mock);
    let first = true;
    const socketFactory = async () => {
      if (!first) throw new Error("offline"); first = false;
      const socket = connect(mock.port, "127.0.0.1"); await new Promise<void>((resolve) => socket.once("connect", resolve)); return socket;
    };
    const schedule = (delay: number, work: () => void) => { delays.push(delay); if (delays.length < 8) queueMicrotask(work); return () => undefined; };
    const session = new LspSession({ host: "127.0.0.1", port: mock.port, projectRootUri: "file:///project", socketFactory, schedule }); sessions.push(session);
    await session.ensureReady(); mock.sendMalformed();
    await expect.poll(() => delays.length).toBe(8);
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  });

  it("isolates stale-generation notifications", async () => {
    const { mock, session } = await setup(); initializeGodot(mock); await session.ensureReady();
    const listener = vi.fn(); session.onNotification(listener);
    mock.notify("fresh"); await expect.poll(() => listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ generation: 1, method: "fresh" }));
  });

  it("sends shutdown then exit and coalesces close", async () => {
    const { mock, session } = await setup(); initializeGodot(mock); await session.ensureReady();
    mock.onRequest("shutdown", ({ id }) => mock.result(id, null));
    const a = session.close(); const b = session.close(); await Promise.all([a, b]);
    await expect.poll(() => mock.messages.length).toBe(4);
    expect(mock.messages.map((message) => message.method)).toEqual(["initialize", "initialized", "shutdown", "exit"]);
    expect(session.state).toBe("exited");
  });

  it("sends exit when shutdown fails", async () => {
    const { mock, session } = await setup(); initializeGodot(mock); await session.ensureReady();
    mock.onRequest("shutdown", ({ id }) => mock.error(id, -32603, "shutdown failed"));
    await session.close();
    await expect.poll(() => mock.messages.map((message) => message.method)).toContain("exit");
    expect(session.state).toBe("exited");
  });
});
