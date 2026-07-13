import { describe, expect, it } from "vitest";
import { GodotMcpError, PHASE_1_ERROR_CODES, toToolError } from "../src/errors.js";

describe("GodotMcpError", () => {
  it("supports all five stable Phase 1 codes", () => {
    expect(PHASE_1_ERROR_CODES).toEqual(["not_connected", "editor_required", "invalid_args", "godot_error", "timeout"]);
    for (const code of PHASE_1_ERROR_CODES) expect(new GodotMcpError(code, "message", "hint").code).toBe(code);
  });

  it("converts a typed error to exact JSON text without schema-conflicting structured content", () => {
    const result = toToolError(new GodotMcpError("godot_error", "failed", "inspect output", { exitCode: 1 }));
    const payload = { code: "godot_error", message: "failed", hint: "inspect output", data: { exitCode: 1 } };
    expect(result).toEqual({ content: [{ type: "text", text: JSON.stringify(payload) }], isError: true });
  });

  it("normalizes unknown errors", () => {
    const result = toToolError(new Error("boom")); expect(result.isError).toBe(true); expect((result as any).structuredContent).toBeUndefined(); expect(JSON.parse(result.content[0]!.text)).toEqual({ code: "godot_error", message: "boom", hint: "Check the server stderr log for details." });
  });
});
