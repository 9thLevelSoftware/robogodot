import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
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
  const projectFile = path.join(projectPath, "project.godot");
  const [executable, project, marker] = await Promise.all([stat(godotPath), stat(projectPath), stat(projectFile)]);
  if (!executable.isFile()) throw new Error(`GODOT_PATH is not a file: ${godotPath}`);
  if (!project.isDirectory()) throw new Error(`GODOT_PROJECT_PATH is not a directory: ${projectPath}`);
  if (!marker.isFile()) throw new Error(`GODOT_PROJECT_PATH must contain a regular project.godot: ${projectFile}`);
  if (process.platform !== "win32") await access(godotPath, constants.X_OK);
}

async function terminate(child: HostChild): Promise<void> {
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
  const onExit = () => resolveExit();
  child.once("exit", onExit);
  try {
    child.kill("SIGTERM");
    if (await Promise.race([exited.then(() => true), delay(5_000).then(() => false)])) return;
    child.kill("SIGKILL");
    await Promise.race([exited, delay(2_000)]);
  } finally { child.off("exit", onExit); }
}

function display(value: string): string { return `"${value.replaceAll('"', '\\"').replaceAll("\r", "\\r").replaceAll("\n", "\\n")}"`; }

export class LspHost {
  ownership: LspOwnership | undefined;
  private ownedChild: HostChild | undefined;
  private stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private ensuring: Promise<LspOwnership> | undefined;
  private closing: Promise<void> | undefined;
  private state: "open" | "closing" | "closed" = "open";
  private ownedListeners: { child: HostChild; detach: () => void } | undefined;
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
    if (this.state !== "open") return Promise.reject(this.closedError());
    if (this.ownership) return Promise.resolve(this.ownership);
    if (!this.ensuring) {
      const attempt = this.performEnsure();
      this.ensuring = attempt;
      const clear = () => { if (this.ensuring === attempt) this.ensuring = undefined; };
      void attempt.then(clear, clear);
    }
    return this.ensuring;
  }

  diagnostics() { return { ownership: this.ownership, stdout: this.stdout.toString("utf8"), stderr: this.stderr.toString("utf8") }; }

  close(): Promise<void> {
    if (!this.closing) {
      this.state = "closing";
      this.closing = this.performClose();
    }
    return this.closing;
  }

  private async performEnsure(): Promise<LspOwnership> {
    if (await this.deps.probe("127.0.0.1", this.config.lspPort, 500)) { this.assertOpen(); return this.ownership = "attached"; }
    this.assertOpen();
    const godotPath = this.config.godotPath;
    const projectPath = this.config.projectPath;
    const command = `${display(godotPath ?? "<GODOT_PATH>")} --editor --headless --lsp-port ${this.config.lspPort} --path ${display(projectPath ?? "<GODOT_PROJECT_PATH>")}`;
    if (!this.config.lspAutoStart) throw new GodotMcpError("not_connected", "Godot language server is not reachable.", `Start it with: ${command}`);
    if (!godotPath) throw new Error("GODOT_PATH is required when GODOT_MCP_LSP_AUTO_START is enabled");
    if (!projectPath) throw new Error("GODOT_PROJECT_PATH is required when GODOT_MCP_LSP_AUTO_START is enabled");
    await this.deps.validatePaths(godotPath, projectPath);
    this.assertOpen();
    let child: HostChild | undefined;
    let failure: Error | undefined;
    const onStdout = (chunk: unknown) => { this.stdout = append(this.stdout, chunk); };
    const onStderr = (chunk: unknown) => { this.stderr = append(this.stderr, chunk); };
    const onError = (error: Error) => { failure = error; };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => { failure ??= new Error(`Godot LSP host exited before startup (code ${String(code)}, signal ${String(signal)})`); };
    const detach = () => {
      if (!child) return;
      child.off("error", onError); child.off("exit", onExit);
      child.stdout?.off("data", onStdout); child.stderr?.off("data", onStderr);
    };
    try {
      child = this.deps.spawn(godotPath, ["--editor", "--headless", "--lsp-port", String(this.config.lspPort), "--path", projectPath], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      this.ownedChild = child;
      this.assertOpen();
      child.stdout?.on("data", onStdout); child.stderr?.on("data", onStderr);
      child.once("error", onError); child.once("exit", onExit);
      // Each attempt can consume the 500 ms probe deadline plus the 50 ms interval.
      for (let elapsed = 0; elapsed < 15_000; elapsed += 550) {
        this.assertOpen();
        if (failure) {
          const external = await this.deps.probe("127.0.0.1", this.config.lspPort, 500);
          this.assertOpen();
          if (external) { detach(); this.ownedChild = undefined; return this.ownership = "attached"; }
          throw failure;
        }
        const reachable = await this.deps.probe("127.0.0.1", this.config.lspPort, 500);
        this.assertOpen();
        if (failure) {
          const external = await this.deps.probe("127.0.0.1", this.config.lspPort, 500);
          this.assertOpen();
          if (external) { detach(); this.ownedChild = undefined; return this.ownership = "attached"; }
          throw failure;
        }
        if (reachable) {
          detach();
          this.installOwnedListeners(child, onStdout, onStderr);
          return this.ownership = "owned";
        }
        await this.deps.delay(50);
      }
      throw new GodotMcpError("timeout", "Godot language server did not start within 15 seconds.", "Check the captured host diagnostics and Godot project path.", this.diagnostics());
    } catch (error) {
      detach();
      if (child && this.ownedChild === child) {
        this.ownedChild = undefined;
        try { await this.deps.terminate(child); } catch { /* preserve the startup/closing error */ }
      }
      throw error;
    }
  }

  private async performClose(): Promise<void> {
    try { await this.ensuring; } catch { /* cleanup continues */ }
    const child = this.ownedChild; this.ownedChild = undefined;
    try { if (child) await this.deps.terminate(child); }
    finally {
      const listeners = this.ownedListeners;
      if (listeners && listeners.child === child) { listeners.detach(); this.ownedListeners = undefined; }
      this.ownership = undefined; this.state = "closed";
    }
  }

  private installOwnedListeners(child: HostChild, onStdout: (chunk: unknown) => void, onStderr: (chunk: unknown) => void): void {
    this.ownedListeners?.detach();
    const onExit = () => {
      if (this.ownedChild === child) { this.ownedChild = undefined; this.ownership = undefined; }
      detach();
      if (this.ownedListeners?.child === child) this.ownedListeners = undefined;
    };
    const detach = () => {
      child.off("exit", onExit);
      child.stdout?.off("data", onStdout); child.stderr?.off("data", onStderr);
    };
    child.stdout?.on("data", onStdout); child.stderr?.on("data", onStderr);
    child.once("exit", onExit);
    this.ownedListeners = { child, detach };
  }

  private assertOpen(): void { if (this.state !== "open") throw this.closedError(); }
  private closedError(): GodotMcpError { return new GodotMcpError("not_connected", "Godot language server host is closing or closed.", "Create a new LSP host before reconnecting."); }
}
