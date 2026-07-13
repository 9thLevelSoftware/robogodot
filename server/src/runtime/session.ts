import { createHash, randomBytes } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { GodotMcpError } from "../errors.js";
import type { ManagedProcess, ProcessStartOptions, ProcessRunner, StopResult } from "./process.js";
import type { OutputPage } from "./output-ring.js";

export type RuntimeMode = "normal" | "debug";
export type RuntimeSessionState = "idle" | "starting" | "running" | "debug_ready" | "stopping" | "failed";
export interface RuntimeLifecycle { close(): void | Promise<void> }
export interface RuntimeBridgeAttachment extends RuntimeLifecycle { request<T>(sessionId: string, method: string, params: unknown, timeoutMs: number): Promise<T> }
export interface RuntimeSessionSnapshot { readonly id: string; readonly mode: RuntimeMode; readonly state: Exclude<RuntimeSessionState, "idle" | "failed">; readonly pid?: number; readonly startedAt?: number; readonly bridgeTransport?: "socket" | "file" }
export interface RuntimeOutput extends OutputPage { sessionId: string; running: boolean; exit?: ManagedProcess["exit"] }
export interface RuntimeStopResult extends Omit<StopResult, "childId"> { sessionId: string }
type Runner = Pick<ProcessRunner, "start" | "stop" | "stopCurrent">;
export interface RuntimeSessionDependencies { runner: Runner; sessionId?: () => string; secret?: () => string; monitorMs?: number; screenshotOpen?: typeof open }

interface OwnedSession { id: string; secret: string; mode: RuntimeMode; state: Exclude<RuntimeSessionState, "idle">; process: ManagedProcess | undefined; bridge: RuntimeBridgeAttachment | undefined; bridgeRoot: string | undefined; dap: RuntimeLifecycle | undefined }

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
  readonly runner: Runner;

  constructor(dependencies: RuntimeSessionDependencies) {
    this.runner = dependencies.runner;
    this.sessionId = dependencies.sessionId ?? (() => randomBytes(16).toString("hex"));
    this.secret = dependencies.secret ?? (() => randomBytes(32).toString("hex"));
    this.monitorMs = dependencies.monitorMs ?? 25;
    this.screenshotOpen = dependencies.screenshotOpen ?? open;
  }

  get state(): RuntimeSessionState { return this.owned?.state ?? "idle"; }

  launch(mode: RuntimeMode, options: ProcessStartOptions): Promise<RuntimeSessionSnapshot> {
    if (this.closing) return Promise.reject(runtimeError("Runtime coordinator is closing.", "Wait for shutdown to finish."));
    if (this.owned || this.launchWork) return Promise.reject(runtimeError("A runtime session is already starting or active.", "Stop the current runtime session before launching another."));
    this.lastStopped = undefined;
    const owned: OwnedSession = { id: this.sessionId(), secret: this.secret(), mode, state: "starting", process: undefined, bridge: undefined, bridgeRoot: undefined, dap: undefined };
    this.owned = owned;
    const work = this.performLaunch(owned, options);
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
    if (!owned || owned.id !== sessionId || !owned.process || !["running", "debug_ready"].includes(owned.state)) throw invalidSession();
    if (!owned.process.running) { if (!this.stopWork) void this.beginStop(owned).catch(() => {}); throw invalidSession(); }
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
    const rootInput = resolve(owned.bridgeRoot); const rootStat = await lstat(rootInput); if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw screenshotError();
    const root = await realpath(rootInput); const absolutePath = await realpath(resolve(path)); const contained = relative(root, absolutePath);
    if (!contained || contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)) throw screenshotError();
    const before = await lstat(absolutePath); if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 24 || before.size > 16 * 1024 * 1024 || before.size !== claimedBytes) throw screenshotError();
    const handle = await this.screenshotOpen(absolutePath, "r"); let bytes: Buffer;
    try { const opened = await handle.stat(); if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw screenshotError(); bytes = Buffer.alloc(opened.size); const read = await handle.read(bytes, 0, bytes.length, 0); const after = await handle.stat(); if (read.bytesRead !== bytes.length || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw screenshotError(); } finally { await handle.close(); }
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString("ascii", 12, 16) !== "IHDR") throw screenshotError();
    const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20); if (width !== claimedWidth || height !== claimedHeight || width === 0 || height === 0) throw screenshotError();
    return Object.freeze({ sessionId, path: contained.split(sep).join("/"), absolutePath, width, height, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), format: "png" as const });
    } catch (error) { if (error instanceof GodotMcpError) throw error; throw screenshotError(); }
  }

  attachDap(sessionId: string, dap: RuntimeLifecycle): RuntimeSessionSnapshot {
    const owned = this.getOwned(sessionId, ["starting", "running", "debug_ready"]); owned.dap = dap; if (owned.state !== "starting") owned.state = "debug_ready"; return snapshot(owned);
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

  private async performLaunch(owned: OwnedSession, options: ProcessStartOptions): Promise<RuntimeSessionSnapshot> {
    try {
      owned.process = await this.runner.start({ ...options, env: { ...options.env, GODOT_RUNTIME_TOKEN: owned.secret } });
      if (this.owned !== owned || owned.state === "stopping") throw new Error("Runtime launch was cancelled during shutdown.");
      owned.state = owned.mode === "debug" && owned.dap ? "debug_ready" : "running";
      this.startMonitor(owned);
      return snapshot(owned);
    } catch (error) {
      owned.state = "failed";
      const failures: unknown[] = [error]; let processConfirmed = true;
      await cleanup(owned.dap, failures); owned.dap = undefined;
      await cleanup(owned.bridge, failures); owned.bridge = undefined; owned.bridgeRoot = undefined;
      try { await this.runner.stopCurrent(); } catch (cleanupError) { failures.push(cleanupError); processConfirmed = false; }
      owned.secret = "";
      if (processConfirmed) this.clear(owned);
      if (failures.length > 1) throw new AggregateError(failures, error instanceof Error ? error.message : "Runtime launch failed.");
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
    const attempt = async (action: (() => void | Promise<void>) | undefined) => { if (!action) return; try { await action(); } catch (error) { first ??= error; } };
    await attempt(owned.dap ? () => owned.dap!.close() : undefined);
    owned.dap = undefined;
    await attempt(owned.bridge ? () => owned.bridge!.close() : undefined);
    owned.bridge = undefined; owned.bridgeRoot = undefined; owned.secret = "";
    let processConfirmed = true;
    await attempt(async () => { try { result = owned.process ? await this.runner.stop(owned.process.childId) : await this.runner.stopCurrent(); } catch (error) { processConfirmed = false; throw error; } });
    const terminalExit = result?.exit ?? owned.process?.exit;
    const terminal: RuntimeStopResult = Object.freeze({ sessionId: owned.id, alreadyStopped: result?.alreadyStopped ?? true, graceful: result?.graceful ?? false, forced: result?.forced ?? false, ...(terminalExit ? { exit: terminalExit } : {}) });
    processConfirmed ||= owned.process?.running === false;
    if (processConfirmed) { this.lastStopped = terminal; this.clear(owned); }
    else { owned.state = "failed"; if (owned.process) this.startMonitor(owned); }
    if (first) throw first;
    return terminal;
  }

  private startMonitor(owned: OwnedSession): void {
    this.stopMonitor();
    this.monitor = setInterval(() => {
      if (this.owned === owned && owned.process && !owned.process.running && !this.stopWork) void this.beginStop(owned).catch(() => {});
    }, this.monitorMs);
    this.monitor.unref?.();
  }

  private stopMonitor(): void { if (this.monitor) clearInterval(this.monitor); this.monitor = undefined; }

  private getOwned(id: string, states: readonly RuntimeSessionState[]): OwnedSession {
    const owned = this.owned;
    if (!owned || owned.id !== id || !states.includes(owned.state)) throw invalidSession();
    return owned;
  }

  private clear(owned: OwnedSession): void {
    this.stopMonitor();
    owned.secret = ""; owned.bridge = undefined; owned.bridgeRoot = undefined; owned.dap = undefined; owned.process = undefined;
    if (this.owned === owned) this.owned = undefined;
  }

  private getBridge(id: string): OwnedSession { const owned = this.getOwned(id, ["running", "debug_ready"]); if (!owned.process?.running) throw invalidSession(); if (!owned.bridge) throw new GodotMcpError("not_connected", "The runtime bridge is unavailable.", "Launch a new runtime session and wait for bridge attachment."); return owned; }
  private async bridgeRequest(id: string, method: string, params: unknown): Promise<unknown> { const owned = this.getBridge(id); try { const result = await owned.bridge!.request<unknown>(id, method, params, 5000); const error = optionalOwn(result, "error"); if (typeof error === "string") throw new GodotMcpError("godot_error", "The runtime bridge operation failed.", "Check the running scene and retry with valid runtime values."); return result; } catch (error) { if (error instanceof GodotMcpError) throw error; const message = error instanceof Error ? error.message : ""; if (/deadline|timeout/i.test(message)) throw new GodotMcpError("timeout", "The runtime bridge request failed.", "Launch a new runtime session if the bridge is no longer connected."); if (/closed|not connected|socket|transport|publication failed/i.test(message)) throw new GodotMcpError("not_connected", "The runtime bridge request failed.", "Launch a new runtime session if the bridge is no longer connected."); throw invalidBridge(); } }
}

function snapshot(owned: OwnedSession): RuntimeSessionSnapshot {
  return Object.freeze({ id: owned.id, mode: owned.mode, state: owned.state as RuntimeSessionSnapshot["state"], ...(owned.process ? { pid: owned.process.pid, startedAt: owned.process.startedAt } : {}) });
}
function invalidSession() { return new GodotMcpError("invalid_args", "Unknown, stale, or unavailable runtime session.", "Pass the active session ID and retry only while that session is running."); }
function runtimeError(message: string, hint: string) { return new GodotMcpError("godot_error", message, hint); }
async function cleanup(value: RuntimeLifecycle | undefined, failures: unknown[]): Promise<void> { if (!value) return; try { await value.close(); } catch (error) { failures.push(error); } }
function optionalOwn(value: unknown, key: string): unknown { if (!value || typeof value !== "object") return undefined; let descriptor: PropertyDescriptor | undefined; try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { throw invalidBridge(); } if (!descriptor) return undefined; if (!("value" in descriptor)) throw invalidBridge(); return descriptor.value; }
function ownValue(value: unknown, key: string): unknown { const result = optionalOwn(value, key); if (result === undefined) throw invalidBridge(); return result; }
function ownString(value: unknown, key: string, maximum: number): string { const result = ownValue(value, key); if (typeof result !== "string" || Buffer.byteLength(result, "utf8") > maximum) throw invalidBridge(); return result; }
function ownBoolean(value: unknown, key: string): boolean { const result = ownValue(value, key); if (typeof result !== "boolean") throw invalidBridge(); return result; }
function ownInteger(value: unknown, key: string, minimum: number, maximum: number): number { const result = ownValue(value, key); if (!Number.isSafeInteger(result) || (result as number) < minimum || (result as number) > maximum) throw invalidBridge(); return result as number; }
function ownArray(value: unknown, key: string): unknown[] { const result = ownValue(value, key); let descriptors: Record<string, PropertyDescriptor>; try { if (!Array.isArray(result)) throw invalidBridge(); descriptors = Object.getOwnPropertyDescriptors(result) as Record<string, PropertyDescriptor>; } catch { throw invalidBridge(); } const length = descriptors.length; if (!length || !("value" in length) || !Number.isInteger(length.value) || length.value < 0 || length.value > 1000) throw invalidBridge(); const output: unknown[] = []; for (let index = 0; index < length.value; index++) { const descriptor = descriptors[String(index)]; if (!descriptor || !("value" in descriptor)) throw invalidBridge(); output.push(descriptor.value); } return output; }
function ownRecord(value: unknown, key: string): object { const result = ownValue(value, key); if (!result || typeof result !== "object" || Array.isArray(result)) throw invalidBridge(); return result; }
function cloneJson(value: unknown, seen = new Set<object>(), depth = 0): unknown { if (depth > 16) throw invalidBridge(); if (value === null || typeof value === "boolean" || typeof value === "string") return value; if (typeof value === "number" && Number.isFinite(value)) return value; if (!value || typeof value !== "object" || seen.has(value)) throw invalidBridge(); seen.add(value); try { let array: boolean; try { array = Array.isArray(value); } catch { throw invalidBridge(); } if (array) return Object.freeze(ownArray({ value }, "value").map(item => cloneJson(item, seen, depth + 1))); let descriptors: PropertyDescriptorMap; try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { throw invalidBridge(); } const output: Record<string, unknown> = Object.create(null); for (const [key, descriptor] of Object.entries(descriptors)) if (descriptor.enumerable) { if (!("value" in descriptor)) throw invalidBridge(); output[key] = cloneJson(descriptor.value, seen, depth + 1); } return Object.freeze(output); } finally { seen.delete(value); } }
function invalidBridge() { return new GodotMcpError("godot_error", "Runtime bridge returned an invalid response.", "Launch a new runtime session with compatible bridge resources."); }
function screenshotError() { return new GodotMcpError("godot_error", "Runtime screenshot verification failed.", "Capture again in a healthy session and ensure the session artifact directory is unchanged."); }
