import { lstat, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const MANIFEST_VERSION = 1;
const LAUNCHER_RESOURCE = "res://addons/godot_control_mcp/runtime/runtime_launcher.gd";
const BRIDGE_RESOURCE = "res://addons/godot_control_mcp/runtime/bridge_manifest.gd";
const SESSION_PATTERN = /^[a-f0-9]{32}$/;

export interface RuntimePrepareOptions {
  sessionId: string;
  token: string;
  protocolVersion: number;
  preferredPort: number;
  scene: string;
}

export interface BridgeLaunchConfig {
  readonly sessionId: string;
  readonly userRoot: string;
  readonly sessionRoot: string;
  readonly manifestVersion: number;
  readonly launcherResource: typeof LAUNCHER_RESOURCE;
  readonly bridgeResource: typeof BRIDGE_RESOURCE;
  readonly args: readonly string[];
}

interface PrepareResponse { userRoot: string; sessionRoot: string; manifestVersion: number; launcherPath: string; bridgePath: string }
interface Dependencies { writeConfig(path: string, contents: string): Promise<void> }
interface BootstrapBridge { call<T>(method: string, params?: unknown, options?: { timeoutMs?: number; maxRequestBytes?: number }): Promise<T> }

export class RuntimeBootstrap {
  private readonly writeConfig: Dependencies["writeConfig"];
  constructor(private readonly bridge: BootstrapBridge, dependencies: Partial<Dependencies> = {}) {
    this.writeConfig = dependencies.writeConfig ?? ((path, contents) => writeFile(path, contents, { encoding: "utf8", flag: "wx", mode: 0o600 }));
  }

  async prepare(options: RuntimePrepareOptions): Promise<BridgeLaunchConfig> {
    validateRequest(options);
    const raw = await this.bridge.call<unknown>("runtime.prepare", { ...options }, { timeoutMs: 15_000, maxRequestBytes: 32_768 });
    try {
      const response = parseResponse(raw);
      if (response.manifestVersion !== MANIFEST_VERSION) throw new Error("Runtime bridge manifest version mismatch.");
      await verifyResource(response.launcherPath, join("addons", "godot_control_mcp", "runtime", "runtime_launcher.gd"), "launcher");
      await verifyResource(response.bridgePath, join("addons", "godot_control_mcp", "runtime", "bridge_manifest.gd"), "bridge manifest");
      const canonical = await canonicalSession(response, options.sessionId);
      const configPath = join(canonical.sessionRoot, `bridge-config-v${MANIFEST_VERSION}.json`);
      const contents = JSON.stringify({ version: MANIFEST_VERSION, sessionId: options.sessionId, token: options.token, protocolVersion: options.protocolVersion, preferredPort: options.preferredPort, scene: options.scene, launcherResource: LAUNCHER_RESOURCE, bridgeResource: BRIDGE_RESOURCE });
      await this.writeConfig(configPath, contents);
      return Object.freeze({ sessionId: options.sessionId, userRoot: canonical.userRoot, sessionRoot: canonical.sessionRoot, manifestVersion: MANIFEST_VERSION, launcherResource: LAUNCHER_RESOURCE, bridgeResource: BRIDGE_RESOURCE, args: Object.freeze(["--script", LAUNCHER_RESOURCE, "--", "--mcp-runtime-config", configPath]) });
    } catch (error) {
      await cleanupReturnedSession(raw, options.sessionId);
      throw error;
    }
  }

  async cleanup(config: BridgeLaunchConfig): Promise<void> {
    if (!SESSION_PATTERN.test(config.sessionId)) throw new Error("Invalid runtime session cleanup request.");
    const approved = resolve(config.userRoot, ".mcp");
    const exact = resolve(approved, config.sessionId);
    if (resolve(config.sessionRoot) !== exact || !contained(approved, exact)) throw new Error("Runtime cleanup containment check failed.");
    let stat;
    try { stat = await lstat(exact); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(exact) !== exact) throw new Error("Runtime cleanup denied a symbolic or non-canonical session directory.");
    await rm(exact, { recursive: true, force: true });
  }
}

function validateRequest(value: RuntimePrepareOptions): void {
  if (!SESSION_PATTERN.test(value.sessionId)) throw new Error("Runtime session ID must be 32 lowercase hexadecimal bytes.");
  const tokenBytes = Buffer.byteLength(value.token, "utf8");
  if (tokenBytes < 32 || tokenBytes > 256) throw new Error("Runtime token must contain between 32 and 256 UTF-8 bytes.");
  if (value.protocolVersion !== MANIFEST_VERSION) throw new Error("Unsupported runtime protocol version.");
  if (!Number.isInteger(value.preferredPort) || value.preferredPort < 1 || value.preferredPort > 65_535) throw new Error("Invalid runtime bridge port.");
  if (!value.scene.startsWith("res://") || value.scene.includes("\\") || value.scene.split("/").some(part => part === ".." || part === ".")) throw new Error("Invalid runtime scene resource path.");
}

function parseResponse(value: unknown): PrepareResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid runtime.prepare response.");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["bridgePath", "launcherPath", "manifestVersion", "sessionRoot", "userRoot"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error("Invalid runtime.prepare response fields.");
  if (typeof record.userRoot !== "string" || typeof record.sessionRoot !== "string" || typeof record.launcherPath !== "string" || typeof record.bridgePath !== "string" || !Number.isInteger(record.manifestVersion)) throw new Error("Invalid runtime.prepare response values.");
  if (![record.userRoot, record.sessionRoot, record.launcherPath, record.bridgePath].every(isAbsolute)) throw new Error("Invalid runtime.prepare response paths.");
  return record as unknown as PrepareResponse;
}

async function canonicalSession(response: PrepareResponse, sessionId: string): Promise<{ userRoot: string; sessionRoot: string }> {
  const sessionStat = await lstat(response.sessionRoot);
  if (!sessionStat.isDirectory() || sessionStat.isSymbolicLink()) throw new Error("Runtime session directory may not be symbolic.");
  const userRoot = await realpath(response.userRoot);
  const approvedRoot = await realpath(join(userRoot, ".mcp"));
  const sessionRoot = await realpath(response.sessionRoot);
  const exact = join(approvedRoot, sessionId);
  if (sessionRoot !== exact || !contained(approvedRoot, sessionRoot)) throw new Error("Runtime session canonical containment check failed.");
  return { userRoot, sessionRoot };
}

function contained(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

async function verifyResource(path: string, suffix: string, label: string): Promise<void> {
  const stat = await lstat(path);
  const canonical = await realpath(path);
  if (!stat.isFile() || stat.isSymbolicLink() || canonical !== resolve(path) || !canonical.endsWith(`${sep}${suffix}`)) throw new Error(`Runtime ${label} resource path is not verified.`);
}

async function cleanupReturnedSession(value: unknown, sessionId: string): Promise<void> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (typeof record.userRoot !== "string" || typeof record.sessionRoot !== "string") return;
  try {
    const canonical = await canonicalSession({ userRoot: record.userRoot, sessionRoot: record.sessionRoot, manifestVersion: 0, launcherPath: "", bridgePath: "" }, sessionId);
    await rm(canonical.sessionRoot, { recursive: true, force: true });
  } catch { /* never broaden cleanup beyond a proven exact canonical session */ }
}
