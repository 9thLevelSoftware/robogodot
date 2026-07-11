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
    expect(target.registrations[0]?.slice(0, 2)).toEqual(["echo", {
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    }]);
  });

  it("rejects duplicate names in the same registry", () => {
    const target = recordingServer();
    const tool = definition(async ({ value }) => ({ echoed: value }));
    registerTool(target.server, tool);
    expect(() => registerTool(target.server, tool)).toThrow('Tool "echo" is already registered');
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
    expect((await typedCallback({ value: "x" })).structuredContent).toEqual({ code: "not_connected", message: "offline", hint: "Start Godot" });

    const unknown = recordingServer();
    registerTool(unknown.server, definition(async () => { throw new Error("boom"); }));
    const unknownCallback = unknown.registrations[0]?.[2] as (input: { value: string }) => Promise<any>;
    expect((await unknownCallback({ value: "x" })).structuredContent.code).toBe("godot_error");
  });
});
