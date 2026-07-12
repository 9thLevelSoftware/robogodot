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
