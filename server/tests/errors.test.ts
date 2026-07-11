import { describe, expect, it } from "vitest";
import { GodotMcpError, PHASE_1_ERROR_CODES, toToolError } from "../src/errors.js";

describe("GodotMcpError", () => {
  it("supports all five stable Phase 1 codes", () => {
    expect(PHASE_1_ERROR_CODES).toEqual(["not_connected", "editor_required", "invalid_args", "godot_error", "timeout"]);
    for (const code of PHASE_1_ERROR_CODES) expect(new GodotMcpError(code, "message", "hint").code).toBe(code);
  });

  it("converts a typed error to MCP structured and text content", () => {
    const result = toToolError(new GodotMcpError("godot_error", "failed", "inspect output", { exitCode: 1 }));
    const payload = { code: "godot_error", message: "failed", hint: "inspect output", data: { exitCode: 1 } };
    expect(result).toEqual({ content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true });
  });

  it("normalizes unknown errors", () => {
    expect(toToolError(new Error("boom")).structuredContent).toEqual({ code: "godot_error", message: "boom", hint: "Check the server stderr log for details." });
  });
});
