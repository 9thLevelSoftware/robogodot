import { describe, expect, test, vi } from "vitest";
import { GodotMcpError } from "../src/errors.js";
import { executeEditorScript, validateExecutionPolicy } from "../src/exec/guard.js";

const safe = { source: "func __run(args):\n\treturn args", args: { value: 1 } };

describe("editor execution guard", () => {
  test("blocks every script in read_only mode", () => {
    expect(() => validateExecutionPolicy({ ...safe, mode: "read_only" })).toThrowError(GodotMcpError);
  });

  test("blocks confirm_destructive even when confirmed and points to a mode switch", () => {
    for (const confirmed of [false, true]) {
      expect(() => validateExecutionPolicy({ ...safe, mode: "confirm_destructive", confirmed })).toThrow(/switch.*full/i);
    }
  });

  test("full mode always requires allowDangerous independently of source heuristics", () => {
    expect(() => validateExecutionPolicy({ ...safe, mode: "full" })).toThrow(/allowDangerous/i);
    expect(() => validateExecutionPolicy({ ...safe, mode: "full", allowDangerous: true })).not.toThrow();
    for (const source of ["# OS.execute('x', [])\n" + safe.source, "func __run(args):\n\treturn \"OS.execute\""]) {
      expect(() => validateExecutionPolicy({ source, mode: "full", allowDangerous: true })).not.toThrow();
    }
  });

  test("rejects invalid modes and output caps outside 0..262144", async () => {
    expect(() => validateExecutionPolicy({ ...safe, mode: "invalid" as never, allowDangerous: true })).toThrow(/mode/i);
    const call = vi.fn();
    for (const outputCapBytes of [-1, 262_145, 1.5]) {
      await expect(executeEditorScript({ call }, { ...safe, mode: "full", allowDangerous: true, outputCapBytes })).rejects.toMatchObject({ code: "invalid_args" });
    }
    expect(call).not.toHaveBeenCalled();
  });

  test("uses a 15000 ms response timeout and restart guidance", async () => {
    const call = vi.fn().mockRejectedValue(new GodotMcpError("timeout", "timed out", "old hint"));
    await expect(executeEditorScript({ call }, { ...safe, mode: "full", allowDangerous: true })).rejects.toMatchObject({
      code: "timeout",
      hint: expect.stringMatching(/restart.*editor/i),
    });
    expect(call).toHaveBeenCalledWith("exec.run", expect.any(Object), { timeoutMs: 15_000, maxRequestBytes: 32_768 });
  });

  test("passes the default 262144-byte output cap", async () => {
    const result = { ok: true, returnValue: null, stdout: "", errors: [], elapsedMs: 1, truncated: false };
    const call = vi.fn().mockResolvedValue(result);
    await expect(executeEditorScript({ call }, { ...safe, mode: "full", allowDangerous: true })).resolves.toEqual(result);
    expect(call.mock.calls[0]?.[1]).toMatchObject({ outputCapBytes: 262_144 });
  });
});
