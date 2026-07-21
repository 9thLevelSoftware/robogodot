import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { registerTool } from "../registry.js";
import type { FsGuard } from "../fs/guard.js";

export interface UidToolService {
  guard: FsGuard;
}

export function registerUidTools(server: McpServer, service: UidToolService): void {
  registerTool(server, {
    name: "godot_uid_list",
    description: "List a bounded page of Godot .uid sidecar files under the project root.",
    inputSchema: z.object({
      prefix: z.string().max(512).optional(),
      limit: z.number().int().min(1).max(500).default(100),
      cursor: z.string().regex(/^(0|[1-9][0-9]*)$/).max(10).optional(),
    }).strict(),
    outputSchema: z.object({
      uids: z.array(z.object({ path: z.string(), uid: z.string() }).strict()),
      truncated: z.boolean(),
      nextCursor: z.string().optional(),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (input) => {
      const all: Array<{ path: string; uid: string }> = [];
      const prefix = typeof input.prefix === "string" ? input.prefix.replace(/^res:\/\//, "") : "";
      await walk(service.guard.projectRoot, service.guard.projectRoot, all, 0);
      const filtered = all
        .filter((entry) => entry.path.slice("res://".length).startsWith(prefix))
        .sort((a, b) => a.path.localeCompare(b.path));
      const offset = input.cursor ? Number(input.cursor) : 0;
      const limit = typeof input.limit === "number" ? input.limit : 100;
      const page = filtered.slice(offset, offset + limit);
      const next = offset + page.length;
      return {
        uids: page,
        truncated: next < filtered.length,
        ...(next < filtered.length ? { nextCursor: String(next) } : {}),
      };
    },
  });
}

async function walk(root: string, current: string, out: Array<{ path: string; uid: string }>, depth: number): Promise<void> {
  if (depth > 32 || out.length > 5_000) return;
  const base = path.basename(current);
  if (base === ".git" || base === "node_modules") return;
  let entries: string[];
  try { entries = await readdir(current); }
  catch { return; }
  for (const name of entries.sort((a, b) => a.localeCompare(b))) {
    const abs = path.join(current, name);
    let info;
    try { info = await stat(abs); }
    catch { continue; }
    if (info.isDirectory()) {
      await walk(root, abs, out, depth + 1);
      continue;
    }
    if (!name.endsWith(".uid") || !info.isFile()) continue;
    const rel = path.relative(root, abs).split(path.sep).join("/");
    const text = (await readFile(abs, "utf8")).trim().slice(0, 256);
    out.push({ path: `res://${rel}`, uid: text });
  }
}
