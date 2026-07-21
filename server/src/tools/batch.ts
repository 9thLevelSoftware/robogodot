import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../registry.js";
import { GodotMcpError } from "../errors.js";
import type { HeadlessRunner } from "../batch/headless.js";
import type { ProjectExporter } from "../batch/export.js";
import type { FsGuard } from "../fs/guard.js";

export interface BatchToolService {
  godotPath?: string;
  projectPath?: string;
  headless: HeadlessRunner;
  exporter: ProjectExporter;
  guard: FsGuard;
}

function requireGodot(service: BatchToolService): { godotPath: string; projectPath: string } {
  if (!service.godotPath || !service.projectPath) {
    throw new GodotMcpError(
      "editor_required",
      "Headless/export tools require GODOT_PATH and GODOT_PROJECT_PATH.",
      "Set both environment variables to a Godot 4.6 binary and project directory.",
    );
  }
  return { godotPath: service.godotPath, projectPath: service.projectPath };
}

export function registerBatchTools(server: McpServer, service: BatchToolService): void {
  registerTool(server, {
    name: "godot_headless_run",
    description: "Run a temporary GDScript via godot --headless --script in the configured project. Isolated child process; not the editor Tier B tool.",
    inputSchema: z.object({
      source: z.string().min(1).max(24_000),
      timeoutMs: z.number().int().min(100).max(120_000).optional(),
    }).strict(),
    outputSchema: z.object({
      ok: z.boolean(),
      exitCode: z.number().nullable(),
      stdout: z.string(),
      stderr: z.string(),
      elapsedMs: z.number().nonnegative(),
      truncated: z.boolean(),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    handler: async (input) => {
      const { godotPath, projectPath } = requireGodot(service);
      const result = await service.headless.run({
        godotPath,
        projectPath,
        source: String(input.source),
        ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
      });
      return {
        ok: result.ok,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        elapsedMs: result.elapsedMs,
        truncated: result.truncated,
      };
    },
  });

  registerTool(server, {
    name: "godot_export_project",
    description: "Export the project with a named preset to an allowed export root (project, session temp, or GODOT_MCP_EXPORT_ROOTS).",
    inputSchema: z.object({
      preset: z.string().min(1).max(256),
      output: z.string().min(1).refine((value) => Buffer.byteLength(value, "utf8") <= 1024),
      debug: z.boolean().optional(),
      overwrite: z.boolean().optional(),
      timeoutMs: z.number().int().min(100).max(300_000).optional(),
    }).strict(),
    outputSchema: z.object({
      ok: z.boolean(),
      exitCode: z.number().nullable(),
      output: z.string(),
      stdout: z.string(),
      stderr: z.string(),
      elapsedMs: z.number().nonnegative(),
      truncated: z.boolean(),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: async (input) => {
      const { godotPath, projectPath } = requireGodot(service);
      const target = await service.guard.resolveExportPath(String(input.output));
      const result = await service.exporter.export({
        godotPath,
        projectPath,
        preset: String(input.preset),
        outputAbs: target.abs,
        ...(input.debug !== undefined ? { debug: Boolean(input.debug) } : {}),
        ...(input.overwrite !== undefined ? { overwrite: Boolean(input.overwrite) } : {}),
        ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
      });
      return {
        ok: result.ok,
        exitCode: result.exitCode,
        output: result.output,
        stdout: result.stdout,
        stderr: result.stderr,
        elapsedMs: result.elapsedMs,
        truncated: result.truncated,
      };
    },
  });
}
