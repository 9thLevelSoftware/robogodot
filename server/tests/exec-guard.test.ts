import { describe, expect, test, vi } from "vitest";
import { GodotMcpError } from "../src/errors.js";
import { executeEditorScript, validateExecutionPolicy } from "../src/exec/guard.js";

const safe = { source: "func __run(args):\n\treturn args", args: { value: 1 } };

describe("editor execution guard", () => {
  test("blocks every script in read_only mode", () => {
    expect(() => validateExecutionPolicy({ ...safe, mode: "read_only" })).toThrowError(GodotMcpError);
  });

  test("requires explicit confirmation in confirm_destructive mode", () => {
    expect(() => validateExecutionPolicy({ ...safe, mode: "confirm_destructive" })).toThrow(/confirmation/i);
    expect(() => validateExecutionPolicy({ ...safe, mode: "confirm_destructive", confirmed: true })).not.toThrow();
  });

  test.each([
    "func __run(args):\n\tOS.execute('cmd', [])",
    "func __run(args):\n\tDirAccess.remove_absolute('res://')",
  ])("blocks dangerous source unless full and allowDangerous are both set", (source) => {
    expect(() => validateExecutionPolicy({ source, mode: "full", allowDangerous: false })).toThrow(/dangerous/i);
    expect(() => validateExecutionPolicy({ source, mode: "confirm_destructive", confirmed: true, allowDangerous: true })).toThrow(/dangerous/i);
    expect(() => validateExecutionPolicy({ source, mode: "full", allowDangerous: true })).not.toThrow();
  });

  test("uses a 15000 ms response timeout and restart guidance", async () => {
    const call = vi.fn().mockRejectedValue(new GodotMcpError("timeout", "timed out", "old hint"));
    await expect(executeEditorScript({ call }, { ...safe, mode: "full" })).rejects.toMatchObject({
      code: "timeout",
      hint: expect.stringMatching(/restart.*editor/i),
    });
    expect(call).toHaveBeenCalledWith("exec.run", expect.any(Object), { timeoutMs: 15_000 });
  });

  test("passes the default 262144-byte output cap", async () => {
    const result = { ok: true, returnValue: null, stdout: "", errors: [], elapsedMs: 1, truncated: false };
    const call = vi.fn().mockResolvedValue(result);
    await expect(executeEditorScript({ call }, { ...safe, mode: "full" })).resolves.toEqual(result);
    expect(call.mock.calls[0]?.[1]).toMatchObject({ outputCapBytes: 262_144 });
  });
});
