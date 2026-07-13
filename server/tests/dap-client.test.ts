import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { DapClient } from "../src/runtime/dap-client.js";
import { MockDapServer } from "./mock-dap.js";

const mocks: MockDapServer[] = [];
const SESSION = "a".repeat(32);
const PROJECT = resolve("../tests/fixtures/godot_project");
async function server() { const mock = new MockDapServer(); mocks.push(mock); await mock.start(); return mock; }
async function respondHandshake(mock: MockDapServer, capabilities: Record<string, unknown> = { supportsConfigurationDoneRequest: true, supportsTerminateRequest: true, supportsVariablePaging: true }) {
  await expect.poll(() => mock.messages.length).toBe(1); expect(mock.messages[0].command).toBe("initialize"); mock.respond(mock.messages[0], capabilities);
  await expect.poll(() => mock.messages.length).toBe(2); expect(mock.messages[1].command).toBe("attach"); mock.respond(mock.messages[1]); mock.event("initialized");
}
afterEach(async () => { vi.useRealTimers(); await Promise.all(mocks.splice(0).map((m) => m.stop())); });

describe("DapClient", () => {
  it("attaches without spawning and configures initialize -> attach -> initialized -> breakpoints -> configurationDone", async () => {
    const mock = await server(); const client = new DapClient(); const attaching = client.attach({ host: "127.0.0.1", port: mock.port, runtimeSessionId: SESSION, process: { pid: 44, startedAt: 1 }, bridge: { transport: "socket" }, initialBreakpoints: [{ source: { path: "C:/game/main.gd" }, breakpoints: [{ line: 8 }] }] });
    await respondHandshake(mock); await expect.poll(() => mock.messages.length).toBe(3); expect(mock.messages[2].command).toBe("setBreakpoints"); mock.respond(mock.messages[2], { breakpoints: [{ verified: true, line: 8 }] });
    await expect.poll(() => mock.messages.length).toBe(4); expect(mock.messages[3].command).toBe("configurationDone"); mock.respond(mock.messages[3]);
    await expect(attaching).resolves.toMatchObject({ runtimeSessionId: SESSION, process: { pid: 44 }, bridge: { transport: "socket" }, state: "ready" }); expect(mock.spawnCalls).toHaveLength(0); expect(mock.messages.map((m) => m.command)).toEqual(["initialize", "attach", "setBreakpoints", "configurationDone"]);
  });
  it("times out attach and reports process-plus-bridge degradation without owning the process", async () => { const mock = await server(); const client = new DapClient(); await expect(client.attach({ host: "127.0.0.1", port: mock.port, runtimeSessionId: SESSION, process: { pid: 5 }, bridge: { transport: "file" }, timeoutMs: 15 })).rejects.toMatchObject({ code: "timeout" }); expect(client.status).toMatchObject({ state: "degraded", degradation: { mode: "process_plus_bridge", dapAvailable: false }, process: { pid: 5 }, bridge: { transport: "file" } }); });
  it("gates advertised capabilities", async () => { const mock = await server(); const client = new DapClient(); const attaching = client.attach({ host: "127.0.0.1", port: mock.port, runtimeSessionId: SESSION, process: { pid: 2 } }); await respondHandshake(mock, {}); await expect(attaching).rejects.toMatchObject({ code: "feature_disabled" }); await expect(client.terminate()).rejects.toMatchObject({ code: "not_connected" }); });
  it("binds threads, frames, scopes, and variables to the stopped generation with bounded pagination", async () => {
    const mock = await server(); const client = new DapClient({ projectRoot: PROJECT }); const attaching = client.attach({ host: "127.0.0.1", port: mock.port, runtimeSessionId: SESSION, process: { pid: 2 } }); await respondHandshake(mock); await expect.poll(() => mock.messages.length).toBe(3); mock.respond(mock.messages[2]); await attaching;
    mock.event("stopped", { reason: "breakpoint", threadId: 3 }); await expect.poll(() => client.status.state).toBe("stopped");
    const stacked = client.stack(); await expect.poll(() => mock.messages.at(-1)?.command).toBe("threads"); mock.respond(mock.messages.at(-1), { threads: Array.from({ length: 70 }, (_, i) => ({ id: i + 1, name: `thread ${i}` })) }); await expect.poll(() => mock.messages.at(-1)?.command).toBe("stackTrace"); expect(mock.messages.at(-1).arguments.levels).toBe(256); mock.respond(mock.messages.at(-1), { stackFrames: [{ id: 9, name: "main", line: 4, column: 1, source: { path: resolve(PROJECT, "phase5/runtime_fixture.gd") } }, { id: 10, name: "external", line: 1, column: 1, source: { name: "external.gd", path: resolve(PROJECT, "../outside-secret.gd") } }], totalFrames: 2 });
    const stack = await stacked; expect(stack.threads).toHaveLength(64); expect(stack.threads[0].ref).toEqual({ runtimeSessionId: SESSION, stoppedGeneration: 1, id: 1 }); expect(stack.frames[0].ref).toEqual({ runtimeSessionId: SESSION, stoppedGeneration: 1, id: 9 }); expect(stack.frames[0].source).toEqual({ path: "res://phase5/runtime_fixture.gd" }); expect(stack.frames[1].source).toEqual({ name: "external.gd" }); expect(JSON.stringify(stack)).not.toContain(PROJECT);
    const scopes = client.inspect(stack.frames[0].ref); await expect.poll(() => mock.messages.at(-1)?.command).toBe("scopes"); mock.respond(mock.messages.at(-1), { scopes: [{ name: "Locals", variablesReference: 12 }] }); const scopeResult = await scopes; expect(scopeResult.scopes[0].ref).toEqual({ runtimeSessionId: SESSION, stoppedGeneration: 1, id: 12 });
    const vars = client.inspect(stack.frames[0].ref, scopeResult.scopes[0].ref, 500); await expect.poll(() => mock.messages.at(-1)?.command).toBe("variables"); expect(mock.messages.at(-1).arguments).toMatchObject({ start: 500, count: 500 }); mock.respond(mock.messages.at(-1), { variables: [{ name: "x", value: "1", type: "int", variablesReference: 0 }] }); const variableResult = await vars; expect(variableResult).not.toHaveProperty("next"); expect(mock.messages.some((m) => m.command === "evaluate")).toBe(false);
  });
  it.each([["continue", "continue"], ["over", "next"], ["into", "stepIn"]])("invalidates stopped references before %s completes", async (kind, command) => {
    const mock = await server(); const client = new DapClient(); const attaching = client.attach({ host: "127.0.0.1", port: mock.port, runtimeSessionId: SESSION, process: { pid: 2 } }); await respondHandshake(mock); await expect.poll(() => mock.messages.length).toBe(3); mock.respond(mock.messages[2]); await attaching; mock.event("stopped", { threadId: 1 }); await expect.poll(() => client.status.state).toBe("stopped");
    const old = { runtimeSessionId: SESSION, stoppedGeneration: 1, id: 4 }; const request = kind === "continue" ? client.continue(1) : client.step(kind as "over" | "into", 1); await expect.poll(() => mock.messages.at(-1)?.command).toBe(command); await expect(client.inspect(old)).rejects.toMatchObject({ code: "invalid_args" }); mock.respond(mock.messages.at(-1)); await request;
  });
  it("handles process exit, disconnect, cancellation/close, and listener isolation", async () => {
    const mock = await server(); const client = new DapClient(); const events: string[] = []; client.onEvent(() => { throw new Error("listener"); }); client.onEvent((e) => events.push(e.event)); const attaching = client.attach({ host: "127.0.0.1", port: mock.port, runtimeSessionId: SESSION, process: { pid: 2 }, bridge: { transport: "socket" } }); await respondHandshake(mock); await expect.poll(() => mock.messages.length).toBe(3); mock.respond(mock.messages[2]); await attaching; mock.event("exited", { exitCode: 0 }); await expect.poll(() => events).toContain("exited"); expect(client.status.state).toBe("exited"); await client.close(); await expect(client.stack()).rejects.toMatchObject({ code: "not_connected" });
  });
  it("cancels an in-progress attach without degrading or leaving a socket attached", async () => {
    let resolveSocket!: (socket: any) => void; const socketPromise = new Promise<any>((resolve) => { resolveSocket = resolve; }); const socket = { destroyed: false, destroy() { this.destroyed = true; } };
    const client = new DapClient({ socketFactory: () => socketPromise }); const attaching = client.attach({ host: "127.0.0.1", port: 6006, runtimeSessionId: SESSION, process: { pid: 7 }, bridge: { transport: "socket" } }); await client.close(); resolveSocket(socket);
    await expect(attaching).rejects.toMatchObject({ code: "not_connected" }); expect(socket.destroyed).toBe(true); expect(client.status).toMatchObject({ state: "disconnected" }); expect(client.status).not.toHaveProperty("degradation");
  });
  it("uses the DAP disconnect handshake when the coordinator closes a live client", async () => {
    const mock = await server(); const client = new DapClient(); const attaching = client.attach({ host: "127.0.0.1", port: mock.port, runtimeSessionId: SESSION, process: { pid: 2 } }); await respondHandshake(mock); await expect.poll(() => mock.messages.length).toBe(3); mock.respond(mock.messages[2]); await attaching;
    const closing = client.close(); await expect.poll(() => mock.messages.at(-1)?.command).toBe("disconnect"); expect(mock.messages.at(-1).arguments).toEqual({ restart: false, terminateDebuggee: false }); mock.respond(mock.messages.at(-1)); await expect(closing).resolves.toBeUndefined(); expect(client.status.state).toBe("disconnected");
  });
  it("immediately cancels a never-resolving socket acquisition", async () => {
    const client = new DapClient({ socketFactory: () => new Promise(() => undefined) }); const attaching = client.attach({ host: "127.0.0.1", port: 6006, runtimeSessionId: SESSION, process: { pid: 9 }, timeoutMs: 10_000 }); await client.close();
    await expect(attaching).rejects.toMatchObject({ code: "not_connected" }); expect(client.status.state).toBe("disconnected");
  });
  it("destroys a socket that resolves after attach timeout", async () => {
    let resolveSocket!: (socket: any) => void; const acquired = new Promise<any>((resolve) => { resolveSocket = resolve; }); const socket = { destroyed: false, destroy() { this.destroyed = true; } }; const client = new DapClient({ socketFactory: () => acquired });
    const attaching = client.attach({ host: "127.0.0.1", port: 6006, runtimeSessionId: SESSION, process: { pid: 10 }, timeoutMs: 10 }); await expect(attaching).rejects.toMatchObject({ code: "timeout" }); resolveSocket(socket); await expect.poll(() => socket.destroyed).toBe(true);
  });
  it("rejects public setBreakpoints while attach configuration owns ordering", async () => {
    const mock = await server(); const client = new DapClient(); const attaching = client.attach({ host: "127.0.0.1", port: mock.port, runtimeSessionId: SESSION, process: { pid: 2 } }); await expect.poll(() => mock.messages.length).toBe(1);
    const concurrent = client.setBreakpoints({ path: "C:/game/main.gd" }, [{ line: 3 }]); await expect(concurrent).rejects.toMatchObject({ code: "not_connected" }); expect(mock.messages.map((message) => message.command)).toEqual(["initialize"]); mock.respond(mock.messages[0], { supportsConfigurationDoneRequest: true }); await expect.poll(() => mock.messages.length).toBe(2); mock.respond(mock.messages[1]); mock.event("initialized"); await expect.poll(() => mock.messages.length).toBe(3); mock.respond(mock.messages[2]); await attaching;
  });
  it("cancels the initialized waiter immediately when initialize fails", async () => {
    const mock = await server(); const client = new DapClient(); const attaching = client.attach({ host: "127.0.0.1", port: mock.port, runtimeSessionId: SESSION, process: { pid: 2 }, timeoutMs: 10_000 }); await expect.poll(() => mock.messages.length).toBe(1); mock.error(mock.messages[0], "initialize failed");
    await expect(attaching).rejects.toMatchObject({ code: "godot_error" }); expect((client as any).listeners.size).toBe(0);
  });
  it.each(["threads", "stackTrace", "scopes", "variables"])("rejects stale %s responses after continue and a new stop", async (phase) => {
    const mock = await server(); const client = new DapClient(); const attaching = client.attach({ host: "127.0.0.1", port: mock.port, runtimeSessionId: SESSION, process: { pid: 2 } }); await respondHandshake(mock); await expect.poll(() => mock.messages.length).toBe(3); mock.respond(mock.messages[2]); await attaching; mock.event("stopped", { threadId: 1 }); await expect.poll(() => client.status.state).toBe("stopped");
    const frame = { runtimeSessionId: SESSION, stoppedGeneration: 1, id: 9 }; const variable = { runtimeSessionId: SESSION, stoppedGeneration: 1, id: 12 }; let reading: Promise<any>;
    if (phase === "threads" || phase === "stackTrace") { reading = client.stack(); await expect.poll(() => mock.messages.at(-1)?.command).toBe("threads"); if (phase === "stackTrace") { mock.respond(mock.messages.at(-1), { threads: [{ id: 1, name: "main" }] }); await expect.poll(() => mock.messages.at(-1)?.command).toBe("stackTrace"); } }
    else { reading = client.inspect(frame, phase === "variables" ? variable : undefined); await expect.poll(() => mock.messages.at(-1)?.command).toBe(phase); }
    const pendingRead = mock.messages.at(-1); const resume = client.continue(1); await expect.poll(() => mock.messages.at(-1)?.command).toBe("continue"); mock.respond(mock.messages.at(-1)); await resume; mock.event("stopped", { threadId: 2 }); await expect.poll(() => client.status.stoppedGeneration).toBe(2);
    if (phase === "threads") mock.respond(pendingRead, { threads: [{ id: 1, name: "stale" }] }); else if (phase === "stackTrace") mock.respond(pendingRead, { stackFrames: [{ id: 9, name: "stale", line: 1, column: 1 }] }); else if (phase === "scopes") mock.respond(pendingRead, { scopes: [{ name: "stale", variablesReference: 12 }] }); else mock.respond(pendingRead, { variables: [{ name: "stale", value: "1", variablesReference: 0 }] });
    await expect(reading).rejects.toMatchObject({ code: "invalid_args" });
  });
  it("resets capabilities before a replacement attach and applies only the new adapter capabilities", async () => {
    const first = await server(); const client = new DapClient(); const firstAttach = client.attach({ host: "127.0.0.1", port: first.port, runtimeSessionId: SESSION, process: { pid: 21 } }); await respondHandshake(first, { supportsConfigurationDoneRequest: true, supportsTerminateRequest: true }); await expect.poll(() => first.messages.length).toBe(3); first.respond(first.messages[2]); await firstAttach; first.event("stopped", { threadId: 1 }); await expect.poll(() => client.status.stoppedGeneration).toBe(1);
    const firstClose = client.close(); await expect.poll(() => first.messages.at(-1)?.command).toBe("disconnect"); first.respond(first.messages.at(-1)); await firstClose;
    const secondSession = "b".repeat(32); const second = await server(); const secondAttach = client.attach({ host: "127.0.0.1", port: second.port, runtimeSessionId: secondSession, process: { pid: 22 } }); void secondAttach.catch(() => undefined); await expect.poll(() => second.messages.length).toBe(1); expect(second.messages[0].command).toBe("initialize"); expect(client.status).toMatchObject({ state: "attaching", runtimeSessionId: secondSession, stoppedGeneration: 0 }); expect(client.status).not.toHaveProperty("capabilities"); expect(client.status).not.toHaveProperty("degradation");
    const duringAttach = client.terminate().then(() => ({ state: "resolved" as const }), (error) => ({ state: "rejected" as const, error })); await new Promise<void>((resolve) => setImmediate(resolve)); expect(second.messages.some((message) => message.command === "terminate")).toBe(false); await expect(duringAttach).resolves.toMatchObject({ state: "rejected", error: { code: "not_connected" } });
    second.respond(second.messages[0], { supportsConfigurationDoneRequest: true, supportsTerminateRequest: false }); await expect.poll(() => second.messages.length).toBe(2); second.respond(second.messages[1]); second.event("initialized"); await expect.poll(() => second.messages.length).toBe(3); second.respond(second.messages[2]); await secondAttach;
    await expect(client.terminate()).rejects.toMatchObject({ code: "feature_disabled" }); expect(second.messages.some((message) => message.command === "terminate")).toBe(false);
  });
});
