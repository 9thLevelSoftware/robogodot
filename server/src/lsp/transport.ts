import type { Duplex } from "node:stream";
import { GodotMcpError } from "../errors.js";
import { encodeFrame, LSP_LIMITS, parseJsonRpcEnvelope, type LspNotification, type LspResponseError } from "./protocol.js";

interface TransportOptions {
  maxFrameBytes: number; maxBufferBytes: number; maxPending: number;
  defaultRequestMs?: number; minRequestMs?: number; maxRequestMs?: number;
}
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; generation: number }

const notConnected = (message = "Godot language server is not connected.") =>
  new GodotMcpError("not_connected", message, "Wait for the Godot language server connection to recover and try again.");
const protocolError = (message: string) =>
  new GodotMcpError("godot_error", message, "Restart the Godot language server and try again.");

export class LspTransport {
  private socket: Duplex | undefined;
  private buffer = Buffer.alloc(0);
  private bodyLength: number | undefined;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private notificationListeners = new Set<(event: LspNotification) => void>();
  private closedListeners = new Set<(error: Error) => void>();
  private currentGeneration = 0;
  private closing = false;

  constructor(private readonly options: TransportOptions = LSP_LIMITS) {}
  get generation(): number { return this.currentGeneration; }
  get isAttached(): boolean { return this.socket !== undefined; }

  attach(socket: Duplex, generation: number): void {
    if (this.socket) this.fail(notConnected("Godot language server connection was replaced."));
    this.socket = socket; this.currentGeneration = generation; this.buffer = Buffer.alloc(0); this.bodyLength = undefined; this.closing = false;
    socket.on("data", this.onData); socket.once("close", this.onSocketClose); socket.once("error", this.onSocketError);
  }

  request<T>(method: string, params: unknown, timeoutMs = this.options.defaultRequestMs ?? LSP_LIMITS.defaultRequestMs): Promise<T> {
    if (!this.socket) return Promise.reject(notConnected());
    if (this.pending.size >= this.options.maxPending) return Promise.reject(new GodotMcpError("godot_error", "LSP request limit reached.", "Wait for an in-flight request to finish."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GodotMcpError("timeout", `LSP request ${method} timed out.`, "Retry after confirming the Godot language server is responsive."));
      }, this.clampDeadline(timeoutMs));
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, generation: this.currentGeneration });
      try { this.write({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(notConnected(error instanceof Error ? error.message : undefined)); }
    });
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (!this.socket) throw notConnected();
    try { this.write({ jsonrpc: "2.0", method, params }); } catch { throw notConnected(); }
  }
  onNotification(listener: (event: LspNotification) => void): () => void { this.notificationListeners.add(listener); return () => this.notificationListeners.delete(listener); }
  onClosed(listener: (error: Error) => void): () => void { this.closedListeners.add(listener); return () => this.closedListeners.delete(listener); }

  async close(reason = notConnected("Godot language server connection closed.")): Promise<void> {
    const socket = this.socket; if (!socket) return;
    this.closing = true; this.fail(reason); socket.destroy();
  }

  private clampDeadline(timeoutMs: number): number {
    const min = this.options.minRequestMs ?? LSP_LIMITS.minRequestMs, max = this.options.maxRequestMs ?? LSP_LIMITS.maxRequestMs;
    return Math.min(max, Math.max(min, Number.isFinite(timeoutMs) ? timeoutMs : this.options.defaultRequestMs ?? LSP_LIMITS.defaultRequestMs));
  }
  private write(message: unknown): void { this.socket!.write(encodeFrame(message)); }

  private readonly onData = (chunk: Buffer | string): void => {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (incoming.length > this.options.maxBufferBytes - this.buffer.length) { this.fail(protocolError("LSP receive buffer limit exceeded.")); return; }
    this.buffer = Buffer.concat([this.buffer, incoming]);
    try {
      while (this.socket) {
        if (this.bodyLength === undefined) {
          const headerEnd = this.buffer.indexOf("\r\n\r\n"); if (headerEnd < 0) return;
          const header = this.buffer.subarray(0, headerEnd).toString("ascii");
          const lengths = header.split("\r\n").filter((line) => /^content-length:/i.test(line));
          if (lengths.length !== 1) throw protocolError("LSP frame requires exactly one Content-Length header.");
          const raw = lengths[0]!.slice(lengths[0]!.indexOf(":") + 1).trim();
          if (!/^\d+$/.test(raw)) throw protocolError("LSP Content-Length must contain ASCII decimal digits.");
          const length = Number(raw); if (!Number.isSafeInteger(length) || length > this.options.maxFrameBytes) throw protocolError("LSP frame exceeds the configured size limit.");
          this.bodyLength = length; this.buffer = this.buffer.subarray(headerEnd + 4);
        }
        if (this.buffer.length < this.bodyLength) return;
        const body = this.buffer.subarray(0, this.bodyLength); this.buffer = this.buffer.subarray(this.bodyLength); this.bodyLength = undefined;
        let value: unknown; try { value = JSON.parse(body.toString("utf8")); } catch { throw protocolError("LSP frame contains invalid JSON."); }
        this.handleEnvelope(parseJsonRpcEnvelope(value));
      }
    } catch (error) { this.fail(error instanceof GodotMcpError ? error : protocolError(error instanceof Error ? error.message : "Invalid LSP message.")); }
  };

  private handleEnvelope(envelope: ReturnType<typeof parseJsonRpcEnvelope>): void {
    if ("method" in envelope && !("id" in envelope)) {
      const event: LspNotification = envelope.params === undefined
        ? { generation: this.currentGeneration, method: envelope.method }
        : { generation: this.currentGeneration, method: envelope.method, params: envelope.params };
      for (const listener of this.notificationListeners) listener(event); return;
    }
    if (!("id" in envelope) || "method" in envelope) return;
    const pending = this.pending.get(envelope.id); if (!pending || pending.generation !== this.currentGeneration) return;
    this.pending.delete(envelope.id); clearTimeout(pending.timer);
    if ("error" in envelope) {
      const error = envelope.error as LspResponseError;
      pending.reject(new GodotMcpError("godot_error", error.message, "Inspect the Godot language server error and correct the request.", { code: error.code, ...(error.data === undefined ? {} : { data: error.data }) }));
    } else pending.resolve(envelope.result);
  }

  private readonly onSocketClose = (): void => this.fail(notConnected());
  private readonly onSocketError = (error: Error): void => this.fail(notConnected(error.message));
  private fail(error: Error): void {
    const socket = this.socket; if (!socket) return;
    this.socket = undefined; socket.off("data", this.onData); socket.off("close", this.onSocketClose); socket.off("error", this.onSocketError);
    this.buffer = Buffer.alloc(0); this.bodyLength = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear();
    for (const listener of this.closedListeners) listener(error);
    if (!this.closing) socket.destroy();
  }
}
