export const LSP_LIMITS = {
  maxFrameBytes: 1_048_576,
  maxBufferBytes: 2_097_152,
  maxPending: 128,
  defaultRequestMs: 5_000,
  minRequestMs: 100,
  maxRequestMs: 15_000,
} as const;

export interface LspNotification { generation: number; method: string; params?: unknown }
export interface LspResponseError { code: number; message: string; data?: unknown }
export type LspCapability = "completion" | "hover" | "signatureHelp" | "documentSymbols" | "workspaceSymbols" | "nativeSymbol";
export interface LspReadyState {
  generation: number;
  serverInfo?: { name: string; version?: string };
  capabilities: Record<string, unknown>;
}
export type JsonRpcEnvelope =
  | { jsonrpc: "2.0"; id: number; method: string; params?: unknown }
  | { jsonrpc: "2.0"; method: string; params?: unknown }
  | { jsonrpc: "2.0"; id: number; result: unknown }
  | { jsonrpc: "2.0"; id: number; error: LspResponseError };

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonRpcEnvelope(value: unknown): JsonRpcEnvelope {
  if (!record(value) || value.jsonrpc !== "2.0") throw new Error("Invalid JSON-RPC envelope.");
  const hasId = Object.hasOwn(value, "id");
  const hasMethod = Object.hasOwn(value, "method");
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasMethod) {
    if (typeof value.method !== "string" || (hasId && typeof value.id !== "number") || hasResult || hasError) throw new Error("Invalid JSON-RPC request.");
    return value as JsonRpcEnvelope;
  }
  if (!hasId || typeof value.id !== "number" || hasResult === hasError) throw new Error("Invalid JSON-RPC response.");
  if (hasError) {
    if (!record(value.error) || typeof value.error.code !== "number" || typeof value.error.message !== "string") throw new Error("Invalid JSON-RPC error.");
  }
  return value as JsonRpcEnvelope;
}
