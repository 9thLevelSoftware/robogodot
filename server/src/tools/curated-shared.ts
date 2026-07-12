import type { z } from "zod";
import { GodotMcpError } from "../errors.js";

interface CuratedBridge {
  call<T>(method: string, params?: unknown, options?: { timeoutMs?: number; maxRequestBytes?: number }): Promise<T>;
}

export async function callCurated<T>(
  bridge: CuratedBridge,
  method: string,
  params: unknown,
  responseSchema: z.ZodType<T>,
): Promise<T> {
  const result = await bridge.call<unknown>(method, params, { timeoutMs: 15_000, maxRequestBytes: 32_768 });
  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch {
    throw invalidResponse(method);
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > 262_144) {
    throw invalidResponse(method);
  }
  const parsed = responseSchema.safeParse(result);
  if (!parsed.success) throw invalidResponse(method);
  return parsed.data;
}

function invalidResponse(method: string): GodotMcpError {
  return new GodotMcpError(
    "godot_error",
    `Godot returned an invalid or oversized response for '${method}'.`,
    "Check that the Godot plugin and MCP server versions are compatible.",
  );
}
