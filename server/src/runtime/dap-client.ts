import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { GodotMcpError } from "../errors.js";
import { DapTransport, type DapEvent } from "./dap-transport.js";

export type DapClientState = "disconnected" | "attaching" | "ready" | "stopped" | "degraded" | "exited";
export interface DapProcessMetadata { readonly pid: number; readonly startedAt?: number }
export interface DapBridgeMetadata { readonly transport: "socket" | "file" }
export interface DapReference { readonly runtimeSessionId: string; readonly stoppedGeneration: number; readonly id: number }
export interface DapBreakpointGroup { readonly source: { readonly path: string; readonly name?: string }; readonly breakpoints: readonly { readonly line: number; readonly column?: number; readonly condition?: string; readonly hitCondition?: string; readonly logMessage?: string }[] }
export interface DapAttachOptions {
  readonly host: string; readonly port: number; readonly runtimeSessionId: string; readonly process: DapProcessMetadata;
  readonly bridge?: DapBridgeMetadata; readonly initialBreakpoints?: readonly DapBreakpointGroup[];
  readonly attachArguments?: Readonly<Record<string, unknown>>; readonly timeoutMs?: number;
}
export interface DapReadyState { readonly state: "ready"; readonly runtimeSessionId: string; readonly process: DapProcessMetadata; readonly bridge?: DapBridgeMetadata; readonly capabilities: Readonly<Record<string, unknown>>; readonly stoppedGeneration: number }
export interface DapClientStatus { readonly state: DapClientState; readonly runtimeSessionId?: string; readonly process?: DapProcessMetadata; readonly bridge?: DapBridgeMetadata; readonly stoppedGeneration: number; readonly capabilities?: Readonly<Record<string, unknown>>; readonly degradation?: { readonly mode: "process_plus_bridge"; readonly dapAvailable: false; readonly reason: string } }
interface Dependencies { socketFactory?: (host: string, port: number, timeoutMs: number) => Promise<Duplex>; transportFactory?: () => DapTransport }

const MAX_THREADS = 64, MAX_FRAMES = 256, MAX_SCOPES = 64, MAX_VARIABLES = 500, MAX_TEXT_BYTES = 8_192;
const unavailable = () => new GodotMcpError("not_connected", "Godot debug adapter session is not ready.", "Launch a new managed debug session and wait for DAP attachment.");
const bad = (message: string) => new GodotMcpError("godot_error", message, "Restart the managed debug session with a compatible Godot debug adapter.");
const stale = () => new GodotMcpError("invalid_args", "Debug reference is stale or belongs to another runtime session.", "Request a new stack after the next stopped event.");
const disabled = (capability: string) => new GodotMcpError("feature_disabled", `Godot debug adapter does not advertise ${capability}.`, "Use a Godot debug adapter that supports this capability.");

export class DapClient {
  private transport: DapTransport | undefined;
  private currentState: DapClientState = "disconnected";
  private options: DapAttachOptions | undefined;
  private capabilities: Readonly<Record<string, unknown>> | undefined;
  private stoppedGeneration = 0;
  private degradation: DapClientStatus["degradation"];
  private readonly listeners = new Set<(event: DapEvent) => void>();
  private readonly socketFactory: NonNullable<Dependencies["socketFactory"]>;
  private readonly transportFactory: NonNullable<Dependencies["transportFactory"]>;
  private closing = false;

  constructor(dependencies: Dependencies = {}) { this.socketFactory = dependencies.socketFactory ?? createSocket; this.transportFactory = dependencies.transportFactory ?? (() => new DapTransport()); }
  get status(): DapClientStatus {
    const base: DapClientStatus = { state: this.currentState, stoppedGeneration: this.stoppedGeneration };
    return Object.freeze({ ...base, ...(this.options ? { runtimeSessionId: this.options.runtimeSessionId, process: this.options.process, ...(this.options.bridge ? { bridge: this.options.bridge } : {}) } : {}), ...(this.capabilities ? { capabilities: this.capabilities } : {}), ...(this.degradation ? { degradation: this.degradation } : {}) });
  }
  onEvent(listener: (event: DapEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async attach(options: DapAttachOptions): Promise<DapReadyState> {
    if (this.currentState !== "disconnected") throw bad("DAP client is already attached or attaching.");
    validateAttach(options); this.options = freezeOptions(options); this.currentState = "attaching"; this.degradation = undefined; this.closing = false;
    const timeoutMs = finiteDeadline(options.timeoutMs ?? 5_000), deadline = Date.now() + timeoutMs;
    const transport = this.transportFactory(); this.transport = transport;
    transport.onEvent(this.handleEvent); transport.onClosed((error) => this.handleClosed(error));
    let initializedEvent: Promise<void> | undefined;
    try {
      const socket = await bounded(this.socketFactory(options.host, options.port, remaining(deadline)), remaining(deadline), "DAP attach timed out.");
      if (this.transport !== transport || this.closing) { socket.destroy(); throw unavailable(); }
      transport.attach(socket);
      initializedEvent = this.waitForEvent("initialized", remaining(deadline));
      void initializedEvent.catch(() => undefined);
      const initialize = await transport.request<unknown>("initialize", { clientID: "robogodot", clientName: "RoboGodot", adapterID: "godot", pathFormat: "path", linesStartAt1: true, columnsStartAt1: true, supportsVariableType: true, supportsVariablePaging: true }, remaining(deadline));
      this.capabilities = Object.freeze(copyRecord(initialize, "initialize capabilities"));
      await transport.request("attach", { ...(options.attachArguments ?? {}), processId: options.process.pid }, remaining(deadline));
      await initializedEvent;
      for (const group of options.initialBreakpoints ?? []) await this.setBreakpointsInternal(group.source, group.breakpoints, remaining(deadline));
      this.requireCapability("supportsConfigurationDoneRequest");
      await transport.request("configurationDone", {}, remaining(deadline));
      this.currentState = "ready";
      return this.readyState();
    } catch (error) {
      void initializedEvent?.catch(() => undefined);
      const mapped = mapAttachError(error); await transport.close(mapped).catch(() => undefined);
      if (this.closing) { this.currentState = "disconnected"; this.degradation = undefined; throw unavailable(); }
      this.markDegraded(mapped.message); throw mapped;
    }
  }
  async setBreakpoints(source: DapBreakpointGroup["source"], breakpoints: DapBreakpointGroup["breakpoints"]): Promise<unknown> { this.requireUsable(); return this.setBreakpointsInternal(source, breakpoints); }
  async continue(thread: number | DapReference): Promise<unknown> { this.requireStopped(); const threadId = this.referenceId(thread, "thread"); this.invalidateStop(); return this.transport!.request("continue", { threadId }); }
  async step(kind: "over" | "into", thread: number | DapReference): Promise<unknown> { this.requireStopped(); const threadId = this.referenceId(thread, "thread"); this.invalidateStop(); return this.transport!.request(kind === "over" ? "next" : "stepIn", { threadId }); }
  async stack(thread?: number | DapReference, startFrame = 0): Promise<{ threads: readonly unknown[]; frames: readonly unknown[]; totalFrames?: number; truncated: boolean }> {
    this.requireStopped(); const threadId = thread === undefined ? undefined : this.referenceId(thread, "thread"); validateOffset(startFrame);
    const rawThreads = copyRecord(await this.transport!.request("threads", {}), "threads response"); const allThreads = array(rawThreads.threads, "threads");
    const threads = allThreads.slice(0, MAX_THREADS).map((item) => this.normalizeThread(item)); const selected = threadId ?? (threads[0] as { id?: number } | undefined)?.id;
    if (selected === undefined) return Object.freeze({ threads: Object.freeze(threads), frames: Object.freeze([]), truncated: allThreads.length > MAX_THREADS });
    validateId(selected, "thread"); const rawStack = copyRecord(await this.transport!.request("stackTrace", { threadId: selected, startFrame, levels: MAX_FRAMES }), "stack response"); const allFrames = array(rawStack.stackFrames, "stackFrames");
    const frames = allFrames.slice(0, MAX_FRAMES).map((item) => this.normalizeFrame(item)); const totalFrames = optionalNonnegative(rawStack.totalFrames);
    return Object.freeze({ threads: Object.freeze(threads), frames: Object.freeze(frames), ...(totalFrames === undefined ? {} : { totalFrames }), truncated: allThreads.length > MAX_THREADS || allFrames.length > MAX_FRAMES || (totalFrames !== undefined && startFrame + frames.length < totalFrames) });
  }
  async inspect(frame: DapReference, variables?: DapReference, start = 0): Promise<any> {
    this.validateReference(frame); this.requireStopped(); validateOffset(start);
    if (variables) {
      this.validateReference(variables); if (start > 0) this.requireCapability("supportsVariablePaging");
      const raw = copyRecord(await this.transport!.request("variables", { variablesReference: variables.id, start, count: MAX_VARIABLES }), "variables response"); const all = array(raw.variables, "variables"); const values = all.slice(0, MAX_VARIABLES).map((item) => this.normalizeVariable(item));
      return Object.freeze({ variables: Object.freeze(values), ...(all.length === MAX_VARIABLES ? { next: start + MAX_VARIABLES } : {}), truncated: all.length > MAX_VARIABLES });
    }
    const raw = copyRecord(await this.transport!.request("scopes", { frameId: frame.id }), "scopes response"); const all = array(raw.scopes, "scopes"); const scopes = all.slice(0, MAX_SCOPES).map((item) => this.normalizeScope(item));
    return Object.freeze({ scopes: Object.freeze(scopes), truncated: all.length > MAX_SCOPES });
  }
  async terminate(): Promise<unknown> { this.requireCapability("supportsTerminateRequest"); this.requireUsable(); this.invalidateStop(); return this.transport!.request("terminate", {}); }
  async disconnect(): Promise<void> {
    const transport = this.transport; if (!transport) return;
    if (this.currentState !== "ready" && this.currentState !== "stopped") { await this.closeTransport(transport); return; }
    this.closing = true; this.invalidateStop(); let failure: unknown;
    try { await transport.request("disconnect", { restart: false, terminateDebuggee: false }); } catch (error) { failure = error; }
    finally { await this.closeTransport(transport); }
    if (failure !== undefined) throw failure;
  }
  async close(): Promise<void> { if (this.currentState === "ready" || this.currentState === "stopped") return this.disconnect(); const transport = this.transport; if (transport) await this.closeTransport(transport); }

  private async setBreakpointsInternal(source: DapBreakpointGroup["source"], breakpoints: DapBreakpointGroup["breakpoints"], timeoutMs?: number): Promise<unknown> { if (typeof source.path !== "string" || byteLength(source.path) > MAX_TEXT_BYTES || breakpoints.length > MAX_VARIABLES) throw new GodotMcpError("invalid_args", "Invalid DAP breakpoint request.", "Use one bounded source path and at most 500 source breakpoints."); return this.transport!.request("setBreakpoints", { source, breakpoints }, timeoutMs); }
  private readyState(): DapReadyState { return Object.freeze({ state: "ready", runtimeSessionId: this.options!.runtimeSessionId, process: this.options!.process, ...(this.options!.bridge ? { bridge: this.options!.bridge } : {}), capabilities: this.capabilities!, stoppedGeneration: this.stoppedGeneration }); }
  private readonly handleEvent = (event: DapEvent): void => { if (event.event === "stopped") { this.stoppedGeneration++; this.currentState = "stopped"; } else if (event.event === "continued") this.invalidateStop(); else if (event.event === "exited" || event.event === "terminated") { this.invalidateStop(); this.currentState = "exited"; } for (const listener of this.listeners) try { listener(event); } catch { /* isolate subscribers */ } };
  private handleClosed(error: Error): void { if (this.closing) return; this.transport = undefined; this.invalidateStop(); if (this.currentState !== "exited") this.markDegraded(error.message); }
  private markDegraded(reason: string): void { this.currentState = this.options?.process ? "degraded" : "disconnected"; this.degradation = Object.freeze({ mode: "process_plus_bridge", dapAvailable: false, reason: boundedText(reason) }); }
  private invalidateStop(): void { if (this.currentState === "stopped") this.currentState = "ready"; }
  private validateReference(ref: DapReference): void { if (this.currentState !== "stopped" || ref.runtimeSessionId !== this.options?.runtimeSessionId || ref.stoppedGeneration !== this.stoppedGeneration || !Number.isSafeInteger(ref.id) || ref.id < 0) throw stale(); }
  private requireStopped(): void { if (this.currentState !== "stopped" || !this.transport) throw unavailable(); }
  private requireUsable(): void { if (!this.transport || (this.currentState !== "ready" && this.currentState !== "stopped" && this.currentState !== "attaching")) throw unavailable(); }
  private requireCapability(name: string): void { if (this.capabilities?.[name] !== true) throw disabled(name); }
  private waitForEvent(name: string, timeoutMs: number): Promise<void> { return new Promise((resolve, reject) => { let timer: NodeJS.Timeout; const remove = this.onEvent((event) => { if (event.event !== name) return; clearTimeout(timer); remove(); resolve(); }); timer = setTimeout(() => { remove(); reject(new GodotMcpError("timeout", `DAP ${name} event timed out.`, "Launch a new managed debug session and attach again.")); }, timeoutMs); }); }
  private normalizeFrame(value: unknown): unknown { const raw = copyRecord(value, "stack frame"); const id = requiredId(raw.id, "frame"); return Object.freeze({ id, ref: this.ref(id), name: boundedText(raw.name), line: requiredId(raw.line, "line"), column: requiredId(raw.column, "column"), ...(raw.source === undefined ? {} : { source: normalizeSource(raw.source) }) }); }
  private normalizeThread(value: unknown): unknown { const raw = copyRecord(value, "thread"); const id = requiredId(raw.id, "thread"); return Object.freeze({ id, ref: this.ref(id), name: boundedText(raw.name) }); }
  private normalizeScope(value: unknown): unknown { const raw = copyRecord(value, "scope"); const id = requiredId(raw.variablesReference, "variablesReference"); return Object.freeze({ name: boundedText(raw.name), ref: this.ref(id), ...(typeof raw.expensive === "boolean" ? { expensive: raw.expensive } : {}) }); }
  private normalizeVariable(value: unknown): unknown { const raw = copyRecord(value, "variable"); const id = requiredId(raw.variablesReference, "variablesReference"); return Object.freeze({ name: boundedText(raw.name), value: boundedText(raw.value), ...(raw.type === undefined ? {} : { type: boundedText(raw.type) }), ref: this.ref(id) }); }
  private ref(id: number): DapReference { return Object.freeze({ runtimeSessionId: this.options!.runtimeSessionId, stoppedGeneration: this.stoppedGeneration, id }); }
  private referenceId(value: number | DapReference, label: string): number { if (typeof value === "number") { validateId(value, label); return value; } this.validateReference(value); return value.id; }
  private async closeTransport(transport: DapTransport): Promise<void> { this.closing = true; this.invalidateStop(); await transport.close(); if (this.transport === transport) this.transport = undefined; if (this.currentState !== "exited") this.currentState = "disconnected"; }
}

function createSocket(host: string, port: number, timeoutMs: number): Promise<Duplex> { return new Promise((resolve, reject) => { const socket = connect(port, host); const timer = setTimeout(() => { socket.destroy(); reject(new GodotMcpError("timeout", "DAP socket connection timed out.", "Confirm the managed Godot process is listening on its DAP endpoint.")); }, timeoutMs); socket.once("connect", () => { clearTimeout(timer); socket.off("error", fail); resolve(socket); }); const fail = (error: Error) => { clearTimeout(timer); reject(new GodotMcpError("not_connected", error.message, "Confirm the managed Godot process is listening on its DAP endpoint.")); }; socket.once("error", fail); }); }
function validateAttach(value: DapAttachOptions): void { if ((value.host !== "127.0.0.1" && value.host !== "::1" && value.host !== "localhost") || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65_535 || typeof value.runtimeSessionId !== "string" || value.runtimeSessionId.length < 1 || value.runtimeSessionId.length > 128 || !Number.isSafeInteger(value.process?.pid) || value.process.pid < 1) throw new GodotMcpError("invalid_args", "Invalid DAP attach metadata.", "Pass a loopback host, valid port, runtime session ID, and coordinator-owned process metadata."); }
function freezeOptions(value: DapAttachOptions): DapAttachOptions { return Object.freeze({ ...value, process: Object.freeze({ ...value.process }), ...(value.bridge ? { bridge: Object.freeze({ ...value.bridge }) } : {}), ...(value.initialBreakpoints ? { initialBreakpoints: Object.freeze(value.initialBreakpoints.map((group) => Object.freeze({ source: Object.freeze({ ...group.source }), breakpoints: Object.freeze(group.breakpoints.map((point) => Object.freeze({ ...point }))) }))) } : {}), ...(value.attachArguments ? { attachArguments: Object.freeze({ ...value.attachArguments }) } : {}) }); }
function finiteDeadline(value: number): number { return Number.isFinite(value) ? Math.min(60_000, Math.max(1, Math.floor(value))) : 5_000; }
function remaining(deadline: number): number { const value = deadline - Date.now(); if (value <= 0) throw new GodotMcpError("timeout", "DAP attach timed out.", "Launch a new managed debug session and attach again."); return value; }
async function bounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> { let timer: NodeJS.Timeout; try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new GodotMcpError("timeout", message, "Launch a new managed debug session and attach again.")), timeoutMs); })]); } finally { clearTimeout(timer!); } }
function mapAttachError(error: unknown): GodotMcpError { if (error instanceof GodotMcpError) return error; return bad(error instanceof Error ? error.message : "DAP attach failed."); }
function copyRecord(value: unknown, label: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw bad(`Invalid DAP ${label}.`); const out: Record<string, unknown> = Object.create(null); let descriptors: PropertyDescriptorMap; try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { throw bad(`Invalid DAP ${label}.`); } for (const [key, descriptor] of Object.entries(descriptors)) { if (descriptor.enumerable) { if (!("value" in descriptor)) throw bad(`Invalid DAP ${label}.`); out[key] = descriptor.value; } } return out; }
function array(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) throw bad(`Invalid DAP ${label}.`); return value; }
function requiredId(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw bad(`Invalid DAP ${label}.`); return value as number; }
function optionalNonnegative(value: unknown): number | undefined { return value === undefined ? undefined : requiredId(value, "count"); }
function validateId(value: number, label: string): void { if (!Number.isSafeInteger(value) || value < 0) throw new GodotMcpError("invalid_args", `Invalid DAP ${label} ID.`, "Use an ID returned for the current stopped event."); }
function validateOffset(value: number): void { if (!Number.isSafeInteger(value) || value < 0) throw new GodotMcpError("invalid_args", "Invalid DAP pagination offset.", "Use a non-negative integer offset."); }
function boundedText(value: unknown): string { if (typeof value !== "string") throw bad("Invalid DAP text field."); if (byteLength(value) <= MAX_TEXT_BYTES) return value; let low = 0, high = value.length; while (low < high) { const middle = Math.ceil((low + high) / 2); if (byteLength(value.slice(0, middle)) <= MAX_TEXT_BYTES) low = middle; else high = middle - 1; } if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1]!)) low--; return value.slice(0, low); }
function byteLength(value: string): number { return Buffer.byteLength(value, "utf8"); }
function normalizeSource(value: unknown): unknown { const raw = copyRecord(value, "source"); return Object.freeze({ ...(raw.name === undefined ? {} : { name: boundedText(raw.name) }), ...(raw.path === undefined ? {} : { path: boundedText(raw.path) }) }); }
