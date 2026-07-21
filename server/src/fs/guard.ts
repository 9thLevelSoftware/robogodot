import { realpath, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { GodotMcpError } from "../errors.js";

const MAX_PATH_BYTES = 1_024;

export interface ResolvedProjectPath {
  abs: string;
  res: string;
  relative: string;
}

export interface ResolvedExportPath {
  abs: string;
  root: string;
}

export class FsGuard {
  readonly projectRoot: string;
  readonly exportRoots: readonly string[];
  private readonly projectRootReal: string;
  private readonly exportRootsReal: string[];

  private constructor(projectRootReal: string, exportRootsReal: string[]) {
    this.projectRoot = projectRootReal;
    this.projectRootReal = projectRootReal;
    this.exportRoots = exportRootsReal;
    this.exportRootsReal = exportRootsReal;
  }

  static async create(projectRoot: string, exportRoots: readonly string[] = []): Promise<FsGuard> {
    const projectRootReal = await realpath(projectRoot);
    const exportRootsReal: string[] = [projectRootReal];
    for (const root of exportRoots) {
      try {
        const resolved = await realpath(root);
        if (!exportRootsReal.includes(resolved)) exportRootsReal.push(resolved);
      } catch {
        throw new GodotMcpError(
          "invalid_args",
          `Export root does not exist: ${root}`,
          "Create the directory or fix GODOT_MCP_EXPORT_ROOTS.",
        );
      }
    }
    return new FsGuard(projectRootReal, exportRootsReal);
  }

  /** Ensure a directory is an allowed export root (creates session roots). */
  async ensureExportRoot(absDir: string): Promise<string> {
    await mkdir(absDir, { recursive: true });
    const real = await realpath(absDir);
    if (!this.exportRootsReal.includes(real)) this.exportRootsReal.push(real);
    return real;
  }

  async resolveProjectPath(input: string): Promise<ResolvedProjectPath> {
    assertPathBudget(input);
    const relative = toProjectRelative(input);
    if (relative === undefined) {
      throw new GodotMcpError(
        "invalid_args",
        "Path must be a project-relative res:// or relative path without traversal.",
        "Use res://folder/file.ext with no '..' segments or backslashes.",
      );
    }
    const absCandidate = path.resolve(this.projectRootReal, ...relative.split("/"));
    const parent = path.dirname(absCandidate);
    let parentReal: string;
    try {
      parentReal = await realpath(parent);
    } catch {
      throw new GodotMcpError(
        "invalid_args",
        `Parent directory does not exist for path '${input}'.`,
        "Create intermediate directories inside the project root first.",
      );
    }
    if (!isInside(parentReal, this.projectRootReal)) {
      throw escapeError(input);
    }
    let abs = absCandidate;
    try {
      abs = await realpath(absCandidate);
    } catch {
      // File may not exist yet (writes); keep candidate if parent is jailed.
      abs = path.join(parentReal, path.basename(absCandidate));
    }
    if (!isInside(abs, this.projectRootReal) && abs !== this.projectRootReal) {
      throw escapeError(input);
    }
    const rel = path.relative(this.projectRootReal, abs).split(path.sep).join("/");
    return { abs, relative: rel, res: rel === "" ? "res://" : `res://${rel}` };
  }

  async resolveExistingProjectFile(input: string): Promise<ResolvedProjectPath> {
    const resolved = await this.resolveProjectPath(input);
    try {
      const info = await stat(resolved.abs);
      if (!info.isFile()) {
        throw new GodotMcpError("invalid_args", "Path is not a regular file.", "Point at a file under the project root.");
      }
    } catch (error) {
      if (error instanceof GodotMcpError) throw error;
      throw new GodotMcpError("invalid_args", `File does not exist: ${input}`, "Use an existing project-relative path.");
    }
    return resolved;
  }

  async resolveExportPath(input: string): Promise<ResolvedExportPath> {
    assertPathBudget(input);
    const absCandidate = path.isAbsolute(input) ? path.normalize(input) : path.resolve(this.projectRootReal, input);
    const parent = path.dirname(absCandidate);
    await mkdir(parent, { recursive: true });
    const parentReal = await realpath(parent);
    const abs = path.join(parentReal, path.basename(absCandidate));
    const root = this.exportRootsReal.find((candidate) => isInside(abs, candidate) || abs === candidate || isInside(parentReal, candidate));
    if (root === undefined) {
      throw new GodotMcpError(
        "invalid_args",
        "Export path is outside allowed export roots.",
        "Use a path under the project root, the session export directory, or GODOT_MCP_EXPORT_ROOTS.",
      );
    }
    return { abs, root };
  }
}

function assertPathBudget(value: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES) {
    throw new GodotMcpError("invalid_args", "Path exceeds 1024 UTF-8 bytes.", "Shorten the path.");
  }
  if (value.includes("\0")) {
    throw new GodotMcpError("invalid_args", "Path must not contain NUL bytes.", "Remove invalid characters.");
  }
}

function toProjectRelative(input: string): string | undefined {
  let value = input.trim();
  if (value.includes("\\")) return undefined;
  if (value.startsWith("res://")) value = value.slice("res://".length);
  if (value.startsWith("/")) return undefined;
  if (value === "" || value === ".") return "";
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return undefined;
  return parts.join("/");
}

function isInside(abs: string, root: string): boolean {
  const rel = path.relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function escapeError(input: string): GodotMcpError {
  return new GodotMcpError(
    "invalid_args",
    `Path escapes the project root: ${input}`,
    "Stay under the configured GODOT_PROJECT_PATH after realpath resolution.",
  );
}
