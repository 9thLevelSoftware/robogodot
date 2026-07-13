import type { Duplex } from "node:stream";
import { GodotMcpError } from "../errors.js";

export const DAP_LIMITS = Object.freeze({
  maxFrameBytes: 1_048_576,
  maxBufferBytes: 2_097_152,
  maxPending: 128,
  defaultRequestMs: 5_000,
  minRequestMs: 1,
  maxRequestMs: 60_000,
});

export interface DapEvent { readonly seq: number; readonly type: "event"; readonly event: string; readonly body?: unknown }
interface DapTransportOptions { maxFrameBytes?: number; maxBufferBytes?: number; maxPending?: number; defaultRequestMs?: number; minRequestMs?: number; maxRequestMs?: number }
interface Options { readonly maxFrameBytes: number; readonly maxBufferBytes: number; readonly maxPending: number; readonly defaultRequestMs: number; readonly minRequestMs: number; readonly maxRequestMs: number }
interface Pending { readonly command: string; readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly timer: NodeJS.Timeout }

const unavailable = (message = "Godot debug adapter is not connected.") => new GodotMcpError("not_connected", message, "Launch a new managed debug session and attach again.");
const invalid = (message: string) => new GodotMcpError("godot_error", message, "Restart the managed debug session with a compatible Godot debug adapter.");

export class DapTransport {
  private socket: Duplex | undefined;
  private buffer = Buffer.alloc(0);
  private bodyLength: number | undefined;
  private nextSeq = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventListeners = new Set<(event: DapEvent) => void>();
  private readonly closedListeners = new Set<(error: Error) => void>();
  private closing = false;
  private readonly options: Options;

  constructor(options: DapTransportOptions = DAP_LIMITS) {
    const normalized = { ...DAP_LIMITS, ...options };
    const values = [normalized.maxFrameBytes, normalized.maxBufferBytes, normalized.maxPending, normalized.defaultRequestMs, normalized.minRequestMs, normalized.maxRequestMs];
    if (values.some((value) => !Number.isSafeInteger(value) || value <= 0) || normalized.maxFrameBytes > normalized.maxBufferBytes || normalized.minRequestMs > normalized.defaultRequestMs || normalized.defaultRequestMs > normalized.maxRequestMs) throw invalid("Invalid DAP transport limits.");
    this.options = Object.freeze(normalized);
  }
  get isAttached(): boolean { return this.socket !== undefined; }
  attach(socket: Duplex): void {
    if (this.socket) this.fail(unavailable("Godot debug adapter connection was replaced."));
    this.socket = socket; this.buffer = Buffer.alloc(0); this.bodyLength = undefined; this.closing = false;
    socket.on("data", this.onData); socket.once("close", this.onClose); socket.once("error", this.onError);
  }
  request<T>(command: string, args?: unknown, timeoutMs = this.options.defaultRequestMs): Promise<T> {
    if (!this.socket) return Promise.reject(unavailable());
    if (this.pending.size >= this.options.maxPending) return Promise.reject(invalid("DAP pending request limit reached."));
    if (!Number.isSafeInteger(this.nextSeq)) return Promise.reject(invalid("DAP request sequence exhausted."));
    const seq = this.nextSeq++;
    let frame: Buffer;
    try { frame = this.frame({ seq, type: "request", command, ...(args === undefined ? {} : { arguments: args }) }); }
    catch (error) { return Promise.reject(error instanceof Error ? error : invalid("DAP request is not serializable.")); }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(seq); reject(new GodotMcpError("timeout", `DAP request ${command} timed out.`, "Retry only while the managed debug session is stopped and connected.")); }, this.deadline(timeoutMs));
      this.pending.set(seq, { command, resolve: resolve as (value: unknown) => void, reject, timer });
      try { this.socket!.write(frame); } catch (error) { this.fail(unavailable(error instanceof Error ? error.message : undefined)); }
    });
  }
  onEvent(listener: (event: DapEvent) => void): () => void { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener); }
  onClosed(listener: (error: Error) => void): () => void { this.closedListeners.add(listener); return () => this.closedListeners.delete(listener); }
  async close(reason: Error = unavailable("Godot debug adapter connection closed.")): Promise<void> { const socket = this.socket; if (!socket) return; this.closing = true; this.fail(reason); socket.destroy(); }

  private deadline(value: number): number { return Math.min(this.options.maxRequestMs, Math.max(this.options.minRequestMs, Number.isFinite(value) ? value : this.options.defaultRequestMs)); }
  private frame(value: unknown): Buffer { let body: Buffer; try { body = Buffer.from(JSON.stringify(value), "utf8"); } catch { throw invalid("DAP request is not serializable."); } if (body.length > this.options.maxFrameBytes) throw invalid("DAP outbound frame exceeds the size limit."); return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]); }
  private readonly onData = (chunk: Buffer | string): void => {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (incoming.length > this.options.maxBufferBytes - this.buffer.length) { this.fail(invalid("DAP receive buffer limit exceeded.")); return; }
    this.buffer = Buffer.concat([this.buffer, incoming]);
    try {
      while (this.socket) {
        if (this.bodyLength === undefined) {
          const end = this.buffer.indexOf("\r\n\r\n"); if (end < 0) return;
          const header = this.buffer.subarray(0, end).toString("ascii"); const lines = header.split("\r\n").filter((line) => /^content-length:/i.test(line));
          if (lines.length !== 1) throw invalid("DAP frame requires exactly one Content-Length header.");
          const raw = lines[0]!.slice(lines[0]!.indexOf(":") + 1).trim(); if (!/^\d+$/.test(raw)) throw invalid("DAP Content-Length must be ASCII decimal digits.");
          const length = Number(raw); if (!Number.isSafeInteger(length) || length > this.options.maxFrameBytes) throw invalid("DAP frame exceeds the size limit.");
          this.bodyLength = length; this.buffer = this.buffer.subarray(end + 4);
        }
        if (this.buffer.length < this.bodyLength) return;
        const body = this.buffer.subarray(0, this.bodyLength); this.buffer = this.buffer.subarray(this.bodyLength); this.bodyLength = undefined;
        let value: unknown; try { value = JSON.parse(body.toString("utf8")); } catch { throw invalid("DAP frame contains invalid JSON."); }
        this.handle(value);
      }
    } catch (error) { this.fail(error instanceof Error ? error : invalid("Invalid DAP message.")); }
  };
  private handle(value: unknown): void {
    if (!record(value) || positiveInteger(value.seq) === undefined || typeof value.type !== "string") throw invalid("DAP envelope is invalid.");
    if (value.type === "event") {
      if (typeof value.event !== "string" || value.event.length === 0) throw invalid("DAP event envelope is invalid.");
      const event: DapEvent = value.body === undefined ? { seq: value.seq as number, type: "event", event: value.event } : { seq: value.seq as number, type: "event", event: value.event, body: value.body };
      for (const listener of this.eventListeners) try { listener(event); } catch { /* isolate subscribers */ }
      return;
    }
    if (value.type !== "response" || positiveInteger(value.request_seq) === undefined || typeof value.success !== "boolean" || typeof value.command !== "string") throw invalid("DAP response envelope is invalid.");
    const pending = this.pending.get(value.request_seq as number); if (!pending) return;
    if (value.command !== pending.command) throw invalid("DAP response command does not match its request.");
    this.pending.delete(value.request_seq as number); clearTimeout(pending.timer);
    if (!value.success) pending.reject(new GodotMcpError("godot_error", typeof value.message === "string" ? value.message : `DAP ${pending.command} failed.`, "Inspect the Godot debug adapter error and correct the request.", value.body));
    else pending.resolve(value.body);
  }
  private readonly onClose = (): void => this.fail(unavailable());
  private readonly onError = (error: Error): void => this.fail(unavailable(error.message));
  private fail(error: Error): void {
    const socket = this.socket; if (!socket) return; this.socket = undefined;
    socket.off("data", this.onData); socket.off("close", this.onClose); socket.off("error", this.onError); this.buffer = Buffer.alloc(0); this.bodyLength = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear();
    for (const listener of this.closedListeners) try { listener(error); } catch { /* isolate subscribers */ }
    if (!this.closing) socket.destroy();
  }
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function positiveInteger(value: unknown): number | undefined { return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined; }
