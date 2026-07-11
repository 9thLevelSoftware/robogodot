import { GodotMcpError } from "../errors.js";

export const EDITOR_EXEC_TIMEOUT_MS = 15_000;
export const DEFAULT_OUTPUT_CAP_BYTES = 262_144;

export type ExecutionMode = "full" | "read_only" | "confirm_destructive";
export interface EditorScriptRequest {
  source: string;
  args?: unknown;
  mode: ExecutionMode;
  confirmed?: boolean;
  allowDangerous?: boolean;
  outputCapBytes?: number;
}
export interface EditorExecutionResult {
  ok: boolean;
  returnValue: unknown;
  stdout: string;
  errors: string[];
  elapsedMs: number;
  truncated: boolean;
}
export interface RpcCaller {
  call<T>(method: string, params?: unknown, options?: { timeoutMs?: number; maxRequestBytes?: number }): Promise<T>;
}

const EXEC_REQUEST_FRAME_CAP_BYTES = 32_768;

function validateExecutionResult(value: unknown): EditorExecutionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GodotMcpError("godot_error", "Godot returned an invalid execution response.", "Check that the Godot plugin and MCP server versions are compatible.");
  const result = value as Record<string, unknown>;
  const keys = Object.keys(result).sort();
  const expected = ["elapsedMs", "errors", "ok", "returnValue", "stdout", "truncated"];
  if (JSON.stringify(keys) !== JSON.stringify(expected)
    || typeof result.ok !== "boolean" || typeof result.stdout !== "string" || typeof result.truncated !== "boolean"
    || typeof result.elapsedMs !== "number" || !Number.isFinite(result.elapsedMs) || result.elapsedMs < 0
    || !Array.isArray(result.errors) || !result.errors.every((entry) => typeof entry === "string")) {
    throw new GodotMcpError("godot_error", "Godot returned an invalid execution response.", "Check that the Godot plugin and MCP server versions are compatible.");
  }
  return value as EditorExecutionResult;
}

function blocked(message: string, hint: string): never {
  throw new GodotMcpError("blocked_by_policy", message, hint);
}

export function validateExecutionPolicy(request: EditorScriptRequest): void {
  if (!(["full", "read_only", "confirm_destructive"] as unknown[]).includes(request.mode)) {
    throw new GodotMcpError("invalid_args", "Invalid execution mode.", "Use read_only, confirm_destructive, or full.");
  }
  if (request.mode === "read_only") {
    blocked("Editor-script execution is blocked in read_only mode.", "Switch to full mode and explicitly set allowDangerous true.");
  }
  if (request.mode === "confirm_destructive") {
    blocked("Editor-script execution is blocked in confirm_destructive mode; switch to full mode.", "Switch to full mode and explicitly set allowDangerous true.");
  }
  if (request.allowDangerous !== true) {
    blocked("Editor-script execution requires allowDangerous true.", "Set allowDangerous true for every execution in full mode after reviewing the source.");
  }
}

export async function executeEditorScript(client: RpcCaller, request: EditorScriptRequest): Promise<EditorExecutionResult> {
  if (request.outputCapBytes !== undefined && (!Number.isInteger(request.outputCapBytes) || request.outputCapBytes < 0 || request.outputCapBytes > DEFAULT_OUTPUT_CAP_BYTES)) {
    throw new GodotMcpError("invalid_args", "outputCapBytes must be an integer from 0 to 262144.", "Reduce outputCapBytes to the supported range.");
  }
  validateExecutionPolicy(request);
  const { mode: _mode, confirmed: _confirmed, allowDangerous: _allowDangerous, ...params } = request;
  try {
    const result = await client.call<unknown>("exec.run", {
      ...params,
      args: request.args ?? null,
      outputCapBytes: request.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES,
    }, { timeoutMs: EDITOR_EXEC_TIMEOUT_MS, maxRequestBytes: EXEC_REQUEST_FRAME_CAP_BYTES });
    return validateExecutionResult(result);
  } catch (error) {
    if (error instanceof GodotMcpError && error.code === "timeout") {
      throw new GodotMcpError("timeout", "Editor-script execution exceeded the 15000 ms response deadline.",
        "Execution was not cancelled in-process; restart the Godot editor if it remains unresponsive, then reconnect and try again.", error.data);
    }
    throw error;
  }
}
