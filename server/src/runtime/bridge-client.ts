import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { join } from "node:path";
import type { BridgeLaunchConfig } from "./bootstrap.js";
import { encodeFrame, FrameDecoder, MAX_JSON_BYTES, plainJson } from "./bridge-protocol.js";

type Transport = "socket" | "file";
interface SecretConfig { sessionId: string; token: string; protocolVersion: number; preferredPort: number }
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; sessionId: string }

export class RuntimeBridgeClient {
  private transport: Transport | undefined; private socket: Socket | undefined; private secret: SecretConfig | undefined; private config: BridgeLaunchConfig | undefined;
  private nextId = 1; private published = false; private closed = false; private filePending = 0; private readonly pending = new Map<number, Pending>(); private decoder = new FrameDecoder();

  async connect(config: BridgeLaunchConfig): Promise<Transport> {
    if (this.transport) return this.transport; if (this.closed) throw new Error("Runtime bridge is closed.");
    const path = config.args[4]; if (!path) throw new Error("Runtime bridge config path is missing.");
    const raw = await readFile(path); if (raw.length > 32_768) throw new Error("Runtime bridge config exceeds bound.");
    const value = JSON.parse(raw.toString("utf8")) as SecretConfig; validateSecret(value, config.sessionId); this.secret = value; this.config = config;
    try { await this.connectSocket(value); this.transport = "socket"; }
    catch { if (this.published) throw new Error("Runtime bridge transport is locked."); this.transport = "file"; }
    return this.transport;
  }

  async request<T>(sessionId: string, method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (!this.transport || !this.secret || !this.config || this.closed) throw new Error("Runtime bridge is not connected or closed.");
    if (sessionId !== this.secret.sessionId) throw new Error("Runtime bridge session mismatch.");
    if (!method.startsWith("runtime.") || Buffer.byteLength(method) > 128) throw new Error("Invalid runtime bridge method.");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error("Invalid runtime bridge deadline.");
    if (this.pending.size + this.filePending >= 32) throw new Error("Runtime bridge pending request limit reached.");
    if (!Number.isSafeInteger(this.nextId)) throw new Error("Runtime bridge request ID exhausted.");
    const id = this.nextId++; const request = { type: "request", version: this.secret.protocolVersion, sessionId, token: this.secret.token, id, method, params };
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
    const socket = new Socket(); this.socket = socket; const deadline = Date.now() + 3000;
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); socket.setTimeout(Math.max(1, deadline - Date.now()), () => reject(new Error("handshake deadline"))); socket.connect(secret.preferredPort, "127.0.0.1"); });
    socket.removeAllListeners(); socket.setTimeout(0); const decoder = this.decoder;
    const ack = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("handshake deadline")), Math.max(1, deadline - Date.now()));
      const first = (chunk: Buffer) => { try { const values = decoder.push(Buffer.from(chunk)); const value = values.shift() as Record<string, unknown> | undefined; if (!value || value.type !== "hello_ack" || value.version !== secret.protocolVersion || value.sessionId !== secret.sessionId) throw new Error("invalid handshake"); clearTimeout(timer); socket.off("data", first); for (const item of values) this.onMessage(item); socket.on("data", data => this.onData(Buffer.from(data))); resolve(); } catch (e) { clearTimeout(timer); reject(e); } }; socket.on("data", first); socket.once("error", reject); socket.once("close", () => reject(new Error("closed during handshake")));
    });
    socket.write(encodeFrame({ type: "hello", version: secret.protocolVersion, sessionId: secret.sessionId, token: secret.token })); await ack;
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
    const root = this.config!.sessionRoot; const final = join(root, `req-${id}.json`); const temp = join(root, `.req-${id}-${process.pid}.tmp`); const response = join(root, `resp-${id}.json`);
    await writeFile(temp, JSON.stringify(request), { flag: "wx", mode: 0o600 }); await rename(temp, final); let delay = 5;
    while (Date.now() < deadline) { if (this.closed) throw new Error("Runtime bridge closed."); try { const raw = await readFile(response); if (raw.length > MAX_JSON_BYTES) throw new Error("Runtime bridge response exceeds bound."); const value = JSON.parse(raw.toString("utf8")) as Record<string, unknown>; await unlink(response); if (value.type !== "response" || value.id !== id || value.version !== this.secret!.protocolVersion || value.sessionId !== this.secret!.sessionId) continue; if (typeof value.error === "string") throw new Error(value.error); return plainJson(value.result) as T; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } await new Promise(r => setTimeout(r, Math.min(delay, Math.max(1, deadline - Date.now())))); delay = Math.min(50, delay * 2); }
    throw new Error("Runtime bridge request deadline exceeded.");
  }
}

function validateSecret(value: SecretConfig, sessionId: string) {
  if (!value || value.sessionId !== sessionId || !/^[a-f0-9]{32}$/.test(value.sessionId) || typeof value.token !== "string" || Buffer.byteLength(value.token) < 32 || Buffer.byteLength(value.token) > 256 || value.protocolVersion !== 1 || !Number.isInteger(value.preferredPort) || value.preferredPort < 1 || value.preferredPort > 65535) throw new Error("Invalid runtime bridge config.");
}
