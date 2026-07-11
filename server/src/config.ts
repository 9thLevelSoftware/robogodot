import fs from "node:fs";
import path from "node:path";

export type SafetyMode = "full" | "read_only" | "confirm_destructive";

export interface ResolvedConfig {
  godotPath?: string;
  projectPath?: string;
  editorHost: "127.0.0.1";
  editorPort: number;
  lspPort: number;
  dapPort: number;
  mode: SafetyMode;
  debug: boolean;
}

export interface ResolveConfigProbes {
  pathValue?: string;
  isFile?: (candidate: string) => boolean;
  isExecutable?: (candidate: string) => boolean;
}

const WINDOWS_EXECUTABLES = [
  "godot4_console.exe",
  "godot4.exe",
  "godot_console.exe",
  "godot.exe",
];

const UNIX_EXECUTABLES = ["godot4", "godot"];

function readPort(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

function readMode(raw: string | undefined): SafetyMode {
  if (raw === undefined) return "full";
  if (raw === "full" || raw === "read_only" || raw === "confirm_destructive") return raw;
  throw new Error("GODOT_MCP_MODE must be full, read_only, or confirm_destructive");
}

function findProject(cwd: string, isFile: (candidate: string) => boolean): string | undefined {
  let current = path.resolve(cwd);
  while (true) {
    if (isFile(path.join(current, "project.godot"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function findGodot(platform: NodeJS.Platform, pathValue: string, isExecutable: (candidate: string) => boolean): string | undefined {
  const names = platform === "win32" ? WINDOWS_EXECUTABLES : UNIX_EXECUTABLES;
  const delimiter = platform === "win32" ? ";" : ":";
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.normalize(path.join(directory, name));
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

export function resolveConfig(
  env: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform,
  pathValue: string | ResolveConfigProbes = env.PATH ?? "",
): ResolvedConfig {
  const probes = typeof pathValue === "string" ? { pathValue } : pathValue;
  const isFile = probes.isFile ?? ((candidate: string) => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile() === true);
  const isExecutable = probes.isExecutable ?? isFile;
  const discoveredGodot = env.GODOT_PATH === undefined
    ? findGodot(platform, probes.pathValue ?? env.PATH ?? "", isExecutable)
    : undefined;
  const discoveredProject = env.GODOT_PROJECT_PATH === undefined ? findProject(cwd, isFile) : undefined;
  const config: ResolvedConfig = {
    editorHost: "127.0.0.1",
    editorPort: readPort(env, "GODOT_MCP_PORT", 9200),
    lspPort: readPort(env, "GODOT_LSP_PORT", 6005),
    dapPort: readPort(env, "GODOT_DAP_PORT", 6006),
    mode: readMode(env.GODOT_MCP_MODE),
    debug: env.DEBUG === "true" || env.DEBUG === "1",
  };
  const godotPath = env.GODOT_PATH ?? discoveredGodot;
  const projectPath = env.GODOT_PROJECT_PATH ?? discoveredProject;
  if (godotPath !== undefined) config.godotPath = godotPath;
  if (projectPath !== undefined) config.projectPath = projectPath;
  return config;
}
