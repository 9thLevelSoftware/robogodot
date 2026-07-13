import { link, lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { Socket } from "node:net";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
import type { BridgeLaunchConfig } from "./bootstrap.js";
import { encodeFrame, FrameDecoder, MAX_JSON_BYTES, plainJson } from "./bridge-protocol.js";

type Transport = "socket" | "file";
interface SecretConfig { sessionId: string; token: string; protocolVersion: number; preferredPort: number }
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; sessionId: string }

export class RuntimeBridgeClient {
  private transport: Transport | undefined; private socket: Socket | undefined; private secret: SecretConfig | undefined; private config: BridgeLaunchConfig | undefined;
  private nextId = 1; private exhausted = false; private connectPromise: Promise<Transport> | undefined; private published = false; private closed = false; private filePending = 0; private readonly pending = new Map<number, Pending>(); private decoder = new FrameDecoder();
  constructor(private readonly options: { handshakeTimeoutMs?: number } = {}) {}

  async connect(config: BridgeLaunchConfig): Promise<Transport> {
    if (this.transport) return this.transport; if (this.connectPromise) return this.connectPromise; if (this.closed) throw new Error("Runtime bridge is closed.");
    this.connectPromise = this.connectOnce(config); return this.connectPromise;
  }

  private async connectOnce(config: BridgeLaunchConfig): Promise<Transport> {
    const path = config.args[4]; if (!path) throw new Error("Runtime bridge config path is missing.");
    const raw = await readFile(path); if (raw.length > 32_768) throw new Error("Runtime bridge config exceeds bound.");
    const value = JSON.parse(raw.toString("utf8")) as SecretConfig; validateSecret(value, config.sessionId); this.secret = value; this.config = config;
    try { await this.connectSocket(value); this.transport = "socket"; }
    catch { this.socket?.destroy(); this.socket = undefined; this.decoder = new FrameDecoder(); if (this.published) throw new Error("Runtime bridge transport is locked."); this.transport = "file"; }
    return this.transport;
  }

  async request<T>(sessionId: string, method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (!this.transport || !this.secret || !this.config || this.closed) throw new Error("Runtime bridge is not connected or closed.");
    if (sessionId !== this.secret.sessionId) throw new Error("Runtime bridge session mismatch.");
    if (!method.startsWith("runtime.") || Buffer.byteLength(method) > 128) throw new Error("Invalid runtime bridge method.");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error("Invalid runtime bridge deadline.");
    if (this.pending.size + this.filePending >= 32) throw new Error("Runtime bridge pending request limit reached.");
    const normalizedParams = plainJson(params);
    if (this.exhausted || !Number.isSafeInteger(this.nextId)) throw new Error("Runtime bridge request ID exhausted.");
    const id = this.nextId; if (id === Number.MAX_SAFE_INTEGER) this.exhausted = true; else this.nextId++;
    const request = plainJson({ type: "request", version: this.secret.protocolVersion, sessionId, token: this.secret.token, id, method, params: normalizedParams }) as Record<string, unknown>;
    const bytes = Buffer.from(JSON.stringify(request)); if (bytes.length > MAX_JSON_BYTES) throw new Error("Runtime bridge request exceeds bound.");
    this.published = true;
    if (this.transport === "file") { this.filePending++; try { return await this.fileRequest<T>(id, request, Date.now() + timeoutMs); } finally { this.filePending--; } }
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Runtime bridge request deadline exceeded.")); }, timeoutMs);
      this.pending.set(id, { resolve: value => resolve(plainJson(value) as T), reject, timer, sessionId });
      this.socket!.write(encodeFrame(request), error => { if (error) this.rejectOne(id, new Error("Runtime bridge socket publication failed.")); });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return; this.closed = true; this.socket?.destroy(); this.socket = undefined;
    for (const [id] of this.pending) this.rejectOne(id, new Error("Runtime bridge closed.")); this.secret = undefined;
  }

  private async connectSocket(secret: SecretConfig): Promise<void> {
    const socket = new Socket(); this.socket = socket; const deadline = Date.now() + (this.options.handshakeTimeoutMs ?? 3000); const clientNonce = randomBytes(32).toString("hex");
    await new Promise<void>((resolve, reject) => {
      let settled = false; const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); socket.removeListener("error", fail); socket.removeListener("close", closed); socket.removeListener("data", data); error ? reject(error) : resolve(); };
      const fail = () => finish(new Error("Runtime bridge socket handshake failed.")); const closed = () => finish(new Error("Runtime bridge socket closed during handshake."));
      const timer = setTimeout(() => finish(new Error("Runtime bridge handshake deadline exceeded.")), Math.max(1, deadline - Date.now()));
      const data = (chunk: Buffer) => { try { for (const raw of this.decoder.push(Buffer.from(chunk))) { const value = raw as Record<string, unknown>; const serverNonce = value.serverNonce; const serverProof = value.serverProof; if (value.type !== "hello_ack" || value.version !== secret.protocolVersion || value.sessionId !== secret.sessionId || value.clientNonce !== clientNonce || typeof serverNonce !== "string" || !/^[a-f0-9]{64}$/.test(serverNonce) || typeof serverProof !== "string" || !fixedProof(serverProof, proof(secret.token, "robogodot-server-v1", secret.sessionId, secret.protocolVersion, clientNonce, serverNonce))) throw new Error("Invalid runtime bridge mutual proof."); socket.write(encodeFrame({ type: "hello_confirm", version: secret.protocolVersion, sessionId: secret.sessionId, clientNonce, serverNonce, confirmation: proof(secret.token, "robogodot-confirm-v1", secret.sessionId, secret.protocolVersion, clientNonce, serverNonce) }), error => finish(error ? new Error("Runtime bridge confirmation failed.") : undefined)); } } catch (e) { finish(e as Error); } };
      socket.once("error", fail); socket.once("close", closed); socket.on("data", data); socket.connect(secret.preferredPort, "127.0.0.1", () => socket.write(encodeFrame({ type: "hello", version: secret.protocolVersion, sessionId: secret.sessionId, clientNonce, clientProof: proof(secret.token, "robogodot-client-v1", secret.sessionId, secret.protocolVersion, clientNonce) })));
    });
    socket.removeAllListeners(); socket.setTimeout(0); socket.on("data", data => this.onData(Buffer.from(data))); socket.on("error", () => void this.close());
    socket.on("close", () => { for (const [id] of this.pending) this.rejectOne(id, new Error("Runtime bridge closed.")); });
  }
  private onData(data: Buffer) { try { for (const value of this.decoder.push(data)) this.onMessage(value); } catch { void this.close(); } }
  private onMessage(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return; const r = value as Record<string, unknown>;
    const secret = this.secret; if (!secret || r.type !== "response" || !Number.isSafeInteger(r.id) || r.version !== secret.protocolVersion || r.sessionId !== secret.sessionId) return;
    const id = r.id as number; const pending = this.pending.get(id); if (!pending) return; clearTimeout(pending.timer); this.pending.delete(id);
    if (typeof r.error === "string") pending.reject(new Error(r.error)); else { try { pending.resolve(r.result); } catch (e) { pending.reject(e as Error); } }
  }
  private rejectOne(id: number, error: Error) { const p = this.pending.get(id); if (!p) return; clearTimeout(p.timer); this.pending.delete(id); p.reject(error); }
  private async fileRequest<T>(id: number, request: object, deadline: number): Promise<T> {
    const root = await this.canonicalFileRoot(); const final = join(root, `req-${id}.json`); const temp = join(root, `.req-${id}-${randomBytes(16).toString("hex")}.tmp`); const response = join(root, `resp-${id}.json`);
    const body = JSON.stringify(request); let handle;
    try {
      handle = await open(temp, "wx", 0o600); await handle.writeFile(body, "utf8"); await handle.sync(); await handle.close(); handle = undefined; await this.canonicalFileRoot(); await link(temp, final); await unlink(temp);
      let delay = 5;
      while (Date.now() < deadline) { if (this.closed) throw new Error("Runtime bridge closed."); await this.canonicalFileRoot(); const value = await readStableResponse(response); if (value) { if (value.type !== "response" || value.id !== id || value.version !== this.secret!.protocolVersion || value.sessionId !== this.secret!.sessionId) { await unlink(response).catch(() => {}); continue; } await unlink(response); if (typeof value.error === "string") throw new Error(value.error); return plainJson(value.result) as T; } await new Promise(r => setTimeout(r, Math.min(delay, Math.max(1, deadline - Date.now())))); delay = Math.min(50, delay * 2); }
      throw new Error("Runtime bridge request deadline exceeded.");
    } finally { if (handle) await handle.close().catch(() => {}); await unlink(temp).catch(() => {}); await unlink(final).catch(() => {}); await unlink(response).catch(() => {}); }
  }

  private async canonicalFileRoot(): Promise<string> {
    const config = this.config!; const expected = resolve(config.userRoot, ".mcp", config.sessionId); if (resolve(config.sessionRoot) !== expected) throw new Error("Runtime bridge file root containment failed.");
    for (const path of [config.userRoot, resolve(config.userRoot, ".mcp"), config.sessionRoot]) { const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== resolve(path)) throw new Error("Runtime bridge file root identity changed."); }
    return expected;
  }
}

function proof(token: string, label: string, session: string, version: number, ...nonces: string[]) { return createHmac("sha256", token).update([label, session, String(version), ...nonces].join("\0")).digest("hex"); }
function fixedProof(actual: string, expected: string) { if (!/^[a-f0-9]{64}$/.test(actual)) return false; return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex")); }

async function readStableResponse(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const before = await lstat(path); if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > MAX_JSON_BYTES || await realpath(path) !== resolve(path)) return undefined;
    const handle = await open(path, "r"); try { const opened = await handle.stat(); if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return undefined; const raw = Buffer.alloc(opened.size); const read = await handle.read(raw, 0, raw.length, 0); const after = await handle.stat(); if (read.bytesRead !== raw.length || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) return undefined; try { const value = JSON.parse(raw.toString("utf8")); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; } catch { return undefined; } } finally { await handle.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function validateSecret(value: SecretConfig, sessionId: string) {
  if (!value || value.sessionId !== sessionId || !/^[a-f0-9]{32}$/.test(value.sessionId) || typeof value.token !== "string" || Buffer.byteLength(value.token) < 32 || Buffer.byteLength(value.token) > 256 || value.protocolVersion !== 1 || !Number.isInteger(value.preferredPort) || value.preferredPort < 1 || value.preferredPort > 65535) throw new Error("Invalid runtime bridge config.");
}
