import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { RuntimeSessionCoordinator } from "../src/runtime/session.js";

const processView = (running = true) => ({ childId: "child", pid: 42, startedAt: 100, running, exit: undefined, output: vi.fn().mockReturnValue({ records: [], next: 0, lost: 0, truncated: false }) });
const options = { godotPath: "godot", projectPath: "game" };

describe("RuntimeSessionCoordinator", () => {
  it.each(["prepare", "start", "connect"] as const)("enforces the shared debug deadline during %s and cleans a late resolution", async (stage) => {
    vi.useFakeTimers();
    let release!: (value: any) => void;
    const delayed = new Promise<any>(resolve => { release = resolve; });
    const latePreparedClose = vi.fn(); const lateBridgeClose = vi.fn();
    const managed = processView();
    const runner = {
      start: vi.fn().mockImplementation(() => stage === "start" ? delayed : Promise.resolve(managed)),
      stop: vi.fn().mockResolvedValue({ childId: "child", graceful: true, forced: false }),
      stopCurrent: vi.fn().mockResolvedValue(undefined),
    };
    const prepared = {
      process: options,
      connect: vi.fn().mockImplementation(() => stage === "connect" ? delayed : Promise.resolve({ attachment: { close: lateBridgeClose }, root: "root", transport: "socket" })),
      close: latePreparedClose,
    };
    const coordinator = new RuntimeSessionCoordinator({ runner: runner as any });
    const launch = coordinator.integratedLaunch("debug", () => stage === "prepare" ? delayed : Promise.resolve(prepared), { host: "127.0.0.1", port: 6006, timeoutMs: 100 });
    const failure = expect(launch).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(100); await failure;
    if (stage === "prepare") release(prepared);
    else if (stage === "start") release(managed);
    else release({ attachment: { close: lateBridgeClose }, root: "root", transport: "socket" });
    await vi.runAllTimersAsync(); await Promise.resolve();
    if (stage === "prepare") expect(latePreparedClose).toHaveBeenCalledOnce();
    if (stage === "start") expect(runner.stop).toHaveBeenCalledWith("child");
    if (stage === "connect") expect(lateBridgeClose).toHaveBeenCalledOnce();
    expect(coordinator.state).toBe("idle");
    vi.useRealTimers();
  });

  it("retains a late prepared artifact whose cleanup fails and retries it before another launch", async () => {
    vi.useFakeTimers(); try {
      let release!: (value: any) => void; const delayed = new Promise<any>(resolve => { release = resolve; });
      const close = vi.fn().mockRejectedValueOnce(new Error("late artifacts busy")).mockResolvedValueOnce(undefined);
      const runner = { start: vi.fn(), stop: vi.fn(), stopCurrent: vi.fn() };
      const coordinator = new RuntimeSessionCoordinator({ runner: runner as any, sessionId: () => "c".repeat(32) });
      const launch = coordinator.integratedLaunch("debug", () => delayed, { host: "127.0.0.1", port: 6006, timeoutMs: 100 });
      const failure = expect(launch).rejects.toMatchObject({ code: "timeout" }); await vi.advanceTimersByTimeAsync(100); await failure;
      await expect(coordinator.launch("normal", options)).rejects.toMatchObject({ code: "godot_error" });
      release({ process: options, connect: vi.fn(), close }); await Promise.resolve(); await Promise.resolve();
      expect(coordinator.state).toBe("failed"); await expect(coordinator.stop("c".repeat(32))).resolves.toMatchObject({ sessionId: "c".repeat(32) }); expect(close).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("enforces the shared deadline during a DAP attach and closes its late resolution", async () => {
    vi.useFakeTimers(); let release!: () => void;
    const attaching = new Promise<void>(resolve => { release = resolve; });
    const dap = { status: { state: "disconnected" }, attach: vi.fn().mockReturnValue(attaching), setBreakpoints: vi.fn(), continue: vi.fn(), step: vi.fn(), stack: vi.fn(), inspect: vi.fn(), close: vi.fn() };
    const runner = { start: vi.fn().mockResolvedValue(processView()), stop: vi.fn().mockResolvedValue({ childId: "child", graceful: true, forced: false }), stopCurrent: vi.fn() };
    const prepared = { process: options, connect: vi.fn().mockResolvedValue({ attachment: { close: vi.fn() }, root: "root", transport: "socket" }), close: vi.fn() };
    const coordinator = new RuntimeSessionCoordinator({ runner: runner as any, dapFactory: () => dap as any } as any);
    const launch = coordinator.integratedLaunch("debug", async () => prepared as any, { host: "127.0.0.1", port: 6006, timeoutMs: 100 });
    const failure = expect(launch).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(100); await failure; release(); await Promise.resolve();
    expect(dap.close).toHaveBeenCalled(); expect(runner.stop).toHaveBeenCalledWith("child"); expect(coordinator.state).toBe("idle");
    vi.useRealTimers();
  });

  it("retains a bridge that connects after natural exit for explicit retryable cleanup", async () => {
    vi.useFakeTimers();
    try {
      let release!: (value: any) => void; const connecting = new Promise<any>(resolve => { release = resolve; });
      const managed = processView(); const bridgeClose = vi.fn();
      const runner = { start: vi.fn().mockResolvedValue(managed), stop: vi.fn().mockResolvedValue({ childId: "child", alreadyStopped: true, graceful: false, forced: false }), stopCurrent: vi.fn() };
      const prepared = { process: options, connect: vi.fn().mockReturnValue(connecting), close: vi.fn() };
      const coordinator = new RuntimeSessionCoordinator({ runner: runner as any, monitorMs: 10 }); let activeId = "";
      const launch = coordinator.integratedLaunch("normal", async (sessionId) => { activeId = sessionId; return prepared as any; });
      await vi.waitFor(() => expect(prepared.connect).toHaveBeenCalledOnce());
      Reflect.defineProperty(managed, "running", { value: false }); await vi.advanceTimersByTimeAsync(10);
      await vi.waitFor(() => expect(coordinator.state).toBe("failed"));
      release({ attachment: { close: bridgeClose }, root: "root", transport: "socket" });
      await expect(launch).rejects.toThrow(/ended|cancelled/i);
      expect(bridgeClose).not.toHaveBeenCalled(); await coordinator.stop(activeId); expect(bridgeClose).toHaveBeenCalledOnce(); expect(prepared.close).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("launches the coordinator-owned process before attach and returns only at debug_ready", async () => {
    const order: string[] = []; const dap = { status: { state: "disconnected" }, attach: vi.fn().mockImplementation(async (value) => { order.push("dap"); expect(value.process.pid).toBe(42); return { state: "ready" }; }), setBreakpoints: vi.fn(), continue: vi.fn(), step: vi.fn(), stack: vi.fn(), inspect: vi.fn(), close: vi.fn() };
    const runner = { start: vi.fn().mockImplementation(async () => { order.push("process"); return processView(); }), stop: vi.fn().mockResolvedValue({ childId: "child", graceful: true, forced: false }), stopCurrent: vi.fn() };
    const coordinator = new RuntimeSessionCoordinator({ runner: runner as any, dapFactory: () => dap as any, projectPath: "C:/project" } as any);
    const result = await coordinator.debugLaunch(options, { host: "127.0.0.1", port: 6006, timeoutMs: 1000 });
    expect(order).toEqual(["process", "dap"]); expect(result.state).toBe("debug_ready"); expect(dap.attach.mock.calls[0][0].timeoutMs).toBeLessThanOrEqual(1000);
    await coordinator.stop(result.id);
  });

  it("bounds the attach stage of the direct debug launch and closes a late adapter", async () => {
    vi.useFakeTimers(); let release!: () => void;
    const attaching = new Promise<void>(resolve => { release = resolve; });
    const dap = { status: { state: "disconnected" }, attach: vi.fn().mockReturnValue(attaching), setBreakpoints: vi.fn(), continue: vi.fn(), step: vi.fn(), stack: vi.fn(), inspect: vi.fn(), close: vi.fn() };
    const runner = { start: vi.fn().mockResolvedValue(processView()), stop: vi.fn().mockResolvedValue({ childId: "child", graceful: true, forced: false }), stopCurrent: vi.fn() };
    const coordinator = new RuntimeSessionCoordinator({ runner: runner as any, dapFactory: () => dap as any } as any);
    const launch = coordinator.debugLaunch(options, { host: "127.0.0.1", port: 6006, timeoutMs: 100 });
    const failure = expect(launch).rejects.toMatchObject({ code: "timeout" }); await vi.advanceTimersByTimeAsync(100); await failure;
    release(); await Promise.resolve(); expect(dap.close).toHaveBeenCalled(); expect(runner.stop).toHaveBeenCalledWith("child");
    vi.useRealTimers();
  });

  it("contains breakpoint files and delegates stopped operations to the active DAP client", async () => {
    const dap = { status: { state: "stopped", stoppedGeneration: 1 }, attach: vi.fn().mockResolvedValue({ state: "ready" }), setBreakpoints: vi.fn().mockResolvedValue({ breakpoints: [{ line: 2, verified: true }] }), continue: vi.fn().mockResolvedValue({}), step: vi.fn().mockResolvedValue({}), stack: vi.fn().mockResolvedValue({ threads: [], frames: [], truncated: false }), inspect: vi.fn().mockResolvedValue({ scopes: [], truncated: false }), close: vi.fn() };
    const runner = { start: vi.fn().mockResolvedValue(processView()), stop: vi.fn().mockResolvedValue({ childId: "child", graceful: true, forced: false }), stopCurrent: vi.fn() };
    const coordinator = new RuntimeSessionCoordinator({ runner: runner as any, dapFactory: () => dap as any, projectPath: process.cwd() } as any);
    const result = await coordinator.debugLaunch(options, { host: "127.0.0.1", port: 6006, timeoutMs: 1000 });
    await expect(coordinator.debugSetBreakpoints(result.id, "../escape.gd", [2])).rejects.toMatchObject({ code: "invalid_args" });
    await coordinator.debugContinue(result.id, { runtimeSessionId: result.id, stoppedGeneration: 1, id: 1 });
    expect(dap.continue).toHaveBeenCalledOnce(); await coordinator.stop(result.id);
  });

  it("normalizes breakpoint responses to bounded reviewed own-data fields", async () => {
    const hostile: any = { verified: true, line: 2, message: "ok", source: { name: "main.gd", path: "C:/secret/main.gd" }, extra: "drop" };
    Object.defineProperty(hostile, "accessor", { enumerable: true, get() { throw new Error("must not read"); } });
    const dap = { status: { state: "stopped", stoppedGeneration: 1 }, attach: vi.fn().mockResolvedValue({}), setBreakpoints: vi.fn().mockResolvedValue({ breakpoints: [hostile] }), continue: vi.fn(), step: vi.fn(), stack: vi.fn(), inspect: vi.fn(), close: vi.fn() };
    const runner = { start: vi.fn().mockResolvedValue(processView()), stop: vi.fn().mockResolvedValue({ childId: "child", graceful: true, forced: false }), stopCurrent: vi.fn() };
    const coordinator = new RuntimeSessionCoordinator({ runner: runner as any, dapFactory: () => dap as any, projectPath: resolve(process.cwd(), "..", "tests", "fixtures", "godot_project") } as any);
    const result = await coordinator.debugLaunch(options, { host: "127.0.0.1", port: 6006, timeoutMs: 1000 });
    const output: any = await coordinator.debugSetBreakpoints(result.id, "phase5/runtime_fixture.gd", [2]);
    expect(output.breakpoints).toEqual([{ verified: true, line: 2, message: "ok" }]);
    expect(output.breakpoints[0]).not.toHaveProperty("source"); expect(output.breakpoints[0]).not.toHaveProperty("extra");
    dap.setBreakpoints.mockResolvedValueOnce({ breakpoints: Array.from({ length: 501 }, () => ({ verified: true })) });
    await expect(coordinator.debugSetBreakpoints(result.id, "phase5/runtime_fixture.gd", [2])).rejects.toMatchObject({ code: "godot_error" });
    await coordinator.stop(result.id);
  });
  it("owns one opaque immutable session and rejects concurrent and stale calls", async () => {
    let resolve!: (value: any) => void; const pending = new Promise<any>((yes) => { resolve = yes; });
    const runner = { start: vi.fn().mockReturnValue(pending), stop: vi.fn(), stopCurrent: vi.fn() };
    const coordinator = new RuntimeSessionCoordinator({ runner: runner as any });
    const launch = coordinator.launch("normal", options);
    expect(coordinator.state).toBe("starting");
    await expect(coordinator.launch("normal", options)).rejects.toMatchObject({ code: "godot_error" });
    resolve(processView()); const session = await launch;
    expect(session).toMatchObject({ id: expect.stringMatching(/^[a-f0-9]{32}$/), mode: "normal", state: "running", pid: 42 });
    expect(Object.isFrozen(session)).toBe(true); expect(session).not.toHaveProperty("secret");
    expect(runner.start.mock.calls[0]![0].env.GODOT_RUNTIME_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    await expect(coordinator.output("0".repeat(32), 0, 100)).rejects.toMatchObject({ code: "invalid_args" });
  });

  it("attaches debug seams and stops them in attempt-all order while preserving first error", async () => {
    const order: string[] = []; const managed = processView();
    const runner = { start: vi.fn().mockResolvedValue(managed), stop: vi.fn().mockImplementation(async () => { order.push("process"); return { graceful: true, forced: false }; }), stopCurrent: vi.fn() };
    const coordinator = new RuntimeSessionCoordinator({ runner: runner as any }); const session = await coordinator.launch("debug", options);
    const bridge = { close: vi.fn().mockImplementation(async () => { order.push("bridge"); throw new Error("bridge failed"); }) };
    const dap = { close: vi.fn().mockImplementation(async () => { order.push("dap"); throw new Error("dap failed"); }) };
    expect(coordinator.attachBridge(session.id, bridge)).toMatchObject({ state: "running" });
    expect(coordinator.attachDap(session.id, dap)).toMatchObject({ state: "debug_ready" });
    await expect(coordinator.stop(session.id)).rejects.toThrow("dap failed");
    expect(order).toEqual(["dap", "bridge", "process"]); expect(coordinator.state).toBe("failed");
  });

  it("locks the first bridge and screenshot containment authority for the active session", async () => {
    const order: string[] = []; const runner = { start: vi.fn().mockResolvedValue(processView()), stop: vi.fn().mockImplementation(async () => { order.push("process"); return { childId: "child", alreadyStopped: false, graceful: true, forced: false }; }), stopCurrent: vi.fn() };
    const coordinator = new RuntimeSessionCoordinator({ runner: runner as any }); const session = await coordinator.launch("normal", options);
    const original = { request: vi.fn().mockResolvedValue({ nodes: [], truncated: false }), close: vi.fn().mockImplementation(() => { order.push("original"); }) };
    const replacement = { request: vi.fn().mockResolvedValue({ nodes: [], truncated: false }), close: vi.fn().mockImplementation(() => { order.push("replacement"); }) };
    coordinator.attachBridge(session.id, original, "C:/original-authority");
    expect(() => coordinator.attachBridge(session.id, replacement, "C:/replacement-authority")).toThrowError(expect.objectContaining({ code: "godot_error" }));
    await coordinator.sceneTree(session.id, 8); expect(original.request).toHaveBeenCalledOnce(); expect(replacement.request).not.toHaveBeenCalled();
    await coordinator.stop(session.id); expect(order).toEqual(["original", "process"]); expect(replacement.close).not.toHaveBeenCalled();
  });

  it("cleans a failed start through stopCurrent and close handles a launch in progress", async () => {
    let reject!: (error: Error) => void; const starting = new Promise<any>((_, no) => { reject = no; });
    const runner = { start: vi.fn().mockReturnValue(starting), stop: vi.fn(), stopCurrent: vi.fn().mockResolvedValue(undefined) };
    const coordinator = new RuntimeSessionCoordinator({ runner: runner as any }); const launched = coordinator.launch("normal", options);
    const closing = coordinator.close(); reject(new Error("spawn failed"));
    await expect(launched).rejects.toThrow("spawn failed"); await closing;
    expect(runner.stopCurrent).toHaveBeenCalled(); expect(coordinator.state).toBe("idle");
  });

  it("retains final output and exit metadata after natural exit until explicit stop", async () => {
    const managed = processView(); managed.output.mockImplementation((since: number) => since === 0 ? { records: [{ cursor: 0, stream: "stdout", at: 100, text: "final partial", truncated: false }], next: 1, lost: 0, truncated: false } : { records: [], next: 1, lost: 0, truncated: false }); const runner = { start: vi.fn().mockResolvedValue(managed), stop: vi.fn().mockResolvedValue({ childId: "child", alreadyStopped: true, graceful: false, forced: false, exit: { code: 7, signal: null, at: 101 } }), stopCurrent: vi.fn() };
    const coordinator = new RuntimeSessionCoordinator({ runner: runner as any }); const session = await coordinator.launch("normal", options);
    Reflect.defineProperty(managed, "running", { value: false }); Reflect.defineProperty(managed, "exit", { value: { code: 7, signal: null, at: 101 } });
    await expect(coordinator.output(session.id, 0, 100)).resolves.toMatchObject({ running: false, exit: { code: 7 }, records: [{ cursor: 0, text: "final partial" }], next: 1 });
    await expect(coordinator.output(session.id, 1, 100)).resolves.toMatchObject({ running: false, records: [], next: 1 });
    await expect(coordinator.sceneTree(session.id, 8)).rejects.toMatchObject({ code: "invalid_args" });
    await coordinator.stop(session.id); await expect(coordinator.output(session.id, 0, 100)).rejects.toMatchObject({ code: "invalid_args" });
  });

  it("retains one idempotent terminal stop result and rejects unrelated stale IDs", async () => {
    const runner = { start: vi.fn().mockResolvedValue(processView()), stop: vi.fn().mockResolvedValue({ childId: "child", alreadyStopped: false, graceful: true, forced: false }), stopCurrent: vi.fn() };
    const coordinator = new RuntimeSessionCoordinator({ runner: runner as any }); const first = await coordinator.launch("normal", options);
    const stopped = await coordinator.stop(first.id); expect(await coordinator.stop(first.id)).toEqual(stopped); expect(runner.stop).toHaveBeenCalledOnce();
    await expect(coordinator.stop("f".repeat(32))).rejects.toMatchObject({ code: "invalid_args" });
    const second = await coordinator.launch("normal", options); await expect(coordinator.stop(first.id)).rejects.toMatchObject({ code: "invalid_args" }); await coordinator.stop(second.id);
  });

  it("retains natural exit until explicit stop then tears down once", async () => {
    vi.useFakeTimers(); const order: string[] = []; const managed = processView();
    const runner = { start: vi.fn().mockResolvedValue(managed), stop: vi.fn().mockImplementation(async () => { order.push("process"); return { childId: "child", alreadyStopped: true, graceful: false, forced: false, exit: { code: 7, signal: null, at: 101 } }; }), stopCurrent: vi.fn() };
    const coordinator = new RuntimeSessionCoordinator({ runner: runner as any, monitorMs: 10 }); const session = await coordinator.launch("debug", options);
    coordinator.attachBridge(session.id, { close: async () => { order.push("bridge"); } }); coordinator.attachDap(session.id, { close: async () => { order.push("dap"); } });
    Reflect.defineProperty(managed, "running", { value: false }); Reflect.defineProperty(managed, "exit", { value: { code: 7, signal: null, at: 101 } });
    await vi.advanceTimersByTimeAsync(10); const raced = coordinator.stop(session.id); await expect(raced).resolves.toMatchObject({ sessionId: session.id, exit: { code: 7 } });
    expect(order).toEqual(["dap", "bridge", "process"]); expect(await coordinator.stop(session.id)).toEqual(await raced); vi.useRealTimers();
  });

  it("cleans attached starting seams in order, aggregates cleanup errors, and retains unconfirmed ownership", async () => {
    let reject!: (error: Error) => void; const pending = new Promise<any>((_, no) => { reject = no; }); const order: string[] = [];
    const runner = { start: vi.fn().mockReturnValue(pending), stop: vi.fn(), stopCurrent: vi.fn().mockImplementation(async () => { order.push("process"); throw new Error("owned"); }) };
    const coordinator = new RuntimeSessionCoordinator({ runner: runner as any, sessionId: () => "a".repeat(32) }); const launched = coordinator.launch("debug", options);
    coordinator.attachBridge("a".repeat(32), { close: async () => { order.push("bridge"); throw new Error("bridge"); } }); coordinator.attachDap("a".repeat(32), { close: async () => { order.push("dap"); throw new Error("dap"); } });
    reject(new Error("launch")); const error = await launched.catch(value => value); expect(error).toBeInstanceOf(AggregateError); expect(error.errors[0].message).toBe("launch"); expect(order).toEqual(["dap", "bridge", "process"]);
    expect(coordinator.state).toBe("failed"); await expect(coordinator.launch("normal", options)).rejects.toMatchObject({ code: "godot_error" });
  });

  it("retains every unconfirmed normal stop in failed state and retries the same exact child", async () => {
    const managed = processView(); const runner = { start: vi.fn().mockResolvedValue(managed), stop: vi.fn().mockRejectedValueOnce(new Error("denied")).mockResolvedValueOnce({ childId: "child", alreadyStopped: false, graceful: false, forced: true }), stopCurrent: vi.fn() };
    const coordinator = new RuntimeSessionCoordinator({ runner: runner as any }); const session = await coordinator.launch("normal", options);
    await expect(coordinator.stop(session.id)).rejects.toThrow("denied"); expect(coordinator.state).toBe("failed");
    await expect(coordinator.launch("normal", options)).rejects.toMatchObject({ code: "godot_error" });
    await expect(coordinator.stop(session.id)).resolves.toMatchObject({ sessionId: session.id, forced: true }); expect(runner.stop).toHaveBeenCalledTimes(2); expect(runner.stop.mock.calls.every(call => call[0] === "child")).toBe(true);
  });

  it("retains bridge and bootstrap ownership independently and retries exact failed cleanup", async () => {
    const bridgeClose = vi.fn().mockRejectedValueOnce(new Error("bridge busy")).mockResolvedValueOnce(undefined);
    const artifactClose = vi.fn().mockRejectedValueOnce(new Error("artifacts busy")).mockResolvedValueOnce(undefined);
    const runner = { start: vi.fn().mockResolvedValue(processView()), stop: vi.fn().mockResolvedValue({ childId: "child", alreadyStopped: false, graceful: true, forced: false }), stopCurrent: vi.fn() };
    const prepared = { process: options, connect: vi.fn().mockResolvedValue({ attachment: { request: vi.fn(), close: bridgeClose }, root: "root", transport: "file" }), close: artifactClose };
    const coordinator = new RuntimeSessionCoordinator({ runner: runner as any }); let id = "";
    await coordinator.integratedLaunch("normal", async sessionId => { id = sessionId; return prepared as any; });
    await expect(coordinator.stop(id)).rejects.toThrow("bridge busy"); expect(coordinator.state).toBe("failed");
    await expect(coordinator.launch("normal", options)).rejects.toMatchObject({ code: "godot_error" });
    await expect(coordinator.stop(id)).resolves.toMatchObject({ sessionId: id });
    expect(bridgeClose).toHaveBeenCalledTimes(2); expect(artifactClose).toHaveBeenCalledTimes(2); expect(runner.stop).toHaveBeenCalledTimes(2);
  });

  it("retains unconfirmed ownership through close and permits later exact-session retry", async () => {
    const runner = { start: vi.fn().mockResolvedValue(processView()), stop: vi.fn().mockRejectedValueOnce(new Error("close denied")).mockResolvedValueOnce({ childId: "child", alreadyStopped: false, graceful: true, forced: false }), stopCurrent: vi.fn() };
    const coordinator = new RuntimeSessionCoordinator({ runner: runner as any }); const session = await coordinator.launch("normal", options);
    await expect(coordinator.close()).rejects.toThrow("close denied"); expect(coordinator.state).toBe("failed"); await expect(coordinator.stop(session.id)).resolves.toMatchObject({ graceful: true });
  });
});
