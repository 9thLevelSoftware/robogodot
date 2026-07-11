import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { captureBoundedOutput, launchWithPortRetry } from "./live-support.js";

describe("live Godot process support", () => {
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

  test("reaps a failed launch and retries with a fresh OS-assigned port", async () => {
    const terminate = vi.fn(async () => undefined);
    const ports = [41001, 41002];
    const result = await launchWithPortRetry({
      attempts: 2,
      allocatePort: async () => ports.shift()!,
      launch: (port) => ({ port }),
      waitUntilConnected: async (process) => {
        if (process.port === 41001) throw new Error("bind collision: address already in use");
      },
      terminate,
      diagnostics: (process) => `port=${process.port}`,
    });
    expect(result).toEqual({ port: 41002 });
    expect(terminate).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledWith({ port: 41001 });
  });

  test("reports all bounded launch diagnostics after the exact retry count", async () => {
    await expect(launchWithPortRetry({
      attempts: 2,
      allocatePort: async () => 42000,
      launch: (port) => ({ port }),
      waitUntilConnected: async () => { throw new Error("plugin unavailable"); },
      terminate: async () => undefined,
      diagnostics: () => "stderr: listen failed",
    })).rejects.toThrow("attempt 2/2: plugin unavailable\nstderr: listen failed");
  });
});
