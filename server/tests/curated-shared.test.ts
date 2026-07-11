import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { GodotMcpError } from "../src/errors.js";
import { callCurated } from "../src/tools/curated-shared.js";

describe("callCurated", () => {
  test("uses the authenticated frame and timeout bounds", async () => {
    const call = vi.fn().mockResolvedValue({ ok: true });
    await callCurated({ call }, "edit.probe", { value: 1 }, z.object({ ok: z.literal(true) }).strict());
    expect(call).toHaveBeenCalledWith("edit.probe", { value: 1 }, { timeoutMs: 15_000, maxRequestBytes: 32_768 });
  });

  test("rejects malformed responses as Godot errors", async () => {
    const schema = z.object({ ok: z.literal(true) }).strict();
    await expect(callCurated({ call: vi.fn().mockResolvedValue({ ok: false }) }, "edit.probe", {}, schema))
      .rejects.toMatchObject<Partial<GodotMcpError>>({ code: "godot_error" });
  });

  test("rejects responses over 262144 serialized bytes", async () => {
    const schema = z.object({ value: z.string() }).strict();
    await expect(callCurated({ call: vi.fn().mockResolvedValue({ value: "x".repeat(262_144) }) }, "edit.probe", {}, schema))
      .rejects.toMatchObject<Partial<GodotMcpError>>({ code: "godot_error" });
  });
});
