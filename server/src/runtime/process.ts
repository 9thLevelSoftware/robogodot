import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { OutputRing, type OutputPage } from "./output-ring.js";
import { PROCESS_FORCE_STOP_MS, PROCESS_GRACEFUL_STOP_MS, PROCESS_START_TIMEOUT_MS } from "./limits.js";

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
  childId: string; child: RuntimeChild; pid: number; startedAt: number; ring: OutputRing;
  running: boolean; exit?: ProcessExit; detach: () => void; exited: Promise<void>; resolveExited: () => void;
  stopping?: Promise<StopResult>;
}

export class ProcessRunner {
  private current: Owned | undefined;
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
      if (child.pid === undefined) throw new Error("Spawned process did not provide a PID.");
      const owned = this.install(child, this.deps.childId(), child.pid, this.deps.now());
      this.current = owned;
      try { await this.waitForSpawn(owned); }
      catch (error) {
        if (owned.running) try { await this.cleanupFailedStart(owned); } catch { /* preserve startup failure */ }
        throw error;
      }
      return this.publicView(owned);
    } finally { this.starting = false; }
  }

  stop(childId: string): Promise<StopResult> {
    const owned = this.current;
    if (!owned || owned.childId !== childId || !owned.running) {
      return Promise.resolve({ childId, alreadyStopped: true, graceful: false, forced: false, ...(owned?.childId === childId && owned.exit ? { exit: owned.exit } : {}) });
    }
    owned.stopping ??= this.performStop(owned);
    return owned.stopping;
  }

  private install(child: RuntimeChild, childId: string, pid: number, startedAt: number): Owned {
    const ring = new OutputRing();
    let resolveExited!: () => void;
    const exited = new Promise<void>((resolve) => { resolveExited = resolve; });
    const owned: Owned = { childId, child, pid, startedAt, ring, running: true, detach: () => {}, exited, resolveExited };
    const onStdout = (chunk: unknown) => ring.append("stdout", toBytes(chunk), this.deps.now());
    const onStderr = (chunk: unknown) => ring.append("stderr", toBytes(chunk), this.deps.now());
    const onError = (error: Error) => {
      ring.append("stderr", Buffer.from(error.message), this.deps.now());
      if (!owned.exit) owned.exit = { code: null, signal: null, at: this.deps.now(), error: error.message };
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (!owned.running) return;
      owned.running = false; owned.exit = { code, signal, at: this.deps.now(), ...(owned.exit?.error ? { error: owned.exit.error } : {}) };
      ring.finishAll(this.deps.now());
      if (this.current === owned) this.current = undefined;
      owned.detach(); owned.resolveExited();
    };
    owned.detach = () => {
      child.off("error", onError); child.off("exit", onExit);
      child.stdout?.off("data", onStdout); child.stderr?.off("data", onStderr);
    };
    child.stdout?.on("data", onStdout); child.stderr?.on("data", onStderr);
    child.on("error", onError); child.once("exit", onExit);
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
    if (!owned.running || this.current !== owned) return { childId: owned.childId, alreadyStopped: true, graceful: false, forced: false, ...(owned.exit ? { exit: owned.exit } : {}) };
    let forced = false;
    try {
      owned.child.kill("SIGTERM");
      if (await this.waitExit(owned, PROCESS_GRACEFUL_STOP_MS)) return { childId: owned.childId, alreadyStopped: false, graceful: true, forced: false, ...(owned.exit ? { exit: owned.exit } : {}) };
      if (!owned.running || this.current !== owned) return { childId: owned.childId, alreadyStopped: false, graceful: true, forced: false, ...(owned.exit ? { exit: owned.exit } : {}) };
      forced = true;
      await this.withDeadline(this.deps.terminateTree(owned.child, PROCESS_FORCE_STOP_MS), PROCESS_FORCE_STOP_MS, "Force termination timed out after 7 seconds.");
      await this.waitExit(owned, PROCESS_FORCE_STOP_MS);
      return { childId: owned.childId, alreadyStopped: false, graceful: false, forced, ...(owned.exit ? { exit: owned.exit } : {}) };
    } finally {
      if (owned.running) {
        owned.running = false; owned.exit ??= { code: owned.child.exitCode, signal: owned.child.signalCode, at: this.deps.now() };
        owned.ring.finishAll(this.deps.now()); if (this.current === owned) this.current = undefined; owned.resolveExited();
      }
      owned.detach();
    }
  }

  private async cleanupFailedStart(owned: Owned): Promise<void> {
    try {
      owned.child.kill("SIGTERM");
      if (owned.running && this.current === owned) {
        await this.withDeadline(this.deps.terminateTree(owned.child, PROCESS_FORCE_STOP_MS), PROCESS_FORCE_STOP_MS, "Startup cleanup timed out.");
      }
    } finally {
      if (owned.running) {
        owned.running = false; owned.exit ??= { code: owned.child.exitCode, signal: owned.child.signalCode, at: this.deps.now() };
        owned.ring.finishAll(this.deps.now()); if (this.current === owned) this.current = undefined; owned.resolveExited();
      }
      owned.detach();
    }
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
      childId: owned.childId, pid: owned.pid, startedAt: owned.startedAt,
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
