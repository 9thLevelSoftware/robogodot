import type { Readable } from "node:stream";
import type { EventEmitter } from "node:events";
import { once } from "node:events";
import { createServer } from "node:net";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { relative, sep } from "node:path";
import { tmpdir } from "node:os";

export interface OutputCapture {
  diagnostics(): string;
  dispose(): void;
}

export async function runCleanupSteps(primaryFailure: unknown, steps: Array<() => Promise<void>>): Promise<void> {
  let firstCleanupFailure: unknown;
  for (const step of steps) { try { await step(); } catch (error) { firstCleanupFailure ??= error; } }
  if (firstCleanupFailure === undefined) return;
  if (primaryFailure instanceof Error) {
    primaryFailure.message += `\nCleanup failure: ${firstCleanupFailure instanceof Error ? firstCleanupFailure.message : String(firstCleanupFailure)}`;
    return;
  }
  throw firstCleanupFailure;
}

export async function closeAllInOrder(steps: Array<() => Promise<void>>): Promise<void> { return runCleanupSteps(undefined, steps); }

export async function createIsolatedGodotProject(sourceRoot: string): Promise<string> {
  const destination = await mkdtemp(`${tmpdir()}${sep}robogodot-phase4-`);
  try {
    await cp(sourceRoot, destination, { recursive: true, filter: (candidate) => !relative(sourceRoot, candidate).split(/[\\/]/).includes(".godot") });
    return destination;
  } catch (error) {
    await rm(destination, { recursive: true, force: true }); throw error;
  }
}

export async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("Could not allocate a loopback port."); }
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

interface ExitProcess extends EventEmitter { exitCode: number | null; pid?: number }

export function waitForProcessExit(child: ExitProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout); child.off("exit", onExit);
      error ? reject(error) : resolve();
    };
    const onExit = () => finish();
    child.once("exit", onExit);
    const timeout = setTimeout(() => finish(new Error(`PID ${child.pid ?? "unknown"} did not exit within ${timeoutMs} ms.`)), timeoutMs);
    if (child.exitCode !== null) finish();
  });
}

export function waitForPidExit(pid: number, timeoutMs: number, isAlive: (pid: number) => boolean = (candidate) => {
  try { process.kill(candidate, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (!isAlive(pid)) resolve();
      else if (Date.now() >= deadline) reject(new Error(`PID ${pid} did not exit within ${timeoutMs} ms.`));
      else setTimeout(check, 50);
    };
    check();
  });
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
  isConnected(): boolean | Promise<boolean>;
  diagnostics(): string;
  timeoutMs: number;
  pollMs?: number;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (poll) clearTimeout(poll);
      clearTimeout(timeout);
      options.child.off("error", onError);
      options.child.off("exit", onExit);
      error ? reject(error) : resolve();
    };
    const onError = (error: Error) => finish(new Error(`Could not launch Godot: ${error.message}\n${options.diagnostics()}`));
    const onExit = (code: number | null) => finish(new Error(`Godot exited with code ${code ?? "unknown"} before connecting\n${options.diagnostics()}`));
    options.child.on("error", onError);
    options.child.on("exit", onExit);
    const check = async () => {
      try { if (await options.isConnected()) finish(); else if (!settled) poll = setTimeout(check, options.pollMs ?? 50); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    };
    void check();
    const timeout = setTimeout(() => finish(new Error(`Godot plugin connection timed out\n${options.diagnostics()}`)), options.timeoutMs);
    if (options.child.exitCode !== null) onExit(options.child.exitCode);
  });
}

export function liveTimeoutBudget(options: {
  attempts: number; connectMs: number; terminateMs: number; reconnectMs: number; marginMs: number;
}): number {
  return options.attempts * (options.connectMs + options.terminateMs) + options.reconnectMs + options.terminateMs + options.marginMs;
}
