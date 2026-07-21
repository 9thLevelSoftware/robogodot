import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { GodotMcpError } from "../errors.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const OUTPUT_CAP = 262_144;

type ExportChild = Pick<ChildProcess, "stdout" | "stderr" | "once" | "kill">;
type SpawnFn = (command: string, args: string[], options: { cwd: string; windowsHide: true; stdio: ["ignore", "pipe", "pipe"]; shell: false }) => ExportChild;

export interface ExportRequest {
  godotPath: string;
  projectPath: string;
  preset: string;
  outputAbs: string;
  debug?: boolean;
  overwrite?: boolean;
  timeoutMs?: number;
}

export interface ExportResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  output: string;
  elapsedMs: number;
  truncated: boolean;
}

export class ProjectExporter {
  constructor(private readonly spawn: SpawnFn = (command, args, options) => nodeSpawn(command, args, options), private readonly now: () => number = Date.now) {}

  async export(request: ExportRequest): Promise<ExportResult> {
    if (!request.preset.trim() || Buffer.byteLength(request.preset, "utf8") > 256) {
      throw new GodotMcpError("invalid_args", "Export preset must be a nonempty string up to 256 UTF-8 bytes.", "Pass the exact export preset name from export_presets.cfg.");
    }
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new GodotMcpError("invalid_args", `timeoutMs must be an integer from 100 to ${MAX_TIMEOUT_MS}.`, "Choose a timeout in the supported range.");
    }
    try {
      await access(request.outputAbs);
      if (request.overwrite !== true) {
        throw new GodotMcpError("invalid_args", "Export target already exists.", "Pass overwrite true to replace the existing export output.");
      }
    } catch (error) {
      if (error instanceof GodotMcpError) throw error;
      // missing file is fine
    }
    const flag = request.debug ? "--export-debug" : "--export-release";
    const args = ["--headless", "--path", request.projectPath, flag, request.preset, request.outputAbs];
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
      const child = this.spawn(request.godotPath, args, {
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
        output: request.outputAbs,
        elapsedMs: this.now() - started,
        truncated,
      };
    } catch (error) {
      if (error instanceof GodotMcpError) throw error;
      throw new GodotMcpError("godot_error", error instanceof Error ? error.message : "Export process failed.", "Verify the export preset and GODOT_PATH.", error);
    }
  }
}

function waitForExit(child: ExportChild, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
      reject(new GodotMcpError("timeout", `Export exceeded ${timeoutMs} ms.`, "Simplify the export or raise timeoutMs."));
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    });
  });
}
