export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
export const MAX_JSON_BYTES = 128 * 1024;

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
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
      const text = this.buffer.subarray(4, length + 4).toString("utf8"); this.buffer = this.buffer.subarray(length + 4);
      output.push(JSON.parse(text));
    }
    return output;
  }
}

export function plainJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("Non-finite bridge result."); return value; }
  if (Array.isArray(value)) return value.map(plainJson);
  if (typeof value !== "object") throw new Error("Invalid bridge result.");
  const output: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value as object)) output[key] = plainJson((value as Record<string, unknown>)[key]);
  return output;
}
