import { createHash, randomBytes } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { GodotMcpError } from "../errors.js";
import type { ManagedProcess, ProcessStartOptions, ProcessRunner, StopResult } from "./process.js";
import type { OutputPage } from "./output-ring.js";
import { DapClient, type DapAttachOptions, type DapBreakpointGroup, type DapClientStatus, type DapReference } from "./dap-client.js";

export type RuntimeMode = "normal" | "debug";
export type RuntimeSessionState = "idle" | "starting" | "running" | "debug_ready" | "stopping" | "failed";
export interface RuntimeLifecycle { close(): void | Promise<void> }
export interface RuntimeBridgeAttachment extends RuntimeLifecycle { request<T>(sessionId: string, method: string, params: unknown, timeoutMs: number): Promise<T> }
export interface RuntimeSessionSnapshot { readonly id: string; readonly mode: RuntimeMode; readonly state: Exclude<RuntimeSessionState, "idle" | "failed">; readonly pid?: number; readonly startedAt?: number; readonly bridgeTransport?: "socket" | "file"; readonly capabilities?: Readonly<Record<string, boolean>> }
export interface RuntimeOutput extends OutputPage { sessionId: string; running: boolean; exit?: ManagedProcess["exit"] }
export interface RuntimeStopResult extends Omit<StopResult, "childId"> { sessionId: string }
type Runner = Pick<ProcessRunner, "start" | "stop" | "stopCurrent">;
export interface RuntimeSessionDependencies { runner: Runner; sessionId?: () => string; secret?: () => string; monitorMs?: number; screenshotOpen?: typeof open; screenshotLstat?: typeof lstat; projectPath?: string; dapFactory?: () => DapAttachment }
export interface DapAttachment extends RuntimeLifecycle { readonly status: DapClientStatus; attach(options: DapAttachOptions): Promise<unknown>; setBreakpoints(source: { path: string; name?: string; checksums?: readonly unknown[] }, breakpoints: readonly { line: number }[]): Promise<unknown>; continue(thread: DapReference): Promise<unknown>; step(kind: "over" | "into", thread: DapReference): Promise<unknown>; stack(thread?: DapReference, startFrame?: number): Promise<unknown>; inspect(frame: DapReference, variables?: DapReference, start?: number): Promise<unknown> }
export interface RuntimeDebugAttach { host: string; port: number; timeoutMs: number; bridge?: { transport: "socket" | "file" }; initialBreakpoints?: readonly { path: string; lines: readonly number[] }[] }
export interface RuntimePreparedLaunch extends RuntimeLifecycle { process: ProcessStartOptions; connect(): Promise<{ attachment: RuntimeBridgeAttachment; root: string; transport: "socket" | "file" }> }

interface OwnedSession { id: string; secret: string; mode: RuntimeMode; state: Exclude<RuntimeSessionState, "idle">; process: ManagedProcess | undefined; bridge: RuntimeBridgeAttachment | undefined; prepared: RuntimeLifecycle | undefined; lateCleanupPending: boolean; bridgeRoot: string | undefined; bridgeTransport: "socket" | "file" | undefined; dap: DapAttachment | undefined }

export class RuntimeSessionCoordinator {
  private owned: OwnedSession | undefined;
  private launchWork: Promise<RuntimeSessionSnapshot> | undefined;
  private stopWork: Promise<RuntimeStopResult> | undefined;
  private stoppingId: string | undefined;
  private lastStopped: RuntimeStopResult | undefined;
  private monitor: ReturnType<typeof setInterval> | undefined;
  private readonly monitorMs: number;
  private closing = false;
  private readonly sessionId: () => string;
  private readonly secret: () => string;
  private readonly screenshotOpen: typeof open;
  private readonly screenshotLstat: typeof lstat;
  private readonly dapFactory: () => DapAttachment;
  private readonly projectPath: string | undefined;
  readonly runner: Runner;

  constructor(dependencies: RuntimeSessionDependencies) {
    this.runner = dependencies.runner;
    this.sessionId = dependencies.sessionId ?? (() => randomBytes(16).toString("hex"));
    this.secret = dependencies.secret ?? (() => randomBytes(32).toString("hex"));
    this.monitorMs = dependencies.monitorMs ?? 25;
    this.screenshotOpen = dependencies.screenshotOpen ?? open;
    this.screenshotLstat = dependencies.screenshotLstat ?? lstat;
    this.projectPath = dependencies.projectPath;
    this.dapFactory = dependencies.dapFactory ?? (() => new DapClient(this.projectPath ? { projectRoot: this.projectPath } : {}));
  }

  get state(): RuntimeSessionState { return this.owned?.state ?? "idle"; }

  async debugLaunch(options: ProcessStartOptions, attach: RuntimeDebugAttach): Promise<RuntimeSessionSnapshot> {
    const deadline = Date.now() + Math.max(1, Math.min(60_000, attach.timeoutMs));
    const session = await this.launch("debug", options, deadline);
    const owned = this.getOwned(session.id, ["running"]); const dap = this.dapFactory(); owned.dap = dap;
    try {
      const remaining = deadline - Date.now(); if (remaining <= 0) throw new GodotMcpError("timeout", "Debug launch deadline expired before DAP attachment.", "Increase timeoutMs or verify that the managed Godot process starts promptly.");
      const initialBreakpoints = await this.prepareInitialBreakpoints(attach.initialBreakpoints);
      await beforeDeadline(Promise.resolve(dap.attach({ host: attach.host, port: attach.port, runtimeSessionId: owned.id, process: { pid: owned.process!.pid, startedAt: owned.process!.startedAt }, ...(attach.bridge ? { bridge: attach.bridge } : {}), ...(initialBreakpoints ? { initialBreakpoints } : {}), timeoutMs: remaining })), deadline, () => dap.close());
      owned.state = "debug_ready"; return snapshot(owned);
    } catch (error) { try { await this.stop(owned.id); } catch (cleanupError) { throw new AggregateError([error, cleanupError], error instanceof Error ? error.message : "Debug launch failed."); } throw error; }
  }

  integratedLaunch(mode: RuntimeMode, prepare: (sessionId: string, token: string) => Promise<RuntimePreparedLaunch>, debugAttach?: RuntimeDebugAttach): Promise<RuntimeSessionSnapshot> {
    if (this.closing) return Promise.reject(runtimeError("Runtime coordinator is closing.", "Wait for shutdown to finish."));
    if (this.owned || this.launchWork) return Promise.reject(runtimeError("A runtime session is already starting or active.", "Stop the current runtime session before launching another."));
    this.lastStopped = undefined;
    const owned: OwnedSession = { id: this.sessionId(), secret: this.secret(), mode, state: "starting", process: undefined, bridge: undefined, prepared: undefined, lateCleanupPending: false, bridgeRoot: undefined, bridgeTransport: undefined, dap: undefined };
    this.owned = owned;
    const work = this.performIntegratedLaunch(owned, prepare, debugAttach); this.launchWork = work;
    void work.finally(() => { if (this.launchWork === work) this.launchWork = undefined; }).catch(() => {});
    return work;
  }

  async debugSetBreakpoints(sessionId: string, path: string, lines: number[]): Promise<unknown> {
    const owned = this.getDebug(sessionId); const absolute = await this.containedSource(path);
    const raw = await owned.dap!.setBreakpoints({ path: absolute, name: basename(absolute), checksums: [] }, lines.map(line => ({ line })));
    const breakpoints = optionalOwn(raw, "breakpoints");
    const list = breakpoints === undefined ? [] : ownArray({ breakpoints }, "breakpoints");
    if (list.length > 500) throw invalidBridge();
    return Object.freeze({ sessionId, path: path.split(sep).join("/"), breakpoints: Object.freeze(list.map(normalizeBreakpoint)) });
  }

  async debugContinue(sessionId: string, thread: DapReference): Promise<unknown> { const owned = this.getDebug(sessionId); await owned.dap!.continue(thread); return Object.freeze({ sessionId, resumed: true as const }); }
  async debugStep(sessionId: string, thread: DapReference, kind: "over" | "into"): Promise<unknown> { const owned = this.getDebug(sessionId); await owned.dap!.step(kind, thread); return Object.freeze({ sessionId, kind, resumed: true as const }); }
  async debugStack(sessionId: string, thread?: DapReference, startFrame = 0): Promise<unknown> { const owned = this.getDebug(sessionId); const value = cloneJson(await owned.dap!.stack(thread, startFrame)) as Record<string, unknown>; return Object.freeze({ sessionId, stoppedGeneration: owned.dap!.status.stoppedGeneration, ...value }); }
  async debugInspect(sessionId: string, frame: DapReference, variables?: DapReference, start = 0): Promise<unknown> { const owned = this.getDebug(sessionId); const value = cloneJson(await owned.dap!.inspect(frame, variables, start)) as Record<string, unknown>; return Object.freeze({ sessionId, stoppedGeneration: owned.dap!.status.stoppedGeneration, ...value }); }

  launch(mode: RuntimeMode, options: ProcessStartOptions, deadline?: number): Promise<RuntimeSessionSnapshot> {
    if (this.closing) return Promise.reject(runtimeError("Runtime coordinator is closing.", "Wait for shutdown to finish."));
    if (this.owned || this.launchWork) return Promise.reject(runtimeError("A runtime session is already starting or active.", "Stop the current runtime session before launching another."));
    this.lastStopped = undefined;
    const owned: OwnedSession = { id: this.sessionId(), secret: this.secret(), mode, state: "starting", process: undefined, bridge: undefined, prepared: undefined, lateCleanupPending: false, bridgeRoot: undefined, bridgeTransport: undefined, dap: undefined };
    this.owned = owned;
    const work = this.performLaunch(owned, options, deadline);
    this.launchWork = work;
    void work.finally(() => { if (this.launchWork === work) this.launchWork = undefined; }).catch(() => {});
    return work;
  }

  requireSession(sessionId: string, states: readonly RuntimeSessionState[] = ["running", "debug_ready"]): RuntimeSessionSnapshot {
    const owned = this.owned;
    if (!owned || owned.id !== sessionId || !states.includes(owned.state)) throw invalidSession();
    return snapshot(owned);
  }

  async output(sessionId: string, since: number, limit: number): Promise<RuntimeOutput> {
    const owned = this.owned;
    if (!owned || owned.id !== sessionId || !owned.process || !["running", "debug_ready", "failed"].includes(owned.state)) throw invalidSession();
    if (owned.state === "failed" && owned.process.running) throw invalidSession();
    try { return { sessionId, running: owned.process.running, ...(owned.process.exit ? { exit: owned.process.exit } : {}), ...owned.process.output(since, limit) }; }
    catch (error) { throw new GodotMcpError("invalid_args", error instanceof Error ? error.message : "Invalid output page.", "Use a non-negative safe cursor and a page limit from 1 to 500."); }
  }

  attachBridge(sessionId: string, bridge: RuntimeBridgeAttachment, sessionRoot?: string): RuntimeSessionSnapshot {
    const owned = this.getOwned(sessionId, ["starting", "running", "debug_ready"]);
    if (owned.bridge) throw runtimeError("A runtime bridge is already attached to this session.", "Stop the active runtime session before attaching a different bridge.");
    owned.bridge = bridge; owned.bridgeRoot = sessionRoot; return snapshot(owned);
  }

  async sceneTree(sessionId: string, maxDepth: number): Promise<unknown> {
    const raw = await this.bridgeRequest(sessionId, "runtime.scene_tree", { maxDepth }); const nodes = ownArray(raw, "nodes");
    if (nodes.length > 1000) throw invalidBridge();
    const normalized = nodes.map(item => Object.freeze({ path: ownString(item, "path", 1024), name: ownString(item, "name", 256), type: ownString(item, "type", 256), depth: ownInteger(item, "depth", 0, 32) }));
    const nodeTruncated = ownBoolean(raw, "truncated");
    // Task 4 exposes no child-count proof at the cutoff, so reaching maxDepth is
    // conservatively declared as depth truncation rather than claiming completeness.
    return Object.freeze({ sessionId, nodes: Object.freeze(normalized), truncated: Object.freeze({ nodes: nodeTruncated, depth: normalized.some(node => node.depth >= maxDepth) }) });
  }

  async getNode(sessionId: string, path: string, properties: string[]): Promise<unknown> {
    const raw = await this.bridgeRequest(sessionId, "runtime.get_node", { path, properties }); const resultPath = ownString(raw, "path", 1024); const type = ownString(raw, "type", 256); const rawProperties = ownRecord(raw, "properties");
    const output: Record<string, unknown> = Object.create(null); const omitted: string[] = [];
    for (const property of properties) { let descriptor: PropertyDescriptor | undefined; try { descriptor = Object.getOwnPropertyDescriptor(rawProperties, property); } catch { throw invalidBridge(); } if (!descriptor || !("value" in descriptor)) { omitted.push(property); continue; } try { output[property] = cloneJson(descriptor.value); } catch { omitted.push(property); } }
    return Object.freeze({ sessionId, path: resultPath, type, properties: Object.freeze(output), omittedProperties: Object.freeze(omitted) });
  }

  async input(sessionId: string, input: unknown): Promise<unknown> {
    const raw = await this.bridgeRequest(sessionId, "runtime.input", input); if (ownBoolean(raw, "ok") !== true) throw invalidBridge();
    return Object.freeze({ sessionId, accepted: true as const });
  }

  async screenshot(sessionId: string, name?: string): Promise<unknown> {
    const owned = this.getBridge(sessionId); if (!owned.bridgeRoot) throw new GodotMcpError("not_connected", "The runtime screenshot root is unavailable.", "Launch a new runtime session with a fully attached bridge.");
    const raw = await this.bridgeRequest(sessionId, "runtime.screenshot", name === undefined ? {} : { name });
    const path = ownString(raw, "path", 4096); if (ownString(raw, "format", 16) !== "png") throw screenshotError();
    const claimedWidth = ownInteger(raw, "width", 1, 0x7fffffff); const claimedHeight = ownInteger(raw, "height", 1, 0x7fffffff); const claimedBytes = ownInteger(raw, "bytes", 1, 16 * 1024 * 1024);
    try {
    const rootInput = resolve(owned.bridgeRoot); const rootStat = await this.screenshotLstat(rootInput); if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw screenshotError();
    const rawCandidate = isAbsolute(path) ? resolve(path) : resolve(rootInput, path); const rawStat = await this.screenshotLstat(rawCandidate);
    if (!rawStat.isFile() || rawStat.isSymbolicLink() || rawStat.nlink !== 1) throw screenshotError();
    const root = await realpath(rootInput); const absolutePath = await realpath(rawCandidate); const contained = relative(root, absolutePath);
    if (!contained || contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)) throw screenshotError();
    const before = await this.screenshotLstat(absolutePath); if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 24 || before.size > 16 * 1024 * 1024 || before.size !== claimedBytes) throw screenshotError();
    const handle = await this.screenshotOpen(absolutePath, "r"); let bytes: Buffer;
    try { const opened = await handle.stat(); if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || opened.size !== before.size) throw screenshotError(); bytes = Buffer.alloc(opened.size); const read = await handle.read(bytes, 0, bytes.length, 0); const after = await handle.stat(); if (read.bytesRead !== bytes.length || after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw screenshotError(); } finally { await handle.close(); }
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString("ascii", 12, 16) !== "IHDR") throw screenshotError();
    const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20); if (width !== claimedWidth || height !== claimedHeight || width === 0 || height === 0) throw screenshotError();
    return Object.freeze({ sessionId, path: contained.split(sep).join("/"), absolutePath, width, height, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), format: "png" as const });
    } catch (error) { if (error instanceof GodotMcpError) throw error; throw screenshotError(); }
  }

  attachDap(sessionId: string, dap: RuntimeLifecycle): RuntimeSessionSnapshot {
    const owned = this.getOwned(sessionId, ["starting", "running", "debug_ready"]); owned.dap = dap as DapAttachment; if (owned.state !== "starting") owned.state = "debug_ready"; return snapshot(owned);
  }

  stop(sessionId: string): Promise<RuntimeStopResult> {
    if (this.stopWork) {
      if (this.stoppingId !== sessionId) return Promise.reject(invalidSession());
      return this.stopWork;
    }
    if (!this.owned && this.lastStopped?.sessionId === sessionId) return Promise.resolve(this.lastStopped);
    if (!this.owned || this.owned.id !== sessionId) return Promise.reject(invalidSession());
    return this.beginStop(this.owned);
  }

  async close(): Promise<void> {
    this.closing = true;
    try {
      if (this.launchWork) { try { await this.launchWork; } catch { /* launch owns failed-start cleanup */ } }
      if (this.owned) await this.stop(this.owned.id);
      else await this.runner.stopCurrent();
    } finally { if (!this.owned) this.stopMonitor(); this.closing = false; }
  }

  private async performLaunch(owned: OwnedSession, options: ProcessStartOptions, deadline?: number): Promise<RuntimeSessionSnapshot> {
    try {
      const starting = Promise.resolve(this.runner.start({ ...options, env: { ...options.env, GODOT_RUNTIME_TOKEN: owned.secret } }));
      owned.process = deadline === undefined ? await starting : await beforeDeadline(starting, deadline, async process => { await this.runner.stop(process.childId); });
      if (this.owned !== owned || owned.state === "stopping") throw new Error("Runtime launch was cancelled during shutdown.");
      owned.state = owned.mode === "debug" && owned.dap ? "debug_ready" : "running";
      this.startMonitor(owned);
      return snapshot(owned);
    } catch (error) {
      owned.state = "failed";
      const failures: unknown[] = [error]; let processConfirmed = true;
      if (await cleanup(owned.dap, failures)) owned.dap = undefined;
      if (await cleanup(owned.bridge, failures)) { owned.bridge = undefined; owned.bridgeRoot = undefined; owned.bridgeTransport = undefined; }
      if (await cleanup(owned.prepared, failures)) owned.prepared = undefined;
      try { await this.runner.stopCurrent(); } catch (cleanupError) { failures.push(cleanupError); processConfirmed = false; }
      owned.secret = "";
      if (processConfirmed && !owned.dap && !owned.bridge && !owned.prepared && !owned.lateCleanupPending) this.clear(owned);
      if (failures.length > 1) throw new AggregateError(failures, error instanceof Error ? error.message : "Runtime launch failed.");
      throw error;
    }
  }

  private async performIntegratedLaunch(owned: OwnedSession, prepare: (sessionId: string, token: string) => Promise<RuntimePreparedLaunch>, debugAttach?: RuntimeDebugAttach): Promise<RuntimeSessionSnapshot> {
    const deadline = debugAttach ? Date.now() + Math.max(1, Math.min(60_000, debugAttach.timeoutMs)) : undefined;
    let prepared: RuntimePreparedLaunch | undefined;
    try {
      const preparing = Promise.resolve(prepare(owned.id, owned.secret)); owned.lateCleanupPending = deadline !== undefined;
      if (deadline !== undefined) void preparing.catch(() => { owned.lateCleanupPending = false; if (owned.state === "failed" && !owned.process && !owned.bridge && !owned.dap && !owned.prepared) this.clear(owned); });
      prepared = deadline === undefined ? await preparing : await beforeDeadline(preparing, deadline, async value => {
        owned.prepared = value; owned.lateCleanupPending = false; if (this.owned !== owned) this.owned = owned; owned.state = "failed";
        try { await value.close(); owned.prepared = undefined; if (!owned.process?.running && !owned.bridge && !owned.dap) this.clear(owned); } catch { /* retained for exact-session retry */ }
      });
      owned.lateCleanupPending = false;
      owned.prepared = prepared;
      await this.performLaunch(owned, prepared.process, deadline);
      const connecting = Promise.resolve(prepared.connect());
      const connected = deadline === undefined ? await connecting : await beforeDeadline(connecting, deadline, value => value.attachment.close());
      if (this.owned !== owned || owned.state !== "running" || !owned.process?.running) {
        owned.bridge = connected.attachment; owned.bridgeRoot = connected.root; owned.bridgeTransport = connected.transport;
        throw new Error("Runtime launch ended before bridge connection completed.");
      }
      owned.bridge = connected.attachment; owned.bridgeRoot = connected.root; owned.bridgeTransport = connected.transport;
      if (debugAttach) {
        while (true) {
          const dap = this.dapFactory(); owned.dap = dap; const remaining = deadline! - Date.now();
          if (remaining <= 0) throw new GodotMcpError("timeout", "Debug launch deadline expired before DAP attachment.", "Increase timeoutMs or verify Godot runtime and bridge startup.");
          try {
            const initialBreakpoints = await this.prepareInitialBreakpoints(debugAttach.initialBreakpoints);
            await beforeDeadline(Promise.resolve(dap.attach({ host: debugAttach.host, port: debugAttach.port, runtimeSessionId: owned.id, process: { pid: owned.process!.pid, startedAt: owned.process!.startedAt }, bridge: { transport: connected.transport }, ...(initialBreakpoints ? { initialBreakpoints } : {}), timeoutMs: remaining })), deadline!, () => dap.close());
            if (this.owned !== owned || owned.state !== "running" || !owned.process?.running) { await Promise.resolve(dap.close()).catch(() => undefined); throw new Error("Runtime launch ended before DAP attachment completed."); }
            break;
          } catch (error) {
            try { await Promise.resolve(dap.close()); if (owned.dap === dap) owned.dap = undefined; } catch (closeError) { throw new AggregateError([error, closeError], error instanceof Error ? error.message : "DAP attachment failed."); }
            if (!/not_running|isn't one/i.test(error instanceof Error ? error.message : "") || deadline! - Date.now() <= 50) throw error;
            await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline! - Date.now()))));
          }
        }
        owned.state = "debug_ready";
      }
      return snapshot(owned);
    } catch (error) {
      if (owned.lateCleanupPending) { owned.state = "failed"; throw error; }
      if (this.owned === owned && owned.state !== "failed") { try { await this.stop(owned.id); } catch (cleanupError) { throw new AggregateError([error, cleanupError], error instanceof Error ? error.message : "Runtime launch failed."); } }
      throw error;
    }
  }

  private beginStop(owned: OwnedSession): Promise<RuntimeStopResult> {
    this.stopMonitor(); this.stoppingId = owned.id;
    const work = this.performStop(owned); this.stopWork = work;
    void work.finally(() => { if (this.stopWork === work) { this.stopWork = undefined; this.stoppingId = undefined; } }).catch(() => {});
    return work;
  }

  private async performStop(owned: OwnedSession): Promise<RuntimeStopResult> {
    owned.state = "stopping";
    let first: unknown; let result: StopResult | undefined;
    const attempt = async (action: (() => void | Promise<void>) | undefined) => { if (!action) return true; try { await action(); return true; } catch (error) { first ??= error; return false; } };
    if (await attempt(owned.dap ? () => owned.dap!.close() : undefined)) owned.dap = undefined;
    if (await attempt(owned.bridge ? () => owned.bridge!.close() : undefined)) { owned.bridge = undefined; owned.bridgeRoot = undefined; owned.bridgeTransport = undefined; }
    if (await attempt(owned.prepared ? () => owned.prepared!.close() : undefined)) owned.prepared = undefined;
    if (owned.lateCleanupPending) first ??= runtimeError("Runtime preparation cleanup is still pending.", "Retry stop after the bounded preparation resolves.");
    let processConfirmed = true;
    await attempt(async () => { try { result = owned.process ? await this.runner.stop(owned.process.childId) : await this.runner.stopCurrent(); } catch (error) { processConfirmed = false; throw error; } });
    const terminalExit = result?.exit ?? owned.process?.exit;
    const terminal: RuntimeStopResult = Object.freeze({ sessionId: owned.id, alreadyStopped: result?.alreadyStopped ?? true, graceful: result?.graceful ?? false, forced: result?.forced ?? false, ...(terminalExit ? { exit: terminalExit } : {}) });
    processConfirmed ||= owned.process?.running === false;
    if (processConfirmed && !owned.dap && !owned.bridge && !owned.prepared && !owned.lateCleanupPending) { owned.secret = ""; this.lastStopped = terminal; this.clear(owned); }
    else { owned.state = "failed"; if (owned.process?.running) this.startMonitor(owned); }
    if (first) throw first;
    return terminal;
  }

  private startMonitor(owned: OwnedSession): void {
    this.stopMonitor();
    this.monitor = setInterval(() => {
      if (this.owned === owned && owned.process && !owned.process.running && !this.stopWork) { owned.state = "failed"; this.stopMonitor(); }
    }, this.monitorMs);
    this.monitor.unref?.();
  }

  private stopMonitor(): void { if (this.monitor) clearInterval(this.monitor); this.monitor = undefined; }

  private getOwned(id: string, states: readonly RuntimeSessionState[]): OwnedSession {
    const owned = this.owned;
    if (!owned || owned.id !== id || !states.includes(owned.state)) throw invalidSession();
    return owned;
  }

  private getDebug(id: string): OwnedSession { const owned = this.getOwned(id, ["debug_ready"]); if (!owned.process?.running) throw invalidSession(); if (!owned.dap || owned.dap.status.state === "degraded" || owned.dap.status.state === "exited" || owned.dap.status.state === "disconnected") throw new GodotMcpError("not_connected", "Godot debug adapter session is unavailable.", "Stop this runtime and launch a new managed debug session.", owned.dap?.status.degradation); return owned; }
  private async prepareInitialBreakpoints(groups: RuntimeDebugAttach["initialBreakpoints"]): Promise<DapBreakpointGroup[] | undefined> { if (!groups) return undefined; return Promise.all(groups.map(async group => { const path = await this.containedSource(group.path); return { source: { path, name: basename(path), checksums: [] }, breakpoints: group.lines.map(line => ({ line })) }; })); }
  private async containedSource(path: string): Promise<string> {
    if (!this.projectPath || isAbsolute(path) || path.includes("\\") || path.split("/").some(part => part === "" || part === "." || part === "..")) throw new GodotMcpError("invalid_args", "Debug source path is outside the configured project.", "Pass a contained project-relative .gd path.");
    try { const root = await realpath(this.projectPath); const candidate = await realpath(resolve(root, ...path.split("/"))); const contained = relative(root, candidate); const stat = await lstat(candidate); if (!contained || contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained) || !stat.isFile() || stat.isSymbolicLink() || !candidate.endsWith(".gd")) throw new Error("denied"); return candidate; }
    catch { throw new GodotMcpError("invalid_args", "Debug source path is outside the configured project or is not a canonical GDScript file.", "Pass an existing contained project-relative .gd path."); }
  }

  private clear(owned: OwnedSession): void {
    this.stopMonitor();
    owned.secret = ""; owned.bridge = undefined; owned.prepared = undefined; owned.lateCleanupPending = false; owned.bridgeRoot = undefined; owned.bridgeTransport = undefined; owned.dap = undefined; owned.process = undefined;
    if (this.owned === owned) this.owned = undefined;
  }

  private getBridge(id: string): OwnedSession { const owned = this.getOwned(id, ["running", "debug_ready"]); if (!owned.process?.running) throw invalidSession(); if (!owned.bridge) throw new GodotMcpError("not_connected", "The runtime bridge is unavailable.", "Launch a new runtime session and wait for bridge attachment."); return owned; }
  private async bridgeRequest(id: string, method: string, params: unknown): Promise<unknown> { const owned = this.getBridge(id); try { const result = await owned.bridge!.request<unknown>(id, method, params, 5000); const error = optionalOwn(result, "error"); if (typeof error === "string") throw new GodotMcpError("godot_error", "The runtime bridge operation failed.", "Check the running scene and retry with valid runtime values."); return result; } catch (error) { if (error instanceof GodotMcpError) throw error; const message = error instanceof Error ? error.message : ""; if (/deadline|timeout/i.test(message)) throw new GodotMcpError("timeout", "The runtime bridge request failed.", "Launch a new runtime session if the bridge is no longer connected."); if (/closed|not connected|socket|transport|publication failed/i.test(message)) throw new GodotMcpError("not_connected", "The runtime bridge request failed.", "Launch a new runtime session if the bridge is no longer connected."); throw invalidBridge(); } }
}

function snapshot(owned: OwnedSession): RuntimeSessionSnapshot {
  const raw = owned.dap?.status?.capabilities;
  const capabilities = raw ? Object.freeze({ supportsConfigurationDoneRequest: raw.supportsConfigurationDoneRequest === true, supportsTerminateRequest: raw.supportsTerminateRequest === true, supportsVariablePaging: raw.supportsVariablePaging === true }) : undefined;
  return Object.freeze({ id: owned.id, mode: owned.mode, state: owned.state as RuntimeSessionSnapshot["state"], ...(owned.process ? { pid: owned.process.pid, startedAt: owned.process.startedAt } : {}), ...(owned.bridgeTransport ? { bridgeTransport: owned.bridgeTransport } : {}), ...(capabilities ? { capabilities } : {}) });
}
function invalidSession() { return new GodotMcpError("invalid_args", "Unknown, stale, or unavailable runtime session.", "Pass the active session ID and retry only while that session is running."); }
function runtimeError(message: string, hint: string) { return new GodotMcpError("godot_error", message, hint); }
async function cleanup(value: RuntimeLifecycle | undefined, failures: unknown[]): Promise<boolean> { if (!value) return true; try { await value.close(); return true; } catch (error) { failures.push(error); return false; } }
function optionalOwn(value: unknown, key: string): unknown { if (!value || typeof value !== "object") return undefined; let descriptor: PropertyDescriptor | undefined; try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { throw invalidBridge(); } if (!descriptor) return undefined; if (!("value" in descriptor)) throw invalidBridge(); return descriptor.value; }
function normalizeBreakpoint(value: unknown): Readonly<Record<string, unknown>> {
  const verified = optionalOwn(value, "verified"); if (typeof verified !== "boolean") throw invalidBridge();
  const output: Record<string, unknown> = { verified };
  for (const key of ["id", "line", "column", "endLine", "endColumn"] as const) { const item = optionalOwn(value, key); if (item !== undefined) { if (!Number.isSafeInteger(item) || (item as number) < (key === "id" ? 0 : 1) || (item as number) > 0x7fffffff) throw invalidBridge(); output[key] = item; } }
  const offset = optionalOwn(value, "offset"); if (offset !== undefined) { if (!Number.isSafeInteger(offset)) throw invalidBridge(); output.offset = offset; }
  for (const key of ["message", "instructionReference"] as const) { const item = optionalOwn(value, key); if (item !== undefined) { if (typeof item !== "string" || Buffer.byteLength(item, "utf8") > 8192) throw invalidBridge(); output[key] = item; } }
  return Object.freeze(output);
}
function ownValue(value: unknown, key: string): unknown { const result = optionalOwn(value, key); if (result === undefined) throw invalidBridge(); return result; }
function ownString(value: unknown, key: string, maximum: number): string { const result = ownValue(value, key); if (typeof result !== "string" || Buffer.byteLength(result, "utf8") > maximum) throw invalidBridge(); return result; }
function ownBoolean(value: unknown, key: string): boolean { const result = ownValue(value, key); if (typeof result !== "boolean") throw invalidBridge(); return result; }
function ownInteger(value: unknown, key: string, minimum: number, maximum: number): number { const result = ownValue(value, key); if (!Number.isSafeInteger(result) || (result as number) < minimum || (result as number) > maximum) throw invalidBridge(); return result as number; }
function ownArray(value: unknown, key: string): unknown[] { const result = ownValue(value, key); let descriptors: Record<string, PropertyDescriptor>; try { if (!Array.isArray(result)) throw invalidBridge(); descriptors = Object.getOwnPropertyDescriptors(result) as Record<string, PropertyDescriptor>; } catch { throw invalidBridge(); } const length = descriptors.length; if (!length || !("value" in length) || !Number.isInteger(length.value) || length.value < 0 || length.value > 1000) throw invalidBridge(); const output: unknown[] = []; for (let index = 0; index < length.value; index++) { const descriptor = descriptors[String(index)]; if (!descriptor || !("value" in descriptor)) throw invalidBridge(); output.push(descriptor.value); } return output; }
function ownRecord(value: unknown, key: string): object { const result = ownValue(value, key); if (!result || typeof result !== "object" || Array.isArray(result)) throw invalidBridge(); return result; }
function cloneJson(value: unknown, seen = new Set<object>(), depth = 0): unknown { if (depth > 16) throw invalidBridge(); if (value === null || typeof value === "boolean" || typeof value === "string") return value; if (typeof value === "number" && Number.isFinite(value)) return value; if (!value || typeof value !== "object" || seen.has(value)) throw invalidBridge(); seen.add(value); try { let array: boolean; try { array = Array.isArray(value); } catch { throw invalidBridge(); } if (array) return Object.freeze(ownArray({ value }, "value").map(item => cloneJson(item, seen, depth + 1))); let descriptors: PropertyDescriptorMap; try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { throw invalidBridge(); } const output: Record<string, unknown> = Object.create(null); for (const [key, descriptor] of Object.entries(descriptors)) if (descriptor.enumerable) { if (!("value" in descriptor)) throw invalidBridge(); output[key] = cloneJson(descriptor.value, seen, depth + 1); } return Object.freeze(output); } finally { seen.delete(value); } }
function invalidBridge() { return new GodotMcpError("godot_error", "Runtime bridge returned an invalid response.", "Launch a new runtime session with compatible bridge resources."); }
function screenshotError() { return new GodotMcpError("godot_error", "Runtime screenshot verification failed.", "Capture again in a healthy session and ensure the session artifact directory is unchanged."); }
function deadlineError() { return new GodotMcpError("timeout", "Debug launch deadline expired before launch completed.", "Increase timeoutMs or verify Godot runtime, bridge, and DAP startup."); }
async function beforeDeadline<T>(work: Promise<T>, deadline: number, cleanupLate: (value: T) => void | Promise<void>): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) { void work.then(value => cleanupLate(value), () => undefined).catch(() => undefined); throw deadlineError(); }
  let timeout: ReturnType<typeof setTimeout> | undefined; let timedOut = false;
  const expiry = new Promise<never>((_, reject) => { timeout = setTimeout(() => { timedOut = true; reject(deadlineError()); }, remaining); });
  try { return await Promise.race([work, expiry]); }
  catch (error) { if (timedOut) void work.then(value => cleanupLate(value), () => undefined).catch(() => undefined); throw error; }
  finally { if (timeout) clearTimeout(timeout); }
}
