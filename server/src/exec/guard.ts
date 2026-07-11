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
  call<T>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T>;
}

const DANGEROUS_PATTERNS = [
  /\bOS\s*\.\s*(?:execute|execute_with_pipe|create_process)\s*\(/i,
  /\bDirAccess\s*\.\s*(?:remove_absolute|rename_absolute)\s*\(\s*["'](?:res:\/\/|\.\/)?["']/i,
  /\b(?:remove|erase)\s*\(\s*["']res:\/\/["']/i,
] as const;

function blocked(message: string, hint: string): never {
  throw new GodotMcpError("blocked_by_policy", message, hint);
}

export function validateExecutionPolicy(request: EditorScriptRequest): void {
  if (request.mode === "read_only") {
    blocked("Editor-script execution is blocked in read_only mode.", "Switch to confirm_destructive or full mode before executing editor code.");
  }
  if (request.mode === "confirm_destructive" && request.confirmed !== true) {
    blocked("Editor-script execution requires explicit confirmation.", "Confirm this individual request; allowDangerous does not count as confirmation.");
  }
  const dangerous = DANGEROUS_PATTERNS.some((pattern) => pattern.test(request.source));
  if (dangerous && !(request.mode === "full" && request.allowDangerous === true)) {
    blocked("Dangerous shell-out or recursive project deletion source is blocked.", "Dangerous execution requires mode full and allowDangerous true.");
  }
}

export async function executeEditorScript(client: RpcCaller, request: EditorScriptRequest): Promise<EditorExecutionResult> {
  validateExecutionPolicy(request);
  const { mode: _mode, confirmed: _confirmed, allowDangerous: _allowDangerous, ...params } = request;
  try {
    return await client.call<EditorExecutionResult>("exec.run", {
      ...params,
      args: request.args ?? null,
      outputCapBytes: request.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES,
    }, { timeoutMs: EDITOR_EXEC_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof GodotMcpError && error.code === "timeout") {
      throw new GodotMcpError("timeout", "Editor-script execution exceeded the 15000 ms response deadline.",
        "Execution was not cancelled in-process; restart the Godot editor if it remains unresponsive, then reconnect and try again.", error.data);
    }
    throw error;
  }
}
