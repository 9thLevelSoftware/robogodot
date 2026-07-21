import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GodotMcpError } from "../src/errors.js";
import { registerTool } from "../src/registry.js";

const definition = (handler: (input: { value: string }) => Promise<{ echoed: string }>) => ({
  name: "echo",
  description: "Echo a value",
  inputSchema: z.object({ value: z.string() }),
  outputSchema: z.object({ echoed: z.string() }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler,
});

function recordingServer() {
  const registrations: unknown[][] = [];
  return { registrations, server: { registerTool: (...args: unknown[]) => registrations.push(args) } };
}

describe("registerTool", () => {
  it("forwards schemas, description, and all annotations", () => {
    const target = recordingServer();
    const tool = definition(async ({ value }) => ({ echoed: value }));
    registerTool(target.server, tool);
    const [name, meta] = target.registrations[0] as [string, { description: string; inputSchema: z.ZodObject; outputSchema: z.ZodType; annotations: unknown }];
    expect(name).toBe("echo");
    expect(meta.description).toBe(tool.description);
    expect(meta.outputSchema).toBe(tool.outputSchema);
    expect(meta.annotations).toEqual(tool.annotations);
    expect(meta.inputSchema.safeParse({ value: "x" }).success).toBe(true);
    expect(meta.inputSchema.safeParse({ value: "x", confirmed: true }).success).toBe(true);
    expect(meta.inputSchema.safeParse({ value: "x", extra: 1 }).success).toBe(false);
  });

  it("rejects duplicate names in the same registry", () => {
    const target = recordingServer();
    const tool = definition(async ({ value }) => ({ echoed: value }));
    registerTool(target.server, tool);
    expect(() => registerTool(target.server, tool)).toThrow('Tool "echo" is already registered');
  });

  it("allows retrying a name when the SDK registration throws", () => {
    let attempts = 0;
    const server = {
      registerTool: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("SDK registration failed");
      },
    };
    const tool = definition(async ({ value }) => ({ echoed: value }));
    expect(() => registerTool(server, tool)).toThrow("SDK registration failed");
    expect(() => registerTool(server, tool)).not.toThrow();
    expect(attempts).toBe(2);
  });

  it("returns matching JSON text and structured content", async () => {
    const target = recordingServer();
    registerTool(target.server, definition(async ({ value }) => ({ echoed: value })));
    const callback = target.registrations[0]?.[2] as (input: { value: string }) => Promise<unknown>;
    expect(await callback({ value: "hello" })).toEqual({
      content: [{ type: "text", text: JSON.stringify({ echoed: "hello" }) }],
      structuredContent: { echoed: "hello" },
    });
  });

  it("converts typed and unknown handler failures to actionable tool errors", async () => {
    const typed = recordingServer();
    registerTool(typed.server, definition(async () => { throw new GodotMcpError("not_connected", "offline", "Start Godot"); }));
    const typedCallback = typed.registrations[0]?.[2] as (input: { value: string }) => Promise<any>;
    const typedResult = await typedCallback({ value: "x" }); expect(typedResult.isError).toBe(true); expect(typedResult.structuredContent).toBeUndefined(); expect(JSON.parse(typedResult.content[0].text)).toEqual({ code: "not_connected", message: "offline", hint: "Start Godot" });

    const unknown = recordingServer();
    registerTool(unknown.server, definition(async () => { throw new Error("boom"); }));
    const unknownCallback = unknown.registrations[0]?.[2] as (input: { value: string }) => Promise<any>;
    const unknownResult = await unknownCallback({ value: "x" }); expect(JSON.parse(unknownResult.content[0].text).code).toBe("godot_error"); expect(unknownResult.structuredContent).toBeUndefined();
  });
});
