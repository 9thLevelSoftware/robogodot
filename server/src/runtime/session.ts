import { randomBytes } from "node:crypto";
import { GodotMcpError } from "../errors.js";
import type { ManagedProcess, ProcessStartOptions, ProcessRunner, StopResult } from "./process.js";
import type { OutputPage } from "./output-ring.js";

export type RuntimeMode = "normal" | "debug";
export type RuntimeSessionState = "idle" | "starting" | "running" | "debug_ready" | "stopping" | "failed";
export interface RuntimeLifecycle { close(): void | Promise<void> }
export interface RuntimeSessionSnapshot { readonly id: string; readonly mode: RuntimeMode; readonly state: Exclude<RuntimeSessionState, "idle" | "failed">; readonly pid?: number; readonly startedAt?: number }
export interface RuntimeOutput extends OutputPage { sessionId: string; running: boolean; exit?: ManagedProcess["exit"] }
export interface RuntimeStopResult extends Omit<StopResult, "childId"> { sessionId: string }
type Runner = Pick<ProcessRunner, "start" | "stop" | "stopCurrent">;
export interface RuntimeSessionDependencies { runner: Runner; sessionId?: () => string; secret?: () => string }

interface OwnedSession { id: string; secret: string; mode: RuntimeMode; state: Exclude<RuntimeSessionState, "idle">; process: ManagedProcess | undefined; bridge: RuntimeLifecycle | undefined; dap: RuntimeLifecycle | undefined }

export class RuntimeSessionCoordinator {
  private owned: OwnedSession | undefined;
  private launchWork: Promise<RuntimeSessionSnapshot> | undefined;
  private stopWork: Promise<RuntimeStopResult> | undefined;
  private closing = false;
  private readonly sessionId: () => string;
  private readonly secret: () => string;
  readonly runner: Runner;

  constructor(dependencies: RuntimeSessionDependencies) {
    this.runner = dependencies.runner;
    this.sessionId = dependencies.sessionId ?? (() => randomBytes(16).toString("hex"));
    this.secret = dependencies.secret ?? (() => randomBytes(32).toString("hex"));
  }

  get state(): RuntimeSessionState { return this.owned?.state ?? "idle"; }

  launch(mode: RuntimeMode, options: ProcessStartOptions): Promise<RuntimeSessionSnapshot> {
    if (this.closing) return Promise.reject(runtimeError("Runtime coordinator is closing.", "Wait for shutdown to finish."));
    if (this.owned || this.launchWork) return Promise.reject(runtimeError("A runtime session is already starting or active.", "Stop the current runtime session before launching another."));
    const owned: OwnedSession = { id: this.sessionId(), secret: this.secret(), mode, state: "starting", process: undefined, bridge: undefined, dap: undefined };
    this.owned = owned;
    const work = this.performLaunch(owned, options);
    this.launchWork = work;
    void work.finally(() => { if (this.launchWork === work) this.launchWork = undefined; }).catch(() => {});
    return work;
  }

  requireSession(sessionId: string, states: readonly RuntimeSessionState[] = ["running", "debug_ready"]): RuntimeSessionSnapshot {
    const owned = this.refreshNaturalExit();
    if (!owned || owned.id !== sessionId || !states.includes(owned.state)) throw invalidSession();
    return snapshot(owned);
  }

  async output(sessionId: string, since: number, limit: number): Promise<RuntimeOutput> {
    const owned = this.refreshNaturalExit();
    if (!owned || owned.id !== sessionId || !owned.process || !["running", "debug_ready"].includes(owned.state)) throw invalidSession();
    try { return { sessionId, running: owned.process.running, ...(owned.process.exit ? { exit: owned.process.exit } : {}), ...owned.process.output(since, limit) }; }
    catch (error) { throw new GodotMcpError("invalid_args", error instanceof Error ? error.message : "Invalid output page.", "Use a non-negative safe cursor and a page limit from 1 to 500."); }
  }

  attachBridge(sessionId: string, bridge: RuntimeLifecycle): RuntimeSessionSnapshot {
    const owned = this.getOwned(sessionId, ["starting", "running", "debug_ready"]); owned.bridge = bridge; return snapshot(owned);
  }

  attachDap(sessionId: string, dap: RuntimeLifecycle): RuntimeSessionSnapshot {
    const owned = this.getOwned(sessionId, ["running", "debug_ready"]); owned.dap = dap; owned.state = "debug_ready"; return snapshot(owned);
  }

  stop(sessionId: string): Promise<RuntimeStopResult> {
    if (this.stopWork) {
      if (this.owned?.id !== sessionId) return Promise.reject(invalidSession());
      return this.stopWork;
    }
    if (!this.owned || this.owned.id !== sessionId) return Promise.reject(invalidSession());
    const work = this.performStop(this.owned);
    this.stopWork = work;
    void work.finally(() => { if (this.stopWork === work) this.stopWork = undefined; }).catch(() => {});
    return work;
  }

  async close(): Promise<void> {
    this.closing = true;
    try {
      if (this.launchWork) { try { await this.launchWork; } catch { /* launch owns failed-start cleanup */ } }
      if (this.owned) await this.stop(this.owned.id);
      else await this.runner.stopCurrent();
    } finally { this.closing = false; }
  }

  private async performLaunch(owned: OwnedSession, options: ProcessStartOptions): Promise<RuntimeSessionSnapshot> {
    try {
      owned.process = await this.runner.start({ ...options, env: { ...options.env, GODOT_RUNTIME_TOKEN: owned.secret } });
      if (this.owned !== owned || owned.state === "stopping") throw new Error("Runtime launch was cancelled during shutdown.");
      owned.state = "running";
      return snapshot(owned);
    } catch (error) {
      owned.state = "failed";
      try { await this.runner.stopCurrent(); } catch { /* preserve the launch failure */ }
      this.clear(owned);
      throw error;
    }
  }

  private async performStop(owned: OwnedSession): Promise<RuntimeStopResult> {
    owned.state = "stopping";
    let first: unknown; let result: StopResult | undefined;
    const attempt = async (action: (() => void | Promise<void>) | undefined) => { if (!action) return; try { await action(); } catch (error) { first ??= error; } };
    await attempt(owned.dap ? () => owned.dap!.close() : undefined);
    await attempt(owned.bridge ? () => owned.bridge!.close() : undefined);
    await attempt(async () => { result = owned.process ? await this.runner.stop(owned.process.childId) : await this.runner.stopCurrent(); });
    this.clear(owned);
    if (first) throw first;
    return { sessionId: owned.id, alreadyStopped: result?.alreadyStopped ?? true, graceful: result?.graceful ?? false, forced: result?.forced ?? false, ...(result?.exit ? { exit: result.exit } : {}) };
  }

  private refreshNaturalExit(): OwnedSession | undefined {
    const owned = this.owned;
    if (owned?.process && !owned.process.running && ["running", "debug_ready"].includes(owned.state)) this.clear(owned);
    return this.owned;
  }

  private getOwned(id: string, states: readonly RuntimeSessionState[]): OwnedSession {
    const owned = this.owned;
    if (!owned || owned.id !== id || !states.includes(owned.state)) throw invalidSession();
    return owned;
  }

  private clear(owned: OwnedSession): void {
    owned.secret = ""; owned.bridge = undefined; owned.dap = undefined; owned.process = undefined;
    if (this.owned === owned) this.owned = undefined;
  }
}

function snapshot(owned: OwnedSession): RuntimeSessionSnapshot {
  return Object.freeze({ id: owned.id, mode: owned.mode, state: owned.state as RuntimeSessionSnapshot["state"], ...(owned.process ? { pid: owned.process.pid, startedAt: owned.process.startedAt } : {}) });
}
function invalidSession() { return new GodotMcpError("invalid_args", "Unknown, stale, or unavailable runtime session.", "Pass the active session ID and retry only while that session is running."); }
function runtimeError(message: string, hint: string) { return new GodotMcpError("godot_error", message, hint); }
