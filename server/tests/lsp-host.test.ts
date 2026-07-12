import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LspHost, terminateWindowsProcessTree } from "../src/lsp/host.js";

function child() {
  const value = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  value.stdout = new EventEmitter(); value.stderr = new EventEmitter();
  return value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(overrides: { autoStart?: boolean; probe?: ReturnType<typeof vi.fn>; validatePaths?: ReturnType<typeof vi.fn>; terminate?: ReturnType<typeof vi.fn> } = {}) {
  const ownedChild = child();
  const probe = overrides.probe ?? vi.fn().mockResolvedValue(true);
  const spawn = vi.fn().mockReturnValue(ownedChild);
  const terminate = overrides.terminate ?? vi.fn().mockResolvedValue(undefined);
  const host = new LspHost({ lspPort: 6005, lspAutoStart: overrides.autoStart ?? true, godotPath: "C:\\Godot\\godot.exe", projectPath: "C:\\game" },
    { probe, spawn, terminate, delay: vi.fn().mockResolvedValue(undefined), validatePaths: overrides.validatePaths ?? vi.fn().mockResolvedValue(undefined) });
  return { host, probe, spawn, terminate, ownedChild };
}

describe("LspHost", () => {
  it("rejects a taskkill spawn error and cleans listeners", async () => {
    const taskkill = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> }; taskkill.kill = vi.fn();
    const pending = terminateWindowsProcessTree(4321, 1_000, (() => taskkill) as any);
    taskkill.emit("error", new Error("spawn taskkill ENOENT"));
    await expect(pending).rejects.toThrow("spawn taskkill ENOENT");
    expect(taskkill.listenerCount("error")).toBe(0); expect(taskkill.listenerCount("exit")).toBe(0);
  });

  it("bounds a stalled taskkill child and cleans listeners", async () => {
    const taskkill = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> }; taskkill.kill = vi.fn();
    await expect(terminateWindowsProcessTree(8765, 5, (() => taskkill) as any)).rejects.toThrow("timed out");
    expect(taskkill.kill).toHaveBeenCalledOnce();
    expect(taskkill.listenerCount("error")).toBe(0); expect(taskkill.listenerCount("exit")).toBe(0);
  });

  it("does not leave a timer when taskkill exits during listener registration", async () => {
    vi.useFakeTimers();
    const taskkill = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> }; taskkill.kill = vi.fn();
    const originalOnce = taskkill.once.bind(taskkill); taskkill.once = ((event: string, listener: (...args: any[]) => void) => {
      const result = originalOnce(event, listener); if (event === "exit") taskkill.emit("exit", 0); return result;
    }) as any;
    await expect(terminateWindowsProcessTree(1111, 1_000, (() => taskkill) as any)).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
  });
  it("attaches without spawning when the port already answers", async () => {
    const { host, spawn, terminate } = fixture();
    await expect(host.ensureAvailable()).resolves.toBe("attached");
    expect(spawn).not.toHaveBeenCalled();
    await host.close();
    expect(terminate).not.toHaveBeenCalled();
  });

  it("terminates only the child it launched", async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const { host, terminate, ownedChild } = fixture({ probe });
    await expect(host.ensureAvailable()).resolves.toBe("owned");
    await host.close();
    expect(terminate).toHaveBeenCalledWith(ownedChild);
  });

  it("spawns shell-free with the exact reviewed argv", async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const { host, spawn } = fixture({ probe });
    await host.ensureAvailable();
    expect(spawn).toHaveBeenCalledWith("C:\\Godot\\godot.exe", ["--editor", "--headless", "--lsp-port", "6005", "--path", "C:\\game"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  });

  it("does not launch when auto-start is disabled and reports a quoted command", async () => {
    const { host, spawn } = fixture({ autoStart: false, probe: vi.fn().mockResolvedValue(false) });
    await expect(host.ensureAvailable()).rejects.toMatchObject({ code: "not_connected", hint: expect.stringContaining('"C:\\Godot\\godot.exe" --editor --headless --lsp-port 6005 --path "C:\\game"') });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("is idempotent across ensure and close", async () => {
    const { host, probe, terminate } = fixture();
    await host.ensureAvailable(); await host.ensureAvailable(); await host.close(); await host.close();
    expect(probe).toHaveBeenCalledOnce(); expect(terminate).not.toHaveBeenCalled();
  });

  it("terminates its exact child when bounded startup fails", async () => {
    const probe = vi.fn().mockResolvedValue(false);
    const { host, terminate, ownedChild } = fixture({ probe });
    await expect(host.ensureAvailable()).rejects.toMatchObject({ code: "timeout" });
    expect(terminate).toHaveBeenCalledWith(ownedChild);
    expect(probe.mock.calls.length).toBeLessThanOrEqual(30);
  });

  it("does not own an external server that wins after its child exits", async () => {
    const ownedChild = child();
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    const terminate = vi.fn().mockResolvedValue(undefined);
    const host = new LspHost({ lspPort: 6005, lspAutoStart: true, godotPath: "godot", projectPath: "game" }, {
      probe, spawn: vi.fn().mockReturnValue(ownedChild), terminate,
      delay: vi.fn().mockImplementation(async () => { ownedChild.emit("exit", 1, null); }),
      validatePaths: vi.fn().mockResolvedValue(undefined),
    });
    await expect(host.ensureAvailable()).resolves.toBe("attached");
    await host.close();
    expect(terminate).not.toHaveBeenCalled();
  });

  it("serializes close with a delayed attach probe and rejects later ensure", async () => {
    const answer = deferred<boolean>();
    const { host, spawn, terminate } = fixture({ probe: vi.fn().mockReturnValue(answer.promise) });
    const ensuring = host.ensureAvailable(); const closing = host.close(); answer.resolve(true);
    await expect(ensuring).rejects.toMatchObject({ code: "not_connected" });
    await closing;
    await expect(host.ensureAvailable()).rejects.toMatchObject({ code: "not_connected" });
    expect(spawn).not.toHaveBeenCalled(); expect(terminate).not.toHaveBeenCalled();
  });

  it("does not spawn when close races delayed path validation", async () => {
    const validation = deferred<void>(); const validationStarted = deferred<void>();
    const validatePaths = vi.fn().mockImplementation(() => { validationStarted.resolve(); return validation.promise; });
    const { host, spawn, terminate } = fixture({ probe: vi.fn().mockResolvedValue(false), validatePaths });
    const ensuring = host.ensureAvailable(); await validationStarted.promise;
    const closing = host.close(); validation.resolve();
    await expect(ensuring).rejects.toMatchObject({ code: "not_connected" }); await closing;
    expect(spawn).not.toHaveBeenCalled(); expect(terminate).not.toHaveBeenCalled();
  });

  it("terminates a child spawned immediately before close without leaking ownership", async () => {
    const ownedChild = child(); const terminate = vi.fn().mockResolvedValue(undefined); let host!: LspHost;
    const spawned = deferred<void>(); const nextProbe = deferred<boolean>();
    host = new LspHost({ lspPort: 6005, lspAutoStart: true, godotPath: "godot", projectPath: "game" }, {
      probe: vi.fn().mockResolvedValueOnce(false).mockReturnValue(nextProbe.promise),
      spawn: vi.fn().mockImplementation(() => { spawned.resolve(); return ownedChild; }), terminate,
      delay: vi.fn().mockResolvedValue(undefined), validatePaths: vi.fn().mockResolvedValue(undefined),
    });
    const ensuring = host.ensureAvailable(); await spawned.promise; const closing = host.close(); nextProbe.resolve(true);
    await expect(ensuring).rejects.toMatchObject({ code: "not_connected" }); await closing;
    expect(terminate).toHaveBeenCalledTimes(1); expect(terminate).toHaveBeenCalledWith(ownedChild);
    expect(host.ownership).toBeUndefined();
  });

  it("rejects a project directory without a regular project.godot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "robogodot-host-"));
    try {
      const godot = path.join(root, "godot.exe"); const project = path.join(root, "project");
      await writeFile(godot, "binary"); await mkdir(project);
      const spawn = vi.fn();
      const host = new LspHost({ lspPort: 6005, lspAutoStart: true, godotPath: godot, projectPath: project }, { probe: vi.fn().mockResolvedValue(false), spawn });
      await expect(host.ensureAvailable()).rejects.toThrow(/project\.godot/);
      expect(spawn).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rechecks child failure after a successful probe before assigning ownership", async () => {
    const ownedChild = child(); const successfulProbe = deferred<boolean>(); const terminate = vi.fn().mockResolvedValue(undefined);
    const probe = vi.fn().mockResolvedValueOnce(false).mockReturnValueOnce(successfulProbe.promise).mockResolvedValue(true);
    const host = new LspHost({ lspPort: 6005, lspAutoStart: true, godotPath: "godot", projectPath: "game" }, {
      probe, spawn: vi.fn().mockReturnValue(ownedChild), terminate, delay: vi.fn().mockResolvedValue(undefined), validatePaths: vi.fn().mockResolvedValue(undefined),
    });
    const ensuring = host.ensureAvailable(); await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    ownedChild.emit("exit", 1, null); successfulProbe.resolve(true);
    await expect(ensuring).resolves.toBe("attached"); await host.close();
    expect(probe).toHaveBeenCalledTimes(3); expect(terminate).not.toHaveBeenCalled();
  });

  it("replaces startup listeners with owned-lifetime listeners", async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const { host, ownedChild } = fixture({ probe }); await host.ensureAvailable();
    expect(ownedChild.listenerCount("error")).toBe(1);
    expect(ownedChild.listenerCount("exit")).toBe(1);
    expect(ownedChild.stdout.listenerCount("data")).toBe(1); expect(ownedChild.stderr.listenerCount("data")).toBe(1);
  });

  it("clears an exited owned child before attaching an external replacement", async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValue(true);
    const { host, ownedChild, terminate } = fixture({ probe });
    await expect(host.ensureAvailable()).resolves.toBe("owned");
    ownedChild.emit("exit", 0, null);
    expect(host.ownership).toBeUndefined();
    await expect(host.ensureAvailable()).resolves.toBe("attached");
    await host.close();
    expect(terminate).not.toHaveBeenCalled();
    expect(ownedChild.listenerCount("exit")).toBe(0);
  });

  it("captures bounded output for the full owned lifetime and detaches on close", async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const terminate = vi.fn().mockImplementation(async (ownedChild: ReturnType<typeof child>) => { ownedChild.stdout.emit("data", "shutdown-tail"); });
    const { host, ownedChild } = fixture({ probe, terminate }); await host.ensureAvailable();
    ownedChild.stdout.emit("data", Buffer.from(`discard-${"x".repeat(20_000)}stdout-tail`));
    ownedChild.stderr.emit("data", Buffer.from(`discard-${"y".repeat(20_000)}stderr-tail`));
    const diagnostics = host.diagnostics();
    expect(Buffer.byteLength(diagnostics.stdout)).toBe(16_384); expect(diagnostics.stdout.endsWith("stdout-tail")).toBe(true);
    expect(Buffer.byteLength(diagnostics.stderr)).toBe(16_384); expect(diagnostics.stderr.endsWith("stderr-tail")).toBe(true);
    await host.close();
    expect(host.diagnostics().stdout.endsWith("shutdown-tail")).toBe(true);
    expect(ownedChild.listenerCount("exit")).toBe(0);
    expect(ownedChild.stdout.listenerCount("data")).toBe(0); expect(ownedChild.stderr.listenerCount("data")).toBe(0);
  });

  it("captures an owned child error after readiness without an unhandled throw", async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const { host, ownedChild, terminate } = fixture({ probe }); await host.ensureAvailable();
    const failure = new Error(`owned-failure-${"z".repeat(20_000)}-tail`);
    expect(ownedChild.listenerCount("error")).toBe(1);
    expect(() => ownedChild.emit("error", failure)).not.toThrow();
    const diagnostics = host.diagnostics();
    expect(Buffer.byteLength(diagnostics.stderr)).toBe(16_384);
    expect(diagnostics.stderr.endsWith("-tail")).toBe(true);
    await expect(host.close()).rejects.toBe(failure);
    expect(terminate).toHaveBeenCalledWith(ownedChild);
    expect(ownedChild.listenerCount("error")).toBe(0); expect(ownedChild.listenerCount("exit")).toBe(0);
  });

  it("captures an owned child error during teardown and detaches after cleanup", async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const failure = new Error("teardown child error");
    const terminate = vi.fn().mockImplementation(async (ownedChild: ReturnType<typeof child>) => {
      expect(() => ownedChild.emit("error", failure)).not.toThrow();
    });
    const { host, ownedChild } = fixture({ probe, terminate }); await host.ensureAvailable();
    await expect(host.close()).rejects.toBe(failure);
    expect(terminate).toHaveBeenCalledOnce();
    expect(host.diagnostics().stderr).toContain("teardown child error");
    expect(ownedChild.listenerCount("error")).toBe(0); expect(ownedChild.listenerCount("exit")).toBe(0);
    expect(ownedChild.stdout.listenerCount("data")).toBe(0); expect(ownedChild.stderr.listenerCount("data")).toBe(0);
  });
});
