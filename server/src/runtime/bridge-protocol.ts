export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
export const MAX_JSON_BYTES = 128 * 1024;

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(plainJson(value)), "utf8");
  if (body.length === 0 || body.length > MAX_FRAME_BYTES) throw new Error("Runtime bridge frame exceeds bound.");
  const frame = Buffer.allocUnsafe(4 + body.length); frame.writeUInt32BE(body.length); body.copy(frame, 4); return frame;
}

export class FrameDecoder {
  private buffer = Buffer.alloc(0);
  push(chunk: Buffer): unknown[] {
    if (this.buffer.length + chunk.length > MAX_BUFFER_BYTES) throw new Error("Runtime bridge receive buffer exceeds bound.");
    this.buffer = Buffer.concat([this.buffer, chunk]); const output: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length === 0 || length > MAX_FRAME_BYTES || length > MAX_JSON_BYTES) throw new Error("Runtime bridge frame length is invalid.");
      if (this.buffer.length < length + 4) break;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(this.buffer.subarray(4, length + 4)); this.buffer = this.buffer.subarray(length + 4);
      output.push(JSON.parse(text));
    }
    return output;
  }
}

export function plainJson(value: unknown): unknown {
  const seen = new Set<object>(); let nodes = 0;
  const visit = (input: unknown, depth: number): unknown => {
    if (++nodes > 1000) throw new Error("Runtime bridge result exceeds node bound.");
    if (depth > 32) throw new Error("Runtime bridge result exceeds depth bound.");
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") { if (Buffer.byteLength(input, "utf8") > 8192) throw new Error("Runtime bridge string exceeds bound."); return input; }
    if (typeof input === "number") { if (!Number.isFinite(input)) throw new Error("Runtime bridge value must be finite."); return input; }
    if (typeof input !== "object") throw new Error("Invalid bridge result.");
    if (seen.has(input)) throw new Error("Runtime bridge result contains a cycle."); seen.add(input);
    try {
      if (Array.isArray(input)) { if (input.length > 500) throw new Error("Runtime bridge array exceeds bound."); return input.map(item => visit(item, depth + 1)); }
      let descriptors: PropertyDescriptorMap;
      try { descriptors = Object.getOwnPropertyDescriptors(input); } catch { throw new Error("Invalid bridge result object."); }
      const keys = Object.keys(descriptors); if (keys.length > 500) throw new Error("Runtime bridge object keys exceed bound.");
      const output: Record<string, unknown> = Object.create(null);
      for (const key of keys) { const descriptor = descriptors[key]!; if (!("value" in descriptor)) throw new Error("Runtime bridge accepts data property values only."); if (descriptor.enumerable) output[key] = visit(descriptor.value, depth + 1); }
      return output;
    } finally { seen.delete(input); }
  };
  return visit(value, 0);
}
