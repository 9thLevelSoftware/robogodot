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
});
