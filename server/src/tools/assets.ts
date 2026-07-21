import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { registerTool } from "../registry.js";
import { GodotMcpError } from "../errors.js";
import type { FsGuard } from "../fs/guard.js";
import type { AssetProvider } from "../assets/provider.js";

export interface AssetToolService {
  guard: FsGuard;
  provider: AssetProvider;
  enabled: boolean;
}

export function registerAssetTools(server: McpServer, service: AssetToolService): void {
  registerTool(server, {
    name: "godot_asset_generate",
    description: "Optionally generate an asset through a configured provider and write it under the project root. Disabled by default.",
    inputSchema: z.object({
      prompt: z.string().min(1).max(2_000),
      path: z.string().min(7).refine((value) => value.startsWith("res://") && Buffer.byteLength(value, "utf8") <= 1024),
      overwrite: z.boolean().optional(),
    }).strict(),
    outputSchema: z.object({ path: z.string(), bytes: z.number().int().nonnegative(), provider: z.string() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    handler: async (input) => {
      if (!service.enabled) {
        throw new GodotMcpError(
          "feature_disabled",
          "Asset generation is not configured.",
          "Set GODOT_MCP_ASSET_PROVIDER=true and register a provider implementation to enable this tool.",
        );
      }
      const resolved = await service.guard.resolveProjectPath(String(input.path));
      try {
        const info = await stat(resolved.abs);
        if (info.isFile() && input.overwrite !== true) {
          throw new GodotMcpError("invalid_args", "Target file already exists.", "Pass overwrite true to replace the asset file.");
        }
      } catch (error) {
        if (error instanceof GodotMcpError) throw error;
      }
      const generated = await service.provider.generate({ prompt: String(input.prompt), targetResPath: resolved.res });
      await mkdir(path.dirname(resolved.abs), { recursive: true });
      await writeFile(resolved.abs, generated.data);
      return { path: resolved.res, bytes: generated.data.byteLength, provider: service.provider.name };
    },
  });
}
