import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { allocateLoopbackPort, captureBoundedOutput, launchWithPortRetry, liveTimeoutBudget, waitForPidExit, waitForProcessConnection, waitForProcessExit } from "./live-support.js";

describe("live Godot process support", () => {
  test("allocates a currently unused loopback port", async () => {
    const port = await allocateLoopbackPort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65_535);
  });

  test("waits for the exact child process exit without polling process names", async () => {
    const child = new EventEmitter() as EventEmitter & { exitCode: number | null; pid?: number };
    child.exitCode = null; child.pid = 1234;
    const pending = waitForProcessExit(child, 1_000);
    child.exitCode = 0; child.emit("exit", 0);
    await expect(pending).resolves.toBeUndefined();
    expect(child.listenerCount("exit")).toBe(0);
  });

  test("reports the exact PID when teardown misses its deadline", async () => {
    const child = new EventEmitter() as EventEmitter & { exitCode: number | null; pid?: number };
    child.exitCode = null; child.pid = 5678;
    await expect(waitForProcessExit(child, 5)).rejects.toThrow("PID 5678 did not exit");
    expect(child.listenerCount("exit")).toBe(0);
  });

  test("condition-polls exact PID liveness without process-name searches", async () => {
    let probes = 0;
    await waitForPidExit(2468, 1_000, () => ++probes < 3);
    expect(probes).toBe(3);
  });
  test("continuously drains output while retaining only the bounded diagnostic tail", () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const capture = captureBoundedOutput(stdout, stderr, 8);
    stdout.write("0123456789");
    stderr.write("abcdefghij");
    expect(capture.diagnostics()).toBe("stdout: 23456789\nstderr: cdefghij");
    capture.dispose();
    expect(stdout.listenerCount("data")).toBe(0);
    expect(stderr.listenerCount("data")).toBe(0);
  });

  test("slices an oversized incoming chunk before concatenation", () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const capture = captureBoundedOutput(stdout, stderr, 4);
    stdout.write(Buffer.alloc(1_000_000, "x"));
    expect(capture.diagnostics()).toContain("stdout: xxxx");
    capture.dispose();
  });

  test("reaps a classified bind collision and retries with a fresh OS-assigned port", async () => {
    const terminate = vi.fn(async () => undefined);
    const ports = [41001, 41002];
    const result = await launchWithPortRetry({
      attempts: 2,
      allocatePort: async () => ports.shift()!,
      launch: (port) => ({ port, diagnostics: port === 41001 ? "Godot could not listen: address already in use" : "" }),
      waitUntilConnected: async (process) => {
        if (process.port === 41001) throw new Error("connection timed out");
      },
      terminate,
      diagnostics: (process) => process.diagnostics,
      shouldRetry: (_error, process) => process.diagnostics.includes("address already in use"),
    });
    expect(result).toEqual({ port: 41002, diagnostics: "" });
    expect(terminate).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledWith({ port: 41001, diagnostics: "Godot could not listen: address already in use" });
  });

  test("does not retry a generic plugin failure and cleans up once", async () => {
    const terminate = vi.fn(async () => undefined);
    const allocatePort = vi.fn(async () => 42000);
    await expect(launchWithPortRetry({
      attempts: 3,
      allocatePort,
      launch: (port) => ({ port }),
      waitUntilConnected: async () => { throw new Error("plugin unavailable"); },
      terminate,
      diagnostics: () => "stderr: listen failed",
      shouldRetry: () => false,
    })).rejects.toThrow("attempt 1/3: plugin unavailable\nstderr: listen failed");
    expect(allocatePort).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
  });

  test("turns a spawn error into a controlled diagnostic failure", async () => {
    const child = new EventEmitter() as EventEmitter & { exitCode: number | null };
    child.exitCode = null;
    const pending = waitForProcessConnection({ child, isConnected: () => false, diagnostics: () => "stderr: bad path", timeoutMs: 1_000 });
    child.emit("error", new Error("spawn ENOENT"));
    await expect(pending).rejects.toThrow("Could not launch Godot: spawn ENOENT\nstderr: bad path");
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
  });

  test("fails immediately when Godot exits before connecting", async () => {
    const child = new EventEmitter() as EventEmitter & { exitCode: number | null };
    child.exitCode = null;
    const started = Date.now();
    const pending = waitForProcessConnection({ child, isConnected: () => false, diagnostics: () => "stdout: parse error", timeoutMs: 5_000 });
    child.exitCode = 1;
    child.emit("exit", 1);
    await expect(pending).rejects.toThrow("Godot exited with code 1 before connecting\nstdout: parse error");
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("outer timeout budget exceeds every reachable internal deadline", () => {
    const budget = liveTimeoutBudget({ attempts: 3, connectMs: 5_000, terminateMs: 7_000, reconnectMs: 20_000, marginMs: 5_000 });
    expect(budget).toBe(68_000);
    expect(budget).toBeGreaterThan(3 * (5_000 + 7_000) + 20_000 + 7_000);
  });
});
