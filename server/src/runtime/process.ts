import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { OutputRing, type OutputPage } from "./output-ring.js";
import { PROCESS_FORCE_STOP_MS, PROCESS_GRACEFUL_STOP_MS, PROCESS_OUTPUT_DRAIN_MS, PROCESS_START_TIMEOUT_MS } from "./limits.js";

type RuntimeChild = Pick<ChildProcess, "pid" | "stdout" | "stderr" | "on" | "once" | "off" | "kill" | "exitCode" | "signalCode">;
type SpawnOptions = { cwd: string; env: NodeJS.ProcessEnv; shell: false; windowsHide: true; stdio: ["ignore", "pipe", "pipe"] };

export interface ProcessStartOptions {
  godotPath: string;
  projectPath: string;
  scene?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
}
export interface ProcessExit { code: number | null; signal: NodeJS.Signals | null; at: number; error?: string }
export interface ManagedProcess {
  readonly childId: string;
  readonly pid: number;
  readonly startedAt: number;
  readonly running: boolean;
  readonly exit: ProcessExit | undefined;
  output(since: number, limit: number): OutputPage;
}
export interface StopResult { childId: string; alreadyStopped: boolean; graceful: boolean; forced: boolean; exit?: ProcessExit }
export interface ProcessRunnerDependencies {
  spawn?: (command: string, args: string[], options: SpawnOptions) => RuntimeChild;
  terminateTree?: (child: RuntimeChild, timeoutMs: number) => Promise<void>;
  validate?: (options: ProcessStartOptions) => Promise<void>;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  childId?: () => string;
}

interface Owned {
  childId: string; child: RuntimeChild; pid: number | undefined; startedAt: number; ring: OutputRing;
  running: boolean; exit?: ProcessExit; detachAll: () => void; beginDrain: () => void; exited: Promise<void>; resolveExited: () => void;
  drained: Promise<void>; resolveDrained: () => void;
  stopping: Promise<StopResult> | undefined;
}

export class ProcessRunner {
  private current: Owned | undefined;
  private readonly owned = new Map<string, Owned>();
  private starting = false;
  private readonly deps: Required<ProcessRunnerDependencies>;

  constructor(dependencies: ProcessRunnerDependencies = {}) {
    this.deps = {
      spawn: dependencies.spawn ?? ((command, args, options) => nodeSpawn(command, args, options)),
      terminateTree: dependencies.terminateTree ?? terminateTree,
      validate: dependencies.validate ?? validate,
      now: dependencies.now ?? Date.now,
      setTimer: dependencies.setTimer ?? setTimeout,
      clearTimer: dependencies.clearTimer ?? clearTimeout,
      childId: dependencies.childId ?? randomUUID,
    };
  }

  async start(options: ProcessStartOptions): Promise<ManagedProcess> {
    if (this.starting || this.current?.running) throw new Error("A managed process is already starting or running.");
    this.starting = true;
    try {
      await this.deps.validate(options);
      if (this.current?.running) throw new Error("A managed process is already running.");
      const argv = ["--path", options.projectPath, ...(options.scene ? [options.scene] : []), ...(options.args ?? [])];
      let child: RuntimeChild;
      try {
        child = this.deps.spawn(options.godotPath, argv, {
          cwd: options.projectPath, env: { ...process.env, ...options.env }, shell: false,
          windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) { throw error; }
      const owned = this.install(child, this.deps.childId(), child.pid, this.deps.now());
      this.current = owned;
      this.owned.set(owned.childId, owned);
      if (child.pid === undefined) {
        await this.cleanupInvalidChild(owned);
        throw new Error("Spawned process did not provide a PID.");
      }
      try { await this.waitForSpawn(owned); }
      catch (error) {
        if (owned.running) {
          try { await this.cleanupFailedStart(owned); }
          catch (cleanupError) {
            throw new AggregateError([error, cleanupError], `${errorMessage(error)} Cleanup failed: ${errorMessage(cleanupError)}`);
          }
        }
        throw error;
      }
      return this.publicView(owned);
    } finally { this.starting = false; }
  }

  stop(childId: string): Promise<StopResult> {
    const owned = this.owned.get(childId);
    if (!owned || !owned.running) {
      return owned ? owned.drained.then(() => ({ childId, alreadyStopped: true, graceful: false, forced: false, ...(owned.exit ? { exit: owned.exit } : {}) })) : Promise.resolve({ childId, alreadyStopped: true, graceful: false, forced: false });
    }
    if (!owned.stopping) {
      const stopping = this.performStop(owned);
      owned.stopping = stopping;
      void stopping.then(() => { if (owned.stopping === stopping) owned.stopping = undefined; }, () => { if (owned.stopping === stopping) owned.stopping = undefined; });
    }
    return owned.stopping;
  }

  stopCurrent(): Promise<StopResult | undefined> {
    return this.current ? this.stop(this.current.childId) : Promise.resolve(undefined);
  }

  private install(child: RuntimeChild, childId: string, pid: number | undefined, startedAt: number): Owned {
    const ring = new OutputRing();
    let resolveExited!: () => void; let resolveDrained!: () => void;
    const exited = new Promise<void>((resolve) => { resolveExited = resolve; });
    const drained = new Promise<void>((resolve) => { resolveDrained = resolve; });
    const owned: Owned = { childId, child, pid, startedAt, ring, running: true, detachAll: () => {}, beginDrain: () => {}, exited, resolveExited, drained, resolveDrained, stopping: undefined };
    const finalized: Record<"stdout" | "stderr", boolean> = { stdout: child.stdout === null, stderr: child.stderr === null };
    const closed: Record<"stdout" | "stderr", boolean> = { stdout: child.stdout === null, stderr: child.stderr === null };
    let drainTimer: ReturnType<typeof setTimeout> | undefined; let drainedDone = false;
    const onStdout = (chunk: unknown) => ring.append("stdout", toBytes(chunk), this.deps.now());
    const onStderr = (chunk: unknown) => ring.append("stderr", toBytes(chunk), this.deps.now());
    const onError = (error: Error) => {
      ring.append("stderr", Buffer.from(error.message), this.deps.now());
      if (!owned.exit) owned.exit = { code: null, signal: null, at: this.deps.now(), error: error.message };
    };
    const finishStream = (stream: "stdout" | "stderr") => {
      if (finalized[stream]) return; finalized[stream] = true; ring.finish(stream, this.deps.now());
      const source = child[stream]; source?.off("data", stream === "stdout" ? onStdout : onStderr); source?.off("end", stream === "stdout" ? onStdoutEnd : onStderrEnd);
    };
    const closeStream = (stream: "stdout" | "stderr") => {
      if (closed[stream]) return; finishStream(stream); closed[stream] = true;
      const source = child[stream]; source?.off("error", stream === "stdout" ? onStdoutError : onStderrError); source?.off("close", stream === "stdout" ? onStdoutClose : onStderrClose);
      settleDrain();
    };
    const onStdoutError = () => finishStream("stdout"); const onStderrError = () => finishStream("stderr");
    const onStdoutEnd = () => finishStream("stdout"); const onStderrEnd = () => finishStream("stderr");
    const onStdoutClose = () => closeStream("stdout"); const onStderrClose = () => closeStream("stderr");
    const settleDrain = () => {
      if (drainedDone || owned.running || !closed.stdout || !closed.stderr) return;
      drainedDone = true; if (drainTimer) this.deps.clearTimer(drainTimer); detachChild(); owned.resolveDrained(); this.owned.delete(childId);
    };
    const detachChild = () => { child.off("error", onError); child.off("exit", onExit); };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (!owned.running) return;
      owned.running = false; owned.exit = { code, signal, at: this.deps.now(), ...(owned.exit?.error ? { error: owned.exit.error } : {}) };
      if (this.current === owned) this.current = undefined;
      owned.resolveExited(); owned.beginDrain();
    };
    owned.beginDrain = () => {
      settleDrain();
      if (!drainedDone && !drainTimer) drainTimer = this.deps.setTimer(() => { closeStream("stdout"); closeStream("stderr"); }, PROCESS_OUTPUT_DRAIN_MS);
    };
    owned.detachAll = () => {
      if (drainTimer) this.deps.clearTimer(drainTimer); detachChild();
      child.stdout?.off("data", onStdout); child.stdout?.off("error", onStdoutError); child.stdout?.off("end", onStdoutEnd); child.stdout?.off("close", onStdoutClose);
      child.stderr?.off("data", onStderr); child.stderr?.off("error", onStderrError); child.stderr?.off("end", onStderrEnd); child.stderr?.off("close", onStderrClose);
    };
    child.on("error", onError); child.once("exit", onExit);
    child.stdout?.on("data", onStdout); child.stdout?.on("error", onStdoutError); child.stdout?.once("end", onStdoutEnd); child.stdout?.once("close", onStdoutClose);
    child.stderr?.on("data", onStderr); child.stderr?.on("error", onStderrError); child.stderr?.once("end", onStderrEnd); child.stderr?.once("close", onStderrClose);
    return owned;
  }

  private waitForSpawn(owned: Owned): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false; let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (settled) return; settled = true; if (timer) this.deps.clearTimer(timer);
        owned.child.off("spawn", onSpawn); owned.child.off("error", onError); owned.child.off("exit", onExit);
        error ? reject(error) : resolve();
      };
      const onSpawn = () => finish();
      const onError = (error: Error) => finish(error);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(`Managed process exited during startup (code ${String(code)}, signal ${String(signal)}).`));
      owned.child.once("spawn", onSpawn); owned.child.once("error", onError); owned.child.once("exit", onExit);
      if (!settled) timer = this.deps.setTimer(() => finish(new Error("Managed process did not start within 15 seconds.")), PROCESS_START_TIMEOUT_MS);
    });
  }

  private async performStop(owned: Owned): Promise<StopResult> {
    if (!owned.running) { await owned.drained; return { childId: owned.childId, alreadyStopped: true, graceful: false, forced: false, ...(owned.exit ? { exit: owned.exit } : {}) }; }
    let forced = false;
    try {
      owned.child.kill("SIGTERM");
      if (await this.waitExit(owned, PROCESS_GRACEFUL_STOP_MS)) { await owned.drained; return { childId: owned.childId, alreadyStopped: false, graceful: true, forced: false, ...(owned.exit ? { exit: owned.exit } : {}) }; }
      if (!owned.running) { await owned.drained; return { childId: owned.childId, alreadyStopped: false, graceful: true, forced: false, ...(owned.exit ? { exit: owned.exit } : {}) }; }
      forced = true;
      await this.withDeadline(this.deps.terminateTree(owned.child, PROCESS_FORCE_STOP_MS), PROCESS_FORCE_STOP_MS, "Force termination timed out after 7 seconds.");
      if (!await this.waitExit(owned, PROCESS_FORCE_STOP_MS)) throw new Error("Force termination completed but exact-child exit was not confirmed within 7 seconds.");
      await owned.drained;
      return { childId: owned.childId, alreadyStopped: false, graceful: false, forced, ...(owned.exit ? { exit: owned.exit } : {}) };
    } finally { /* exit and drain listeners remain until confirmed completion */ }
  }

  private async cleanupFailedStart(owned: Owned): Promise<void> {
    owned.child.kill("SIGTERM");
    if (!owned.running) { await owned.drained; return; }
    if (owned.pid === undefined) throw new Error("Startup cleanup cannot force a child without a PID.");
    await this.withDeadline(this.deps.terminateTree(owned.child, PROCESS_FORCE_STOP_MS), PROCESS_FORCE_STOP_MS, "Startup cleanup timed out after 7 seconds.");
    if (!await this.waitExit(owned, PROCESS_FORCE_STOP_MS)) throw new Error("Startup cleanup completed but exact-child exit was not confirmed within 7 seconds.");
    await owned.drained;
  }

  private async cleanupInvalidChild(owned: Owned): Promise<void> {
    try { owned.child.kill("SIGTERM"); } catch { /* best effort for malformed spawn result */ }
    owned.running = false; if (this.current === owned) this.current = undefined; owned.resolveExited(); owned.beginDrain(); await owned.drained;
  }

  private waitExit(owned: Owned, milliseconds: number): Promise<boolean> {
    return this.withDeadline(owned.exited.then(() => true), milliseconds, undefined, false);
  }

  private withDeadline<T>(promise: Promise<T>, milliseconds: number, message?: string, rejectOnTimeout = true): Promise<T | false> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = this.deps.setTimer(() => { if (settled) return; settled = true; rejectOnTimeout ? reject(new Error(message ?? "Operation timed out.")) : resolve(false); }, milliseconds);
      void promise.then((value) => { if (settled) return; settled = true; this.deps.clearTimer(timer); resolve(value); }, (error) => { if (settled) return; settled = true; this.deps.clearTimer(timer); reject(error); });
    });
  }

  private publicView(owned: Owned): ManagedProcess {
    return Object.freeze({
      childId: owned.childId, pid: owned.pid!, startedAt: owned.startedAt,
      get running() { return owned.running; }, get exit() { return owned.exit ? { ...owned.exit } : undefined; },
      output: (since: number, limit: number) => owned.ring.read(since, limit),
    });
  }
}

async function validate(options: ProcessStartOptions): Promise<void> {
  if (!options.godotPath || !options.projectPath) throw new Error("godotPath and projectPath are required.");
  if (options.scene && (!options.scene.startsWith("res://") || options.scene.includes(".."))) throw new Error("scene must be a contained res:// path.");
  const executable = await stat(options.godotPath); const project = await stat(options.projectPath); const marker = await stat(path.join(options.projectPath, "project.godot"));
  if (!executable.isFile()) throw new Error(`Godot executable is not a file: ${options.godotPath}`);
  if (!project.isDirectory() || !marker.isFile()) throw new Error(`Project must be a directory containing project.godot: ${options.projectPath}`);
  if (process.platform !== "win32") await access(options.godotPath, constants.X_OK);
  if (options.scene) { const scene = await stat(path.join(options.projectPath, ...options.scene.slice(6).split("/"))); if (!scene.isFile()) throw new Error(`Scene is not a file: ${options.scene}`); }
}

async function terminateTree(child: RuntimeChild, timeoutMs: number): Promise<void> {
  if (process.platform !== "win32") { child.kill("SIGKILL"); return; }
  if (child.pid === undefined) throw new Error("Cannot terminate a child without a PID.");
  await new Promise<void>((resolve, reject) => {
    const helper = nodeSpawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); helper.off("error", onError); helper.off("exit", onExit);
      error ? reject(error) : resolve();
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null) => finish(code === 0 ? undefined : new Error(`taskkill exited with code ${String(code)}.`));
    helper.once("error", onError); helper.once("exit", onExit);
    const timer = setTimeout(() => { try { helper.kill(); } catch { /* best effort */ } finish(new Error(`taskkill timed out after ${timeoutMs} ms.`)); }, timeoutMs);
  });
}

function toBytes(chunk: unknown): Uint8Array { return chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk)); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
