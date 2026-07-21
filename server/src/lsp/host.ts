import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { connect } from "node:net";
import { GodotMcpError } from "../errors.js";

export type LspOwnership = "attached" | "owned";
type HostChild = Pick<ChildProcess, "on" | "once" | "off" | "kill" | "stdout" | "stderr" | "pid">;
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

type TaskkillChild = Pick<ChildProcess, "once" | "off" | "kill">;
export function terminateWindowsProcessTree(pid: number, timeoutMs = 2_000, spawnTaskkill: (command: string, args: string[], options: { windowsHide: true }) => TaskkillChild = (command, args, options) => nodeSpawn(command, args, options)): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: TaskkillChild;
    try { child = spawnTaskkill("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true }); }
    catch (error) { reject(error); return; }
    let settled = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; if (timer) clearTimeout(timer); child.off("error", onError); child.off("exit", onExit);
      error ? reject(error) : resolve();
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null) => finish(code === 0 ? undefined : new Error(`taskkill exited with code ${code ?? "unknown"} for PID ${pid}.`));
    child.once("error", onError); child.once("exit", onExit);
    if (!settled) timer = setTimeout(() => { try { child.kill(); } catch { /* cleanup best effort */ } finish(new Error(`taskkill timed out after ${timeoutMs} ms for PID ${pid}.`)); }, timeoutMs);
  });
}

async function probe(host: "127.0.0.1", port: number, deadlineMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, host);
    let done = false;
    const finish = (answer: boolean) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(answer); };
    const timer = setTimeout(() => finish(false), deadlineMs);
    socket.once("connect", () => finish(true)); socket.once("error", () => finish(false));
  });
}

function editorRequired(message: string, hint: string): never {
  throw new GodotMcpError("editor_required", message, hint);
}

async function validatePaths(godotPath: string, projectPath: string): Promise<void> {
  const projectFile = path.join(projectPath, "project.godot");
  let executable;
  try { executable = await stat(godotPath); }
  catch {
    editorRequired("GODOT_PATH is not a usable Godot executable file.", `Set GODOT_PATH to a Godot binary file (received ${godotPath}).`);
  }
  if (!executable.isFile()) {
    editorRequired("GODOT_PATH is not a usable Godot executable file.", `Set GODOT_PATH to a Godot binary file (received ${godotPath}).`);
  }
  let project;
  try { project = await stat(projectPath); }
  catch {
    editorRequired("GODOT_PROJECT_PATH is not a directory.", `Set GODOT_PROJECT_PATH to the project root directory (received ${projectPath}).`);
  }
  if (!project.isDirectory()) {
    editorRequired("GODOT_PROJECT_PATH is not a directory.", `Set GODOT_PROJECT_PATH to the project root directory (received ${projectPath}).`);
  }
  let marker;
  try { marker = await stat(projectFile); }
  catch {
    editorRequired(
      "GODOT_PROJECT_PATH must contain a regular project.godot.",
      `Point GODOT_PROJECT_PATH at a Godot project root that contains project.godot (expected ${projectFile}).`,
    );
  }
  if (!marker.isFile()) {
    editorRequired(
      "GODOT_PROJECT_PATH must contain a regular project.godot.",
      `Point GODOT_PROJECT_PATH at a Godot project root that contains project.godot (expected ${projectFile}).`,
    );
  }
  if (process.platform !== "win32") {
    try { await access(godotPath, constants.X_OK); }
    catch {
      editorRequired("GODOT_PATH is not an executable file.", `Ensure the Godot binary at ${godotPath} is executable.`);
    }
  }
}

async function terminate(child: HostChild): Promise<void> {
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
  const onExit = () => resolveExit();
  child.once("exit", onExit);
  try {
    child.kill("SIGTERM");
    if (await Promise.race([exited.then(() => true), delay(5_000).then(() => false)])) return;
    if (process.platform === "win32" && child.pid !== undefined) {
      await terminateWindowsProcessTree(child.pid);
    } else child.kill("SIGKILL");
    await Promise.race([exited, delay(2_000)]);
  } finally { child.off("exit", onExit); }
}

function display(value: string): string { return `"${value.replaceAll('"', '\\"').replaceAll("\r", "\\r").replaceAll("\n", "\\n")}"`; }

export class LspHost {
  ownership: LspOwnership | undefined;
  private ownedChild: HostChild | undefined;
  private stdout: Buffer = Buffer.alloc(0);
  private stderr: Buffer = Buffer.alloc(0);
  private ensuring: Promise<LspOwnership> | undefined;
  private closing: Promise<void> | undefined;
  private state: "open" | "closing" | "closed" = "open";
  private ownedListeners: { child: HostChild; detach: () => void; failure?: Error } | undefined;
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
    if (this.ownership === "owned") return Promise.resolve(this.ownership);
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
    if (this.ownership === "attached") this.ownership = undefined;
    const godotPath = this.config.godotPath;
    const projectPath = this.config.projectPath;
    const command = `${display(godotPath ?? "<GODOT_PATH>")} --editor --headless --lsp-port ${this.config.lspPort} --path ${display(projectPath ?? "<GODOT_PROJECT_PATH>")}`;
    if (!this.config.lspAutoStart) throw new GodotMcpError("not_connected", "Godot language server is not reachable.", `Start it with: ${command}`);
    if (!godotPath) {
      editorRequired(
        "Automatic LSP hosting requires GODOT_PATH.",
        "Set GODOT_PATH to a usable Godot executable, or open the project in Godot so its language server is already listening.",
      );
    }
    if (!projectPath) {
      editorRequired(
        "Automatic LSP hosting requires GODOT_PROJECT_PATH.",
        "Set GODOT_PROJECT_PATH to a directory containing project.godot, or open that project in Godot so its language server is already listening.",
      );
    }
    try {
      await this.deps.validatePaths(godotPath, projectPath);
    } catch (error) {
      if (error instanceof GodotMcpError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      editorRequired(
        "Automatic LSP hosting requires a usable Godot executable and project directory.",
        `${detail} Set GODOT_PATH and GODOT_PROJECT_PATH, or attach to an already running editor language server.`,
      );
    }
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
      // Thirty condition-driven attempts span at least 15 seconds even when connection refusal is immediate.
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
          this.installOwnedListeners(child, onStdout, onStderr);
          detach();
          if (failure || this.ownedChild !== child || this.ownedListeners?.child !== child) {
            const external = await this.deps.probe("127.0.0.1", this.config.lspPort, 500);
            this.assertOpen();
            if (external) { this.ownedChild = undefined; return this.ownership = "attached"; }
            throw failure ?? new Error("Godot LSP host exited during startup handoff.");
          }
          return this.ownership = "owned";
        }
        await this.deps.delay(500);
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
    const listeners = this.ownedListeners;
    let terminateError: unknown;
    try { if (child) await this.deps.terminate(child); }
    catch (error) { terminateError = error; }
    finally {
      if (listeners && listeners.child === child) { listeners.detach(); this.ownedListeners = undefined; }
      this.ownership = undefined; this.state = "closed";
    }
    if (listeners?.failure) throw listeners.failure;
    if (terminateError !== undefined) throw terminateError;
  }

  private installOwnedListeners(child: HostChild, onStdout: (chunk: unknown) => void, onStderr: (chunk: unknown) => void): void {
    this.ownedListeners?.detach();
    let lifetime!: { child: HostChild; detach: () => void; failure?: Error };
    const onError = (error: Error) => {
      lifetime.failure ??= error;
      this.stderr = append(this.stderr, error.message);
    };
    const onExit = () => {
      if (this.ownedChild === child) { this.ownedChild = undefined; this.ownership = undefined; }
      detach();
      if (this.ownedListeners?.child === child) this.ownedListeners = undefined;
    };
    const detach = () => {
      child.off("error", onError); child.off("exit", onExit);
      child.stdout?.off("data", onStdout); child.stderr?.off("data", onStderr);
    };
    child.stdout?.on("data", onStdout); child.stderr?.on("data", onStderr);
    child.on("error", onError); child.once("exit", onExit);
    lifetime = { child, detach };
    this.ownedListeners = lifetime;
  }

  private assertOpen(): void { if (this.state !== "open") throw this.closedError(); }
  private closedError(): GodotMcpError { return new GodotMcpError("not_connected", "Godot language server host is closing or closed.", "Create a new LSP host before reconnecting."); }
}
