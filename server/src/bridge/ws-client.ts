import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { GodotMcpError } from "../errors.js";
import type { Logger } from "../logger.js";
import { parseJsonRpcResponse } from "./json-rpc.js";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";
export interface ClientStatus {
  state: ConnectionState;
  url: string;
  connectedSince: string | undefined;
  reconnectAttempt: number;
  lastError: string | undefined;
}
export interface CallOptions { timeoutMs?: number }
interface SocketLike {
  readyState: number;
  on(event: "open", listener: () => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): unknown;
  send(data: string): void;
  close(): void;
}
export interface JsonRpcClientOptions {
  url: string;
  token: string;
  logger: Logger;
  webSocketFactory?: (url: string) => SocketLike;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const BACKOFF = [1000, 2000, 4000, 8000, 16000, 32000, 60000] as const;

function unrefTimer<T>(timer: T): T {
  if ((typeof timer === "object" && timer !== null) || typeof timer === "function") {
    const unref = (timer as { unref?: unknown }).unref;
    if (typeof unref === "function") unref.call(timer);
  }
  return timer;
}

export class JsonRpcClient extends EventEmitter {
  private readonly options: Required<Omit<JsonRpcClientOptions, "webSocketFactory">> & Pick<JsonRpcClientOptions, "webSocketFactory">;
  private socket: SocketLike | undefined;
  private state: ConnectionState = "disconnected";
  private connectedSince: string | undefined;
  private reconnectAttempt = 0;
  private lastError: string | undefined;
  private nextId = 1;
  private stopped = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatPending = false;
  private authenticationId: number | undefined;
  private authenticationTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Map<number, Pending>();

  constructor(options: JsonRpcClientOptions) {
    super();
    this.options = { heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 5_000, ...options };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearHeartbeat();
    this.clearAuthentication();
    const socket = this.socket;
    this.socket = undefined;
    this.rejectPending("Editor connection stopped.");
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
    this.reconnectAttempt = 0;
    this.connectedSince = undefined;
    this.setState("disconnected");
  }

  getStatus(): ClientStatus {
    return { state: this.state, url: this.options.url, connectedSince: this.connectedSince,
      reconnectAttempt: this.reconnectAttempt, lastError: this.lastError };
  }

  call<T>(method: string, params?: unknown, opts: CallOptions = {}): Promise<T> {
    if (this.state !== "connected" || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new GodotMcpError("not_connected", "Godot editor is not connected.", "Open the project in Godot and enable the RoboGodot plugin."));
    }
    const id = this.nextId++;
    const request: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) request.params = params;
    return new Promise<T>((resolve, reject) => {
      const timer = unrefTimer(setTimeout(() => {
        this.pending.delete(id);
        reject(new GodotMcpError("timeout", `JSON-RPC call '${method}' timed out.`, "Check the editor connection and try again."));
      }, opts.timeoutMs ?? 10_000));
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try { this.socket!.send(JSON.stringify(request)); }
      catch (error) {
        clearTimeout(timer); this.pending.delete(id);
        reject(new GodotMcpError("not_connected", "Failed to send to the Godot editor.", "Wait for reconnection and try again.", error));
      }
    });
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState("connecting");
    const socket = (this.options.webSocketFactory ?? ((url) => new WebSocket(url)))(this.options.url);
    this.socket = socket;
    socket.on("open", () => this.handleOpen(socket));
    socket.on("message", (data, isBinary) => this.handleMessage(socket, data, isBinary));
    socket.on("error", (error) => { if (socket === this.socket) this.lastError = error.message; });
    socket.on("close", () => this.handleClose(socket));
  }

  private handleOpen(socket: SocketLike): void {
    if (socket !== this.socket || this.stopped) return;
    this.reconnectAttempt = 0;
    this.lastError = undefined;
    const id = 0;
    this.authenticationId = id;
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method: "auth.authenticate", params: { token: this.options.token } }));
    this.authenticationTimer = unrefTimer(setTimeout(() => {
      if (socket !== this.socket || this.authenticationId !== id) return;
      this.lastError = "Editor authentication timed out";
      socket.close();
    }, this.options.heartbeatTimeoutMs));
  }

  private handleMessage(socket: SocketLike, data: unknown, isBinary: boolean): void {
    if (socket !== this.socket) return;
    if (isBinary) { this.options.logger.warn("Ignoring non-text WebSocket frame"); return; }
    const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : undefined;
    if (text === undefined) { this.options.logger.warn("Ignoring unreadable WebSocket text frame"); return; }
    const response = parseJsonRpcResponse(text);
    if (!response) { this.options.logger.warn("Ignoring malformed JSON-RPC response"); return; }
    const pending = this.pending.get(response.id);
    if (response.id === this.authenticationId) {
      this.clearAuthentication();
      if ("result" in response && typeof response.result === "object" && response.result !== null && "authenticated" in response.result && response.result.authenticated === true) {
        this.connectedSince = new Date().toISOString();
        this.setState("connected");
        this.heartbeatTimer = unrefTimer(setInterval(() => this.heartbeat(), this.options.heartbeatIntervalMs));
      } else {
        this.lastError = "Editor authentication failed";
        socket.close();
      }
      return;
    }
    if (!pending) { this.options.logger.warn("Ignoring JSON-RPC response with unknown id", { id: response.id }); return; }
    this.pending.delete(response.id); clearTimeout(pending.timer);
    if ("result" in response) pending.resolve(response.result);
    else pending.reject(new GodotMcpError("godot_error", response.error.message,
      typeof response.error.data === "object" && response.error.data !== null && "hint" in response.error.data && typeof response.error.data.hint === "string"
        ? response.error.data.hint : "Check the Godot editor output for details.", response.error));
  }

  private handleClose(socket: SocketLike): void {
    if (socket !== this.socket) return;
    this.socket = undefined;
    this.clearAuthentication();
    this.connectedSince = undefined;
    this.clearHeartbeat();
    this.rejectPending("Godot editor connection closed.");
    if (this.stopped) { this.setState("disconnected"); return; }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    const delay = BACKOFF[Math.min(this.reconnectAttempt, BACKOFF.length - 1)]!;
    this.reconnectAttempt++;
    this.setState("reconnecting");
    this.reconnectTimer = unrefTimer(setTimeout(() => { this.reconnectTimer = undefined; this.connect(); }, delay));
  }

  private heartbeat(): void {
    if (this.heartbeatPending || this.state !== "connected") return;
    this.heartbeatPending = true;
    void this.call("core.ping", undefined, { timeoutMs: this.options.heartbeatTimeoutMs })
      .then(() => { this.heartbeatPending = false; })
      .catch((error: unknown) => {
        this.heartbeatPending = false;
        this.lastError = error instanceof Error ? error.message : "Heartbeat failed";
        this.socket?.close();
      });
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.heartbeatPending = false;
  }

  private clearAuthentication(): void {
    if (this.authenticationTimer) clearTimeout(this.authenticationTimer);
    this.authenticationTimer = undefined;
    this.authenticationId = undefined;
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new GodotMcpError("not_connected", message, "Wait for the editor connection to recover and try again."));
    }
    this.pending.clear();
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit("status", this.getStatus());
    this.emit(state, this.getStatus());
  }
}
