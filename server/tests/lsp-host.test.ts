import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { LspHost } from "../src/lsp/host.js";

function child() {
  const value = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  value.stdout = new EventEmitter(); value.stderr = new EventEmitter();
  return value;
}

function fixture(overrides: { autoStart?: boolean; probe?: ReturnType<typeof vi.fn> } = {}) {
  const ownedChild = child();
  const probe = overrides.probe ?? vi.fn().mockResolvedValue(true);
  const spawn = vi.fn().mockReturnValue(ownedChild);
  const terminate = vi.fn().mockResolvedValue(undefined);
  const host = new LspHost({ lspPort: 6005, lspAutoStart: overrides.autoStart ?? true, godotPath: "C:\\Godot\\godot.exe", projectPath: "C:\\game" },
    { probe, spawn, terminate, delay: vi.fn().mockResolvedValue(undefined), validatePaths: vi.fn().mockResolvedValue(undefined) });
  return { host, probe, spawn, terminate, ownedChild };
}

describe("LspHost", () => {
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
});
