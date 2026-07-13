import { describe, expect, it, vi } from "vitest";
import { RuntimeSessionCoordinator } from "../src/runtime/session.js";

const processView = (running = true) => ({ childId: "child", pid: 42, startedAt: 100, running, exit: undefined, output: vi.fn().mockReturnValue({ records: [], next: 0, lost: 0, truncated: false }) });
const options = { godotPath: "godot", projectPath: "game" };

describe("RuntimeSessionCoordinator", () => {
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
    expect(order).toEqual(["dap", "bridge", "process"]); expect(coordinator.state).toBe("idle");
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

  it("denies output after natural exit", async () => {
    const managed = processView(); const runner = { start: vi.fn().mockResolvedValue(managed), stop: vi.fn(), stopCurrent: vi.fn() };
    const coordinator = new RuntimeSessionCoordinator({ runner: runner as any }); const session = await coordinator.launch("normal", options);
    Reflect.defineProperty(managed, "running", { value: false });
    await expect(coordinator.output(session.id, 0, 100)).rejects.toMatchObject({ code: "invalid_args" });
    expect(coordinator.state).toBe("idle");
  });

  it("retains one idempotent terminal stop result and rejects unrelated stale IDs", async () => {
    const runner = { start: vi.fn().mockResolvedValue(processView()), stop: vi.fn().mockResolvedValue({ childId: "child", alreadyStopped: false, graceful: true, forced: false }), stopCurrent: vi.fn() };
    const coordinator = new RuntimeSessionCoordinator({ runner: runner as any }); const first = await coordinator.launch("normal", options);
    const stopped = await coordinator.stop(first.id); expect(await coordinator.stop(first.id)).toEqual(stopped); expect(runner.stop).toHaveBeenCalledOnce();
    await expect(coordinator.stop("f".repeat(32))).rejects.toMatchObject({ code: "invalid_args" });
    const second = await coordinator.launch("normal", options); await expect(coordinator.stop(first.id)).rejects.toMatchObject({ code: "invalid_args" }); await coordinator.stop(second.id);
  });

  it("asynchronously tears down natural exit once and coalesces an explicit-stop race", async () => {
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

  it("retains unconfirmed ownership through close and permits later exact-session retry", async () => {
    const runner = { start: vi.fn().mockResolvedValue(processView()), stop: vi.fn().mockRejectedValueOnce(new Error("close denied")).mockResolvedValueOnce({ childId: "child", alreadyStopped: false, graceful: true, forced: false }), stopCurrent: vi.fn() };
    const coordinator = new RuntimeSessionCoordinator({ runner: runner as any }); const session = await coordinator.launch("normal", options);
    await expect(coordinator.close()).rejects.toThrow("close denied"); expect(coordinator.state).toBe("failed"); await expect(coordinator.stop(session.id)).resolves.toMatchObject({ graceful: true });
  });
});
