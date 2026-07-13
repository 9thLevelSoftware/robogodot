import {
  MAX_OUTPUT_BYTES, MAX_OUTPUT_LINE_BYTES, MAX_OUTPUT_PAGE_RECORDS,
  MAX_OUTPUT_RECORDS, MIN_OUTPUT_PAGE_RECORDS,
} from "./limits.js";

export type OutputStream = "stdout" | "stderr";
export interface OutputRecord { cursor: number; stream: OutputStream; at: number; text: string; truncated: boolean }
export interface OutputPage { records: OutputRecord[]; next: number; lost: number; truncated: boolean }
export interface OutputRingOptions { maxRecords?: number; maxBytes?: number; maxLineBytes?: number }

interface Partial { bytes: number[]; truncated: boolean }

export class OutputRing {
  private readonly maxRecords: number;
  private readonly maxBytes: number;
  private readonly maxLineBytes: number;
  private readonly partials: Record<OutputStream, Partial> = {
    stdout: { bytes: [], truncated: false }, stderr: { bytes: [], truncated: false },
  };
  private records: Array<OutputRecord & { bytes: number }> = [];
  private retainedBytes = 0;
  private cursor = 0;

  constructor(options: OutputRingOptions = {}) {
    this.maxRecords = positive(options.maxRecords ?? MAX_OUTPUT_RECORDS, "maxRecords");
    this.maxBytes = positive(options.maxBytes ?? MAX_OUTPUT_BYTES, "maxBytes");
    this.maxLineBytes = positive(options.maxLineBytes ?? MAX_OUTPUT_LINE_BYTES, "maxLineBytes");
  }

  append(stream: OutputStream, chunk: Uint8Array, at = Date.now()): void {
    const partial = this.partials[stream];
    for (const byte of chunk) {
      if (byte === 0x0a) {
        if (partial.bytes.at(-1) === 0x0d) partial.bytes.pop();
        this.commit(stream, partial, at);
      } else if (partial.bytes.length < this.maxLineBytes) {
        partial.bytes.push(byte);
      } else {
        partial.truncated = true;
      }
    }
  }

  finish(stream: OutputStream, at = Date.now()): void {
    const partial = this.partials[stream];
    if (partial.bytes.length > 0 || partial.truncated) this.commit(stream, partial, at);
  }

  finishAll(at = Date.now()): void { this.finish("stdout", at); this.finish("stderr", at); }

  read(since: number, limit: number): OutputPage {
    if (!Number.isSafeInteger(since) || since < 0) throw new RangeError("since must be a non-negative safe integer");
    if (!Number.isSafeInteger(limit) || limit < MIN_OUTPUT_PAGE_RECORDS || limit > MAX_OUTPUT_PAGE_RECORDS) {
      throw new RangeError(`limit must be ${MIN_OUTPUT_PAGE_RECORDS}-${MAX_OUTPUT_PAGE_RECORDS}`);
    }
    const available = Math.min(since, this.cursor);
    const first = this.records[0]?.cursor ?? this.cursor;
    const lost = Math.max(0, first - available);
    const start = Math.max(available, first);
    const candidates = this.records.filter((record) => record.cursor >= start);
    const selected = candidates.slice(0, limit);
    return {
      records: selected.map(({ bytes: _bytes, ...record }) => record),
      next: selected.length > 0 ? selected[selected.length - 1]!.cursor + 1 : this.cursor,
      lost,
      truncated: candidates.length > selected.length,
    };
  }

  private commit(stream: OutputStream, partial: Partial, at: number): void {
    const bytes = Uint8Array.from(partial.bytes);
    let invalid = false;
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { invalid = true; }
    const text = new TextDecoder("utf-8").decode(bytes);
    const size = Buffer.byteLength(text);
    this.records.push({ cursor: this.cursor++, stream, at, text, truncated: partial.truncated || invalid, bytes: size });
    this.retainedBytes += size;
    partial.bytes = []; partial.truncated = false;
    while (this.records.length > this.maxRecords || this.retainedBytes > this.maxBytes) {
      const removed = this.records.shift();
      if (removed) this.retainedBytes -= removed.bytes;
    }
  }
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}
