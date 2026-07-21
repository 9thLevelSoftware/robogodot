import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GodotMcpError } from "../errors.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const OUTPUT_CAP = 262_144;

type HeadlessChild = Pick<ChildProcess, "stdout" | "stderr" | "on" | "once" | "kill" | "pid">;
type SpawnFn = (command: string, args: string[], options: { cwd: string; windowsHide: true; stdio: ["ignore", "pipe", "pipe"]; shell: false }) => HeadlessChild;

export interface HeadlessRunRequest {
  godotPath: string;
  projectPath: string;
  source: string;
  timeoutMs?: number;
}

export interface HeadlessRunResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  truncated: boolean;
  scriptPath: string;
}

export interface HeadlessRunnerDependencies {
  spawn?: SpawnFn;
  now?: () => number;
}

export class HeadlessRunner {
  private readonly spawn: SpawnFn;
  private readonly now: () => number;

  constructor(deps: HeadlessRunnerDependencies = {}) {
    this.spawn = deps.spawn ?? ((command, args, options) => nodeSpawn(command, args, options));
    this.now = deps.now ?? Date.now;
  }

  async run(request: HeadlessRunRequest): Promise<HeadlessRunResult> {
    if (!request.source.trim()) {
      throw new GodotMcpError("invalid_args", "Headless source must be a nonempty GDScript string.", "Provide a complete script with a runnable entry.");
    }
    if (Buffer.byteLength(request.source, "utf8") > 24_000) {
      throw new GodotMcpError("invalid_args", "Headless source exceeds 24000 UTF-8 bytes.", "Reduce the script size.");
    }
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new GodotMcpError("invalid_args", `timeoutMs must be an integer from 100 to ${MAX_TIMEOUT_MS}.`, "Choose a timeout in the supported range.");
    }
    const dir = path.join(request.projectPath, ".godot", "mcp-headless");
    await mkdir(dir, { recursive: true });
    const scriptPath = path.join(dir, `${randomUUID()}.gd`);
    await writeFile(scriptPath, request.source, "utf8");
    const started = this.now();
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let truncated = false;
    const append = (current: Buffer, chunk: unknown): Buffer => {
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const next = Buffer.concat([current, piece]);
      if (next.length > OUTPUT_CAP) {
        truncated = true;
        return Buffer.from(next.subarray(next.length - OUTPUT_CAP));
      }
      return Buffer.from(next);
    };
    try {
      const child = this.spawn(request.godotPath, ["--headless", "--path", request.projectPath, "--script", scriptPath], {
        cwd: request.projectPath, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], shell: false,
      });
      child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
      child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
      const exitCode = await waitForExit(child, timeoutMs);
      return {
        ok: exitCode === 0,
        exitCode,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        elapsedMs: this.now() - started,
        truncated,
        scriptPath,
      };
    } catch (error) {
      if (error instanceof GodotMcpError) throw error;
      throw new GodotMcpError(
        "godot_error",
        error instanceof Error ? error.message : "Headless Godot process failed.",
        "Verify GODOT_PATH, the project path, and the script source.",
        error,
      );
    } finally {
      await rm(scriptPath, { force: true }).catch(() => undefined);
    }
  }
}

function waitForExit(child: HeadlessChild, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
      reject(new GodotMcpError("timeout", `Headless Godot exceeded ${timeoutMs} ms.`, "Simplify the script or raise timeoutMs within the allowed range."));
    }, timeoutMs);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => finish(code));
  });
}
