export const PHASE_1_ERROR_CODES = ["not_connected", "editor_required", "invalid_args", "godot_error", "timeout"] as const;
export type GodotMcpErrorCode = (typeof PHASE_1_ERROR_CODES)[number];

export interface ToolErrorPayload {
  code: GodotMcpErrorCode;
  message: string;
  hint: string;
  data?: unknown;
}

export class GodotMcpError extends Error {
  readonly code: GodotMcpErrorCode;
  readonly hint: string;
  readonly data?: unknown;

  constructor(code: GodotMcpErrorCode, message: string, hint: string, data?: unknown) {
    super(message);
    this.name = "GodotMcpError";
    this.code = code;
    this.hint = hint;
    if (data !== undefined) this.data = data;
  }
}

export function toToolError(error: unknown) {
  const payload: ToolErrorPayload = error instanceof GodotMcpError
    ? { code: error.code, message: error.message, hint: error.hint }
    : { code: "godot_error", message: error instanceof Error ? error.message : "Unknown error", hint: "Check the server stderr log for details." };
  if (error instanceof GodotMcpError && error.data !== undefined) payload.data = error.data;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true as const,
  };
}
