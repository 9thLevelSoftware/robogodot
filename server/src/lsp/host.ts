import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { connect } from "node:net";
import { GodotMcpError } from "../errors.js";

export type LspOwnership = "attached" | "owned";
type HostChild = Pick<ChildProcess, "once" | "off" | "kill" | "stdout" | "stderr">;
export interface LspHostConfig { lspPort: number; lspAutoStart: boolean; godotPath?: string; projectPath?: string }
export interface LspHostDependencies {
  probe?: (host: "127.0.0.1", port: number, deadlineMs: number) => Promise<boolean>;
  spawn?: (command: string, args: string[], options: { stdio: ["ignore", "pipe", "pipe"]; windowsHide: true }) => HostChild;
  terminate?: (child: HostChild) => Promise<void>;
  delay?: (milliseconds: number) => Promise<void>;
  validatePaths?: (godotPath: string, projectPath: string) => Promise<void>;
}

const OUTPUT_LIMIT = 16_384;
const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const append = (current: Buffer, chunk: unknown): Buffer => Buffer.concat([current, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]).subarray(-OUTPUT_LIMIT);

async function probe(host: "127.0.0.1", port: number, deadlineMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, host);
    let done = false;
    const finish = (answer: boolean) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(answer); };
    const timer = setTimeout(() => finish(false), deadlineMs);
    socket.once("connect", () => finish(true)); socket.once("error", () => finish(false));
  });
}

async function validatePaths(godotPath: string, projectPath: string): Promise<void> {
  const [executable, project] = await Promise.all([stat(godotPath), stat(projectPath)]);
  if (!executable.isFile()) throw new Error(`GODOT_PATH is not a file: ${godotPath}`);
  if (!project.isDirectory()) throw new Error(`GODOT_PROJECT_PATH is not a directory: ${projectPath}`);
}

async function terminate(child: HostChild): Promise<void> {
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  if (await Promise.race([exited.then(() => true), delay(5_000).then(() => false)])) return;
  child.kill("SIGKILL");
  await Promise.race([exited, delay(2_000)]);
}

function display(value: string): string { return `"${value.replaceAll('"', '\\"').replaceAll("\r", "\\r").replaceAll("\n", "\\n")}"`; }

export class LspHost {
  ownership: LspOwnership | undefined;
  private ownedChild: HostChild | undefined;
  private stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private ensuring: Promise<LspOwnership> | undefined;
  private closing: Promise<void> | undefined;
  private readonly deps: Required<LspHostDependencies>;

  constructor(private readonly config: LspHostConfig, dependencies: LspHostDependencies = {}) {
    this.deps = {
      probe: dependencies.probe ?? probe,
      spawn: dependencies.spawn ?? ((command, args, options) => nodeSpawn(command, args, options)),
      terminate: dependencies.terminate ?? terminate,
      delay: dependencies.delay ?? delay,
      validatePaths: dependencies.validatePaths ?? validatePaths,
    };
  }

  ensureAvailable(): Promise<LspOwnership> {
    if (this.ownership) return Promise.resolve(this.ownership);
    if (!this.ensuring) this.ensuring = this.performEnsure().catch((error) => { this.ensuring = undefined; throw error; });
    return this.ensuring;
  }

  diagnostics() { return { ownership: this.ownership, stdout: this.stdout.toString("utf8"), stderr: this.stderr.toString("utf8") }; }

  close(): Promise<void> {
    if (!this.closing) this.closing = this.performClose();
    return this.closing;
  }

  private async performEnsure(): Promise<LspOwnership> {
    if (await this.deps.probe("127.0.0.1", this.config.lspPort, 500)) return this.ownership = "attached";
    const godotPath = this.config.godotPath;
    const projectPath = this.config.projectPath;
    const command = `${display(godotPath ?? "<GODOT_PATH>")} --editor --headless --lsp-port ${this.config.lspPort} --path ${display(projectPath ?? "<GODOT_PROJECT_PATH>")}`;
    if (!this.config.lspAutoStart) throw new GodotMcpError("not_connected", "Godot language server is not reachable.", `Start it with: ${command}`);
    if (!godotPath) throw new Error("GODOT_PATH is required when GODOT_MCP_LSP_AUTO_START is enabled");
    if (!projectPath) throw new Error("GODOT_PROJECT_PATH is required when GODOT_MCP_LSP_AUTO_START is enabled");
    await this.deps.validatePaths(godotPath, projectPath);
    const child = this.deps.spawn(godotPath, ["--editor", "--headless", "--lsp-port", String(this.config.lspPort), "--path", projectPath], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.ownedChild = child;
    child.stdout?.on("data", (chunk) => { this.stdout = append(this.stdout, chunk); });
    child.stderr?.on("data", (chunk) => { this.stderr = append(this.stderr, chunk); });
    let failure: Error | undefined;
    child.once("error", (error: Error) => { failure = error; });
    child.once("exit", (code, signal) => { failure ??= new Error(`Godot LSP host exited before startup (code ${String(code)}, signal ${String(signal)})`); });
    // Each attempt can consume the 500 ms probe deadline plus the 50 ms interval.
    for (let elapsed = 0; elapsed < 15_000; elapsed += 550) {
      if (failure) {
        if (await this.deps.probe("127.0.0.1", this.config.lspPort, 500)) { this.ownedChild = undefined; return this.ownership = "attached"; }
        this.ownedChild = undefined;
        try { await this.deps.terminate(child); } catch { /* preserve the startup failure */ }
        throw failure;
      }
      if (await this.deps.probe("127.0.0.1", this.config.lspPort, 500)) return this.ownership = "owned";
      await this.deps.delay(50);
    }
    const timeout = new GodotMcpError("timeout", "Godot language server did not start within 15 seconds.", "Check the captured host diagnostics and Godot project path.", this.diagnostics());
    this.ownedChild = undefined;
    try { await this.deps.terminate(child); } catch { /* preserve the startup timeout */ }
    throw timeout;
  }

  private async performClose(): Promise<void> {
    const child = this.ownedChild; this.ownedChild = undefined;
    if (child) await this.deps.terminate(child);
  }
}
