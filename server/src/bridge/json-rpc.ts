export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: number; result: unknown }
  | { jsonrpc: "2.0"; id: number; error: JsonRpcErrorObject };

export function serializeJsonRpcRequest(id: number, method: string, params?: unknown): string {
  const request: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (params !== undefined) request.params = params;
  return JSON.stringify(request);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonRpcResponse(text: string): JsonRpcResponse | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!isObject(value) || value.jsonrpc !== "2.0" || typeof value.id !== "number" || !Number.isFinite(value.id)) return undefined;
  const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
  const hasError = Object.prototype.hasOwnProperty.call(value, "error");
  if (hasResult === hasError) return undefined;
  if (hasResult) return { jsonrpc: "2.0", id: value.id, result: value.result };
  if (!isObject(value.error) || typeof value.error.code !== "number" || !Number.isFinite(value.error.code) || typeof value.error.message !== "string") return undefined;
  const error: JsonRpcErrorObject = { code: value.error.code, message: value.error.message };
  if (Object.prototype.hasOwnProperty.call(value.error, "data")) error.data = value.error.data;
  return { jsonrpc: "2.0", id: value.id, error };
}
