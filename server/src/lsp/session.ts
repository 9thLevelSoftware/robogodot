import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { GodotMcpError } from "../errors.js";
import { LSP_LIMITS, type LspCapability, type LspNotification, type LspReadyState } from "./protocol.js";
import { LspTransport } from "./transport.js";

export type LspSessionState = "disconnected" | "connecting" | "initializing" | "ready" | "reconnecting" | "shutting_down" | "exited";
export interface LspSessionOptions {
  host: "127.0.0.1";
  port: number;
  projectRootUri: string;
  connectTimeoutMs?: number;
  socketFactory?: (host: string, port: number) => Promise<Duplex>;
  beforeConnect?: () => Promise<void>;
  schedule?: (delayMs: number, work: () => void) => () => void;
}

type InitializeResult = { capabilities: Record<string, unknown>; serverInfo?: { name: string; version?: string }; [key: string]: unknown };
const reconnectDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000] as const;
const unavailable = () => new GodotMcpError("not_connected", "Godot language server session is not ready.", "Wait for the Godot language server connection to recover and try again.");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export class LspSession {
  state: LspSessionState = "disconnected";
  ready: LspReadyState | undefined;
  private readonly transport = new LspTransport(LSP_LIMITS);
  private readonly notificationListeners = new Set<(event: LspNotification) => void>();
  private generation = 0;
  private reconnectAttempt = 0;
  private readiness: Promise<LspReadyState> | undefined;
  private replayHook: ((generation: number) => Promise<void>) | undefined;
  private cancelReconnect: (() => void) | undefined;
  private closing: Promise<void> | undefined;

  constructor(private readonly options: LspSessionOptions) {
    this.transport.onClosed(() => this.handleUnexpectedClose());
    this.transport.onNotification((event) => {
      if (this.state !== "ready" || event.generation !== this.ready?.generation) return;
      for (const listener of this.notificationListeners) { try { listener(event); } catch { /* isolate subscribers */ } }
    });
  }

  ensureReady(): Promise<LspReadyState> {
    if (this.state === "ready" && this.ready) return Promise.resolve(this.ready);
    if (this.state === "shutting_down" || this.state === "exited") return Promise.reject(unavailable());
    if (!this.readiness) this.readiness = this.connectAndInitialize(false);
    return this.readiness;
  }

  async request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    await this.ensureReady();
    return timeoutMs === undefined ? this.transport.request<T>(method, params) : this.transport.request<T>(method, params, timeoutMs);
  }

  async notify(method: string, params: unknown): Promise<void> { await this.ensureReady(); await this.transport.notify(method, params); }
  onNotification(listener: (event: LspNotification) => void): () => void { this.notificationListeners.add(listener); return () => this.notificationListeners.delete(listener); }
  setReplayHook(hook: (generation: number) => Promise<void>): void { this.replayHook = hook; }

  supports(capability: LspCapability): boolean {
    const caps = this.ready?.capabilities; if (!caps) return false;
    if (capability === "completion") return Boolean(caps.completionProvider);
    if (capability === "hover") return Boolean(caps.hoverProvider);
    if (capability === "signatureHelp") return Boolean(caps.signatureHelpProvider);
    if (capability === "documentSymbols") return Boolean(caps.documentSymbolProvider);
    if (capability === "workspaceSymbols") return Boolean(caps.workspaceSymbolProvider);
    return this.isPinnedGodot46() || this.hasGodotNativeExtension();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.performClose(); return this.closing;
  }

  private async connectAndInitialize(reconnecting: boolean): Promise<LspReadyState> {
    this.state = reconnecting ? "reconnecting" : "connecting";
    await this.options.beforeConnect?.();
    const socket = await this.createSocket();
    if (this.isClosing()) { socket.destroy(); throw unavailable(); }
    const generation = ++this.generation;
    this.transport.attach(socket, generation); this.state = "initializing";
    const raw = await this.transport.request<unknown>("initialize", this.initializeParams(), this.options.connectTimeoutMs);
    const initialized = this.validateInitialize(raw);
    await this.transport.notify("initialized", {});
    if (reconnecting && this.replayHook) await this.replayHook(generation);
    const ready: LspReadyState = initialized.serverInfo === undefined
      ? { generation, capabilities: initialized.capabilities }
      : { generation, capabilities: initialized.capabilities, serverInfo: initialized.serverInfo };
    this.ready = ready; this.reconnectAttempt = 0; this.state = "ready"; return ready;
  }

  private initializeParams(): Record<string, unknown> {
    const segment = this.options.projectRootUri.replace(/\/$/, "").split("/").pop();
    return {
      processId: process.pid, rootUri: this.options.projectRootUri,
      workspaceFolders: [{ uri: this.options.projectRootUri, name: segment || "project" }],
      clientInfo: { name: "RoboGodot", version: "0.1.0" },
      capabilities: { general: { positionEncodings: ["utf-16"] }, textDocument: { completion: {}, hover: {}, signatureHelp: {}, documentSymbol: {} }, workspace: { symbol: {} } },
    };
  }

  private validateInitialize(raw: unknown): InitializeResult {
    if (!isRecord(raw) || !isRecord(raw.capabilities)) throw new GodotMcpError("godot_error", "Godot language server returned an invalid initialize result.", "Restart the Godot language server and try again.");
    let serverInfo: InitializeResult["serverInfo"];
    if (raw.serverInfo !== undefined) {
      if (!isRecord(raw.serverInfo) || typeof raw.serverInfo.name !== "string" || (raw.serverInfo.version !== undefined && typeof raw.serverInfo.version !== "string")) throw new GodotMcpError("godot_error", "Godot language server returned invalid server information.", "Restart the Godot language server and try again.");
      serverInfo = raw.serverInfo.version === undefined ? { name: raw.serverInfo.name } : { name: raw.serverInfo.name, version: raw.serverInfo.version };
    }
    return serverInfo === undefined ? { ...raw, capabilities: raw.capabilities } : { ...raw, capabilities: raw.capabilities, serverInfo };
  }

  private createSocket(): Promise<Duplex> {
    if (this.options.socketFactory) return this.options.socketFactory(this.options.host, this.options.port);
    return new Promise((resolve, reject) => {
      const socket = connect(this.options.port, this.options.host);
      const onError = (error: Error) => { clearTimeout(timeout); reject(error); };
      const timeout = setTimeout(() => { socket.off("error", onError); socket.destroy(); reject(unavailable()); }, this.options.connectTimeoutMs ?? 5_000);
      socket.once("connect", () => { clearTimeout(timeout); socket.off("error", onError); resolve(socket); });
      socket.once("error", onError);
    });
  }

  private handleUnexpectedClose(): void {
    if (this.state === "shutting_down" || this.state === "exited") return;
    this.ready = undefined; this.readiness = undefined; this.state = "reconnecting"; this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = reconnectDelays[Math.min(this.reconnectAttempt, reconnectDelays.length - 1)]!; this.reconnectAttempt++;
    const work = () => {
      this.cancelReconnect = undefined;
      if (this.state === "shutting_down" || this.state === "exited") return;
      this.readiness = this.connectAndInitialize(true);
      void this.readiness.catch(() => { this.readiness = undefined; if (this.state !== "shutting_down" && this.state !== "exited") this.scheduleReconnect(); });
    };
    this.cancelReconnect = this.options.schedule ? this.options.schedule(delay, work) : (() => { const timer = setTimeout(work, delay); return () => clearTimeout(timer); })();
  }

  private isPinnedGodot46(): boolean { const info = this.ready?.serverInfo; return info?.name.toLowerCase().includes("godot") === true && info.version?.startsWith("4.6.") === true; }
  private isClosing(): boolean { return this.state === "shutting_down" || this.state === "exited"; }
  private hasGodotNativeExtension(): boolean {
    const caps = this.ready?.capabilities; if (!caps) return false;
    const experimental = caps.experimental;
    return isRecord(experimental) && (experimental.godotNativeSymbol === true || (isRecord(experimental.godot) && experimental.godot.nativeSymbol === true));
  }

  private async performClose(): Promise<void> {
    this.state = "shutting_down"; this.cancelReconnect?.(); this.cancelReconnect = undefined;
    if (this.transport.isAttached && this.ready) {
      try { await this.transport.request("shutdown", null, LSP_LIMITS.minRequestMs); } catch { /* exit is mandatory */ }
      try { await this.transport.notify("exit", null); } catch { /* transport may already be gone */ }
    }
    await this.transport.close(); this.ready = undefined; this.readiness = undefined; this.state = "exited";
  }
}
