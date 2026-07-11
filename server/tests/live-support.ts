import type { Readable } from "node:stream";
import type { EventEmitter } from "node:events";

export interface OutputCapture {
  diagnostics(): string;
  dispose(): void;
}

export function captureBoundedOutput(stdout: Readable, stderr: Readable, limit = 16_384): OutputCapture {
  let out = Buffer.alloc(0);
  let err = Buffer.alloc(0);
  const append = (current: Buffer, chunk: unknown): Buffer => {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const tail = incoming.length > limit ? incoming.subarray(incoming.length - limit) : incoming;
    const next = Buffer.concat([current, tail]);
    return next.length > limit ? next.subarray(next.length - limit) : next;
  };
  const onStdout = (chunk: unknown) => { out = append(out, chunk); };
  const onStderr = (chunk: unknown) => { err = append(err, chunk); };
  stdout.on("data", onStdout);
  stderr.on("data", onStderr);
  return {
    diagnostics: () => `stdout: ${out.toString("utf8")}\nstderr: ${err.toString("utf8")}`,
    dispose: () => {
      stdout.off("data", onStdout);
      stderr.off("data", onStderr);
    },
  };
}

export async function launchWithPortRetry<T>(options: {
  attempts: number;
  allocatePort(): Promise<number>;
  launch(port: number): T;
  waitUntilConnected(process: T): Promise<void>;
  terminate(process: T): Promise<void>;
  diagnostics(process: T): string;
  shouldRetry(error: Error, process: T): boolean;
}): Promise<T> {
  const failures: string[] = [];
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    const port = await options.allocatePort();
    const process = options.launch(port);
    try {
      await options.waitUntilConnected(process);
      return process;
    } catch (error) {
      const launchError = error instanceof Error ? error : new Error(String(error));
      const diagnostics = options.diagnostics(process);
      failures.push(`attempt ${attempt}/${options.attempts}: ${launchError.message}${launchError.message.includes(diagnostics) ? "" : `\n${diagnostics}`}`);
      await options.terminate(process);
      if (!options.shouldRetry(launchError, process)) throw new Error(failures.at(-1));
    }
  }
  throw new Error(`Godot failed to launch after ${options.attempts} attempts\n${failures.join("\n")}`);
}

interface ProcessEvents extends EventEmitter { exitCode: number | null }

export function waitForProcessConnection(options: {
  child: ProcessEvents;
  isConnected(): boolean;
  diagnostics(): string;
  timeoutMs: number;
  pollMs?: number;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      options.child.off("error", onError);
      options.child.off("exit", onExit);
      error ? reject(error) : resolve();
    };
    const onError = (error: Error) => finish(new Error(`Could not launch Godot: ${error.message}\n${options.diagnostics()}`));
    const onExit = (code: number | null) => finish(new Error(`Godot exited with code ${code ?? "unknown"} before connecting\n${options.diagnostics()}`));
    options.child.on("error", onError);
    options.child.on("exit", onExit);
    const poll = setInterval(() => { if (options.isConnected()) finish(); }, options.pollMs ?? 50);
    const timeout = setTimeout(() => finish(new Error(`Godot plugin connection timed out\n${options.diagnostics()}`)), options.timeoutMs);
    if (options.child.exitCode !== null) onExit(options.child.exitCode);
    else if (options.isConnected()) finish();
  });
}

export function liveTimeoutBudget(options: {
  attempts: number; connectMs: number; terminateMs: number; reconnectMs: number; marginMs: number;
}): number {
  return options.attempts * (options.connectMs + options.terminateMs) + options.reconnectMs + options.terminateMs + options.marginMs;
}
