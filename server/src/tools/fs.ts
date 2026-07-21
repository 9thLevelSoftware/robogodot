import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { registerTool } from "../registry.js";
import { GodotMcpError } from "../errors.js";
import type { FsGuard } from "../fs/guard.js";

const MAX_BYTES = 262_144;
const pathInput = z.string().min(1).refine((value) => Buffer.byteLength(value, "utf8") <= 1024, "Path exceeds 1024 UTF-8 bytes.");

export interface FsToolService {
  guard: FsGuard;
}

export function registerFsTools(server: McpServer, service: FsToolService): void {
  registerTool(server, {
    name: "godot_fs_read",
    description: "Read a UTF-8 text file under the project root through the FsGuard realpath jail.",
    inputSchema: z.object({ path: pathInput }).strict(),
    outputSchema: z.object({ path: z.string(), content: z.string(), bytes: z.number().int().nonnegative() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (input) => {
      const resolved = await service.guard.resolveExistingProjectFile(String(input.path));
      const buf = await readFile(resolved.abs);
      if (buf.byteLength > MAX_BYTES) {
        throw new GodotMcpError("invalid_args", "File exceeds 262144 UTF-8 bytes.", "Read a smaller file or split content.");
      }
      return { path: resolved.res, content: buf.toString("utf8"), bytes: buf.byteLength };
    },
  });

  registerTool(server, {
    name: "godot_fs_write",
    description: "Write UTF-8 text under the project root. Existing files require overwrite true. Not Ctrl-Z reversible.",
    inputSchema: z.object({
      path: pathInput,
      content: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= MAX_BYTES, "Content exceeds 262144 UTF-8 bytes."),
      overwrite: z.boolean().optional(),
    }).strict(),
    outputSchema: z.object({ path: z.string(), bytes: z.number().int().nonnegative(), created: z.boolean() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    handler: async (input) => {
      const resolved = await service.guard.resolveProjectPath(String(input.path));
      let created = true;
      try {
        const info = await stat(resolved.abs);
        if (info.isFile()) {
          created = false;
          if (input.overwrite !== true) {
            throw new GodotMcpError("invalid_args", "Target file already exists.", "Pass overwrite true to replace the file.");
          }
        }
      } catch (error) {
        if (error instanceof GodotMcpError) throw error;
      }
      await mkdir(path.dirname(resolved.abs), { recursive: true });
      const content = String(input.content);
      await writeFile(resolved.abs, content, "utf8");
      return { path: resolved.res, bytes: Buffer.byteLength(content, "utf8"), created };
    },
  });

  registerTool(server, {
    name: "godot_fs_list",
    description: "List a bounded directory page under the project root.",
    inputSchema: z.object({
      path: pathInput.default("res://"),
      limit: z.number().int().min(1).max(500).default(100),
      cursor: z.string().regex(/^(0|[1-9][0-9]*)$/).max(10).optional(),
    }).strict(),
    outputSchema: z.object({
      path: z.string(),
      entries: z.array(z.object({ name: z.string(), path: z.string(), type: z.enum(["file", "directory"]) }).strict()),
      truncated: z.boolean(),
      nextCursor: z.string().optional(),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (input) => {
      const resolved = await service.guard.resolveProjectPath(String(input.path ?? "res://"));
      let info;
      try { info = await stat(resolved.abs); }
      catch {
        throw new GodotMcpError("invalid_args", "Directory does not exist.", "Use an existing project directory path.");
      }
      if (!info.isDirectory()) {
        throw new GodotMcpError("invalid_args", "Path is not a directory.", "Pass a directory res:// path.");
      }
      const names = (await readdir(resolved.abs)).sort((a, b) => a.localeCompare(b));
      const offset = input.cursor ? Number(input.cursor) : 0;
      const limit = typeof input.limit === "number" ? input.limit : 100;
      const slice = names.slice(offset, offset + limit);
      const entries = [];
      for (const name of slice) {
        const childAbs = path.join(resolved.abs, name);
        const childStat = await stat(childAbs);
        const childRel = path.relative(service.guard.projectRoot, childAbs).split(path.sep).join("/");
        entries.push({
          name,
          path: childRel === "" ? "res://" : `res://${childRel}`,
          type: childStat.isDirectory() ? "directory" as const : "file" as const,
        });
      }
      const next = offset + slice.length;
      return {
        path: resolved.res,
        entries,
        truncated: next < names.length,
        ...(next < names.length ? { nextCursor: String(next) } : {}),
      };
    },
  });
}
