import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ProcessRunner } from "../src/runtime/process.js";

function deferred<T = void>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function child(pid = 1234) {
  const value = new EventEmitter() as EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn>; exitCode: number | null; signalCode: NodeJS.Signals | null };
  value.pid = pid; value.stdout = new EventEmitter(); value.stderr = new EventEmitter(); value.kill = vi.fn().mockReturnValue(true); value.exitCode = null; value.signalCode = null;
  return value;
}
function fixture(overrides: Record<string, unknown> = {}) {
  const owned = child(); const spawn = vi.fn().mockReturnValue(owned); const terminateTree = vi.fn().mockResolvedValue(undefined);
  const runner = new ProcessRunner({ spawn, terminateTree, validate: vi.fn().mockResolvedValue(undefined), now: vi.fn().mockReturnValue(100), ...overrides } as any);
  return { runner, owned, spawn, terminateTree };
}
async function started(value = fixture()) { const pending = value.runner.start({ godotPath: "C:\\Godot\\godot.exe", projectPath: "C:\\game", scene: "res://phase5/main.tscn" }); await vi.waitFor(() => expect(value.spawn).toHaveBeenCalled()); value.owned.emit("spawn"); return { ...value, managed: await pending }; }

describe("ProcessRunner", () => {
  it("spawns shell-free with exact argv and hides credentials", async () => {
    const { managed, spawn } = await started();
    expect(spawn).toHaveBeenCalledWith("C:\\Godot\\godot.exe", ["--path", "C:\\game", "res://phase5/main.tscn"], {
      cwd: "C:\\game", env: expect.any(Object), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    expect(managed).toMatchObject({ pid: 1234, startedAt: 100, running: true });
    expect(managed).not.toHaveProperty("child"); expect(managed).not.toHaveProperty("token");
  });

  it("validates before spawning and rejects simultaneous starts", async () => {
    const validation = deferred(); const { runner, spawn } = fixture({ validate: vi.fn().mockReturnValue(validation.promise) });
    const first = runner.start({ godotPath: "godot", projectPath: "game" });
    await expect(runner.start({ godotPath: "godot", projectPath: "game" })).rejects.toThrow(/already/);
    validation.reject(new Error("bad scene")); await expect(first).rejects.toThrow("bad scene"); expect(spawn).not.toHaveBeenCalled();
  });

  it("handles spawn throws, asynchronous errors, exits, and startup timeout", async () => {
    const thrown = fixture({ spawn: vi.fn(() => { throw new Error("boom"); }) });
    await expect(thrown.runner.start({ godotPath: "g", projectPath: "p" })).rejects.toThrow("boom");
    const errored = fixture(); const p1 = errored.runner.start({ godotPath: "g", projectPath: "p" }); await vi.waitFor(() => expect(errored.spawn).toHaveBeenCalled()); errored.owned.emit("error", new Error("ENOENT")); await expect(p1).rejects.toThrow("ENOENT");
    const exited = fixture(); const p2 = exited.runner.start({ godotPath: "g", projectPath: "p" }); await vi.waitFor(() => expect(exited.spawn).toHaveBeenCalled()); exited.owned.emit("exit", 2, null); await expect(p2).rejects.toThrow(/exited.*2/i);
    vi.useFakeTimers(); const stalled = fixture(); const p3 = stalled.runner.start({ godotPath: "g", projectPath: "p" }); const rejected = expect(p3).rejects.toThrow(/15 seconds/);
    await vi.advanceTimersByTimeAsync(15_000); await rejected; vi.useRealTimers();
  });

  it("captures output and final partial lines on natural exit, then clears identity", async () => {
    const { runner, owned, managed, terminateTree } = await started();
    owned.stdout.emit("data", Buffer.from("hello\npartial")); owned.stderr.emit("data", Buffer.from("oops"));
    owned.exitCode = 0; owned.emit("exit", 0, null);
    expect(managed).toMatchObject({ running: false, exit: { code: 0, signal: null, at: 100 } });
    expect(managed.output(0, 10).records.map((r) => r.text)).toEqual(["hello", "partial", "oops"]);
    await expect(runner.stop(managed.childId)).resolves.toMatchObject({ alreadyStopped: true, forced: false });
    expect(owned.kill).not.toHaveBeenCalled(); expect(terminateTree).not.toHaveBeenCalled();
  });

  it("stops gracefully and is idempotent", async () => {
    const { runner, owned, managed, terminateTree } = await started();
    owned.kill.mockImplementation(() => { owned.exitCode = 0; queueMicrotask(() => owned.emit("exit", 0, "SIGTERM")); return true; });
    await expect(runner.stop(managed.childId)).resolves.toMatchObject({ alreadyStopped: false, graceful: true, forced: false });
    await expect(runner.stop(managed.childId)).resolves.toMatchObject({ alreadyStopped: true });
    expect(owned.kill).toHaveBeenCalledOnce(); expect(owned.kill).toHaveBeenCalledWith("SIGTERM"); expect(terminateTree).not.toHaveBeenCalled();
  });

  it("forces only the exact child after the graceful deadline", async () => {
    vi.useFakeTimers(); const value = await started(); const stopping = value.runner.stop(value.managed.childId);
    await vi.advanceTimersByTimeAsync(5_000); expect(value.terminateTree).toHaveBeenCalledWith(value.owned, 7_000);
    value.owned.exitCode = 137; value.owned.emit("exit", null, "SIGKILL");
    await expect(stopping).resolves.toMatchObject({ graceful: false, forced: true }); vi.useRealTimers();
  });

  it("does not signal a reused PID after natural exit", async () => {
    const first = await started(); first.owned.exitCode = 0; first.owned.emit("exit", 0, null);
    const replacement = child(1234); (first.spawn as any).mockReturnValue(replacement);
    const pending = first.runner.start({ godotPath: "g", projectPath: "p" }); await vi.waitFor(() => expect(first.spawn).toHaveBeenCalledTimes(2)); replacement.emit("spawn"); const second = await pending;
    await first.runner.stop(first.managed.childId);
    expect(replacement.kill).not.toHaveBeenCalled(); expect(second.running).toBe(true);
  });

  it("bounds force-helper stalls, preserves helper errors, and cleans listeners", async () => {
    vi.useFakeTimers(); const force = deferred(); const value = await started(fixture({ terminateTree: vi.fn().mockReturnValue(force.promise) }));
    const stopping = value.runner.stop(value.managed.childId); const stalledRejection = expect(stopping).rejects.toThrow(/force termination.*7 seconds/i); await vi.advanceTimersByTimeAsync(12_000);
    await stalledRejection;
    expect(value.owned.listenerCount("error")).toBe(0); expect(value.owned.listenerCount("exit")).toBe(0);
    expect(value.owned.stdout.listenerCount("data")).toBe(0); expect(value.owned.stderr.listenerCount("data")).toBe(0); vi.useRealTimers();
    vi.useFakeTimers(); const failed = await started(fixture({ terminateTree: vi.fn().mockRejectedValue(new Error("taskkill failed")) }));
    const failedStop = failed.runner.stop(failed.managed.childId); const failedRejection = expect(failedStop).rejects.toThrow("taskkill failed"); await vi.advanceTimersByTimeAsync(5_000);
    await failedRejection; vi.useRealTimers();
  }, 10_000);
});
